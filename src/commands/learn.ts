import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { getForge } from '../forge/index.js';
import { getProvider } from '../providers/index.js';
import { getDb, initDb } from '../db.js';

const GENERATED_START = '<!-- lens:generated:start -->';
const GENERATED_END = '<!-- lens:generated:end -->';

export interface LearnOpts {
  maxPRs?: number;
  useAI?: boolean;
  dryRun?: boolean;
  providerOverride?: string;
}

export async function runLearn(cfg: Config, opts: LearnOpts = {}): Promise<void> {
  const db = getDb();
  const forge = getForge(cfg);
  const maxPRs = opts.maxPRs ?? (cfg as any).learn?.maxPRs ?? 50;
  const useAI = opts.useAI ?? (cfg as any).learn?.useAI ?? true;

  console.log(`Mining last ${maxPRs} merged PRs for team patterns...`);
  const mergedPRs = await forge.getMergedPRs(maxPRs);
  console.log(`  Found ${mergedPRs.length} merged PRs`);

  // fetch review comments for each PR (concurrency 5)
  const allComments: Array<{ author: string; file: string; body: string; ext: string }> = [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO reviewer_comment (forge, workspace, repo, pr_number, pr_title, author, file, line, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const chunks: typeof mergedPRs[] = [];
  for (let i = 0; i < mergedPRs.length; i += 5) chunks.push(mergedPRs.slice(i, i + 5));

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (pr) => {
      try {
        const comments = await forge.getReviewComments(pr.ref);
        for (const c of comments) {
          if (!c.body.trim()) continue;
          insert.run(pr.ref.forge, pr.ref.owner, pr.ref.repo, pr.ref.number, pr.title, c.author, c.file, c.line, c.body);
          const ext = path.extname(c.file).replace('.', '') || 'other';
          allComments.push({ author: c.author, file: c.file, body: c.body, ext });
        }
      } catch { /* skip failed PRs */ }
    }));
    process.stdout.write('.');
  }
  console.log(`\n  Stored ${allComments.length} review comments`);

  // update reviewer profiles from eval data
  updateReviewerProfiles(db);

  // cluster patterns by extension
  const byExt = groupBy(allComments, (c) => c.ext);
  const patterns: Array<{ ext: string; rules: string[] }> = [];

  for (const [ext, comments] of Object.entries(byExt)) {
    if (comments.length < 3) continue;
    let rules: string[] = [];

    if (useAI && comments.length >= 5) {
      try {
        const provider = getProvider(cfg, opts.providerOverride);
        rules = await clusterWithAI(provider, ext, comments.map((c) => c.body));
      } catch { rules = frequencyCluster(comments.map((c) => c.body)); }
    } else {
      rules = frequencyCluster(comments.map((c) => c.body));
    }

    if (rules.length > 0) patterns.push({ ext, rules });
  }

  // build skills.md content
  const generated = buildSkillsContent(patterns);
  console.log('\nGenerated team patterns:');
  console.log(generated);

  if (opts.dryRun) {
    console.log('\n[dry-run] Would write to .lens/skills.md — skipping.');
    return;
  }

  // write to .lens/skills.md in cwd
  const skillsDir = path.join(process.cwd(), '.lens');
  const skillsPath = path.join(skillsDir, 'skills.md');
  fs.mkdirSync(skillsDir, { recursive: true });
  writeSkillsFile(skillsPath, generated);
  console.log(`\n✓ Written to ${skillsPath}`);
}

function updateReviewerProfiles(db: ReturnType<typeof getDb>): void {
  const rows = db.prepare(`
    SELECT reviewer, COUNT(*) as total,
           SUM(CASE WHEN action IN ('kept','edited') THEN 1 ELSE 0 END) as accepted
    FROM comment_draft
    WHERE reviewer IS NOT NULL
    GROUP BY reviewer
  `).all() as Array<{ reviewer: string; total: number; accepted: number }>;

  const upsert = db.prepare(`
    INSERT INTO reviewer_profile (reviewer, acceptance_rate, total_accepted, total_seen, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(reviewer) DO UPDATE SET
      acceptance_rate=excluded.acceptance_rate,
      total_accepted=excluded.total_accepted,
      total_seen=excluded.total_seen,
      updated_at=excluded.updated_at
  `);

  for (const row of rows) {
    upsert.run(row.reviewer, row.total > 0 ? row.accepted / row.total : 0, row.accepted, row.total);
  }
}

async function clusterWithAI(provider: any, ext: string, bodies: string[]): Promise<string[]> {
  const sample = bodies.slice(0, 30).join('\n---\n');
  const prompt = `Here are ${bodies.length} real code review comments left by engineers on ${ext} files:\n\n${sample}\n\nIdentify 5-8 recurring patterns as concise actionable rules a code reviewer should check. Focus on patterns that appear in multiple comments. Output JSON only:\n{"patterns": ["rule 1", "rule 2", ...]}`;

  // ReviewInput shape: prTitle, prDescription, diff, changedFiles (FileContext[]), skills, prompt
  const result = await provider.review(
    {
      prompt,
      diff: '',
      changedFiles: [],
      prTitle: '',
      prDescription: '',
      skills: '',
    },
    {},
  );
  const raw = result.rawResponse ?? '';
  const fence = raw.match(/```json\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  const parsed = JSON.parse(candidate.slice(start, end + 1));
  return Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, 8) : [];
}

function frequencyCluster(bodies: string[]): string[] {
  // extract top bigrams as a proxy for common patterns
  const freq = new Map<string, number>();
  const stopwords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','must','shall','to','of','in','for','on','with','at','by','from','this','that','these','those','it','its','or','and','but','not','no','if','as','so','than','then','when','where','which','who','what','how','we','you','your','our','their','use','using','used','can','make','need','should','also','just','here','there','all','any','some','more','most','other','only','new','add','added','missing','check','consider','please','instead','avoid']);

  for (const body of bodies) {
    const words = body.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i+1]}`;
      freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
    }
  }

  return Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([bigram]) => `Check for: ${bigram}`);
}

function buildSkillsContent(patterns: Array<{ ext: string; rules: string[] }>): string {
  if (patterns.length === 0) return '(No patterns extracted — not enough review history yet.)';
  const lines = [
    `# Team Review Patterns`,
    `<!-- auto-generated by lens learn on ${new Date().toISOString().split('T')[0]} -->`,
    '',
    '## [correctness]',
  ];
  for (const { ext, rules } of patterns) {
    lines.push(`### ${ext} files`);
    for (const rule of rules) lines.push(`- ${rule}`);
  }
  return lines.join('\n');
}

function writeSkillsFile(filePath: string, generated: string): void {
  const block = `${GENERATED_START}\n${generated}\n${GENERATED_END}`;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block + '\n');
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes(GENERATED_START)) {
    // replace between sentinels, preserve content outside
    const updated = existing.replace(
      new RegExp(`${GENERATED_START}[\\s\\S]*?${GENERATED_END}`),
      block,
    );
    fs.writeFileSync(filePath, updated);
  } else {
    // append generated block, preserve manual content
    fs.writeFileSync(filePath, existing.trimEnd() + '\n\n' + block + '\n');
  }
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}
