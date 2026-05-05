import type { Config } from '../config.js';
import { getForge } from '../forge/index.js';
import { idToRef, refToId } from '../forge/types.js';
import { getDb, initDb } from '../db.js';
import { getProvider } from '../providers/index.js';
import { loadSkills } from '../skills.js';
import { critique } from '../critic.js';
import { splitDiffByFile, annotateDiff } from '../diff_split.js';
import { triage, type TriageItem } from '../triage.js';
import { extractContext, buildContextBlock } from '../context.js';
import { detectRelevantLenses, formatLenses } from '../lens_detect.js';
import { estimateCost, fmtUsd } from '../pricing.js';
import type { UsageInfo } from '../providers/types.js';

class Logger {
  lines: string[] = [];
  constructor(private onLog?: (msg: string) => void) {}
  log(msg: string) {
    console.log(msg);
    const line = `[${new Date().toISOString().split('T')[1].split('.')[0]}] ${msg}`;
    this.lines.push(line);
    if (this.onLog) this.onLog(line);
  }
  getLogs() { return this.lines.join('\n'); }
}

export async function listPRs(cfg: Config) {
  const forge = getForge(cfg);
  const prs = await forge.listOpenPRs();
  const db = initDb();
  const upsert = db.prepare(`
    INSERT INTO pr (id, forge, workspace, repo, number, url, title, author, source_branch, dest_branch, state, updated_at)
    VALUES (@id, @forge, @ws, @repo, @num, @url, @title, @author, @src, @dst,
            COALESCE((SELECT state FROM pr WHERE id=@id),'NEW'), @updated)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, author=excluded.author, url=excluded.url,
      source_branch=excluded.source_branch, dest_branch=excluded.dest_branch,
      updated_at=excluded.updated_at
  `);
  for (const p of prs) {
    upsert.run({
      id: refToId(p.ref),
      forge: p.ref.forge,
      ws: p.ref.owner,
      repo: p.ref.repo,
      num: p.ref.number,
      url: p.url ?? null,
      title: p.title,
      author: p.author,
      src: p.sourceBranch,
      dst: p.destBranch,
      updated: p.updatedOn,
    });
  }
  console.log(`${prs.length} open PRs:`);
  for (const p of prs) {
    const branches = p.sourceBranch ? `  ${p.sourceBranch} → ${p.destBranch}` : '';
    console.log(`  ${refToId(p.ref).padEnd(40)}  ${p.title}  (${p.author})${branches}`);
  }
}

export type Effort = 'low' | 'medium' | 'high';

export interface AnalyzeOpts {
  providerOverride?: string;
  reAnalyze?: boolean;
  skipCritic?: boolean;
  skipTriage?: boolean;
  effort?: Effort;
  onLog?: (msg: string) => void;
  onTriage?: (items: TriageItem[]) => void;
}

interface StageModels { triage?: string; review?: string; critic?: string; }

const EFFORT_PRESETS: Record<Effort, StageModels> = {
  low:    { triage: 'claude-haiku-4-5-20251001', review: 'claude-haiku-4-5-20251001', critic: 'claude-haiku-4-5-20251001' },
  medium: { triage: 'claude-haiku-4-5-20251001', review: 'claude-sonnet-4-6',         critic: 'claude-sonnet-4-6' },
  high:   { triage: 'claude-sonnet-4-6',         review: 'claude-opus-4-7',           critic: 'claude-opus-4-7' },
};

function resolveModels(cfg: Config, effort?: Effort): StageModels {
  if (effort) return EFFORT_PRESETS[effort];
  return cfg.provider.models ?? {};
}

export async function analyzePR(cfg: Config, prId: string, opts: AnalyzeOpts = {}) {
  const logger = new Logger(opts.onLog);
  const forge = getForge(cfg);
  const ref = idToRef(prId);
  const provider = getProvider(cfg, opts.providerOverride);
  const db = getDb();

  const ok = await provider.isAvailable();
  if (!ok) throw new Error(`provider ${provider.name} not available on PATH`);

  const models = resolveModels(cfg, opts.effort);
  if (opts.effort) logger.log(`effort=${opts.effort} → triage=${models.triage} review=${models.review} critic=${models.critic}`);

  recordTransition(prId, 'ANALYZING');
  logger.log(`fetching diff and existing comments for ${prId}...`);
  const [diff, existingComments] = await Promise.all([
    forge.getDiff(ref),
    forge.getComments(ref),
  ]);
  if (existingComments.length) logger.log(`  → ${existingComments.length} existing inline comment(s) fetched`);
  const fileDiffs = splitDiffByFile(diff);
  const allFiles = fileDiffs.map((f) => f.path);

  const stageUsages: Array<{ stage: string; model?: string; usage?: UsageInfo; ms: number }> = [];

  let triageItems: TriageItem[];
  if (opts.skipTriage) {
    triageItems = fileDiffs.map((f) => ({ path: f.path, decision: 'deep', reason: 'triage skipped', source: 'heuristic' }));
    logger.log(`triage: skipped by user option`);
  } else if (opts.reAnalyze && (triageItems = loadCachedTriage(db, prId, fileDiffs)).length > 0) {
    logger.log(`triage: reusing cached decisions for ${triageItems.length} file(s) (skipped LLM call)`);
    if (opts.onTriage) opts.onTriage(triageItems);
    const counts = triageItems.reduce<Record<string, number>>((acc, t) => {
      acc[t.decision] = (acc[t.decision] ?? 0) + 1; return acc;
    }, {});
    logger.log(`  → deep:${counts.deep ?? 0}  shallow:${counts.shallow ?? 0}  skip:${counts.skip ?? 0}`);
  } else {
    logger.log(`triage: classifying ${fileDiffs.length} files...`);
    const tt0 = Date.now();
    const tres = await triage(provider, fileDiffs, models.triage);
    triageItems = tres.items;
    stageUsages.push({ stage: 'triage', model: models.triage, usage: tres.usage, ms: Date.now() - tt0 });
    if (opts.onTriage) opts.onTriage(triageItems);
    const counts = triageItems.reduce<Record<string, number>>((acc, t) => {
      acc[t.decision] = (acc[t.decision] ?? 0) + 1; return acc;
    }, {});
    logger.log(`  → deep:${counts.deep ?? 0}  shallow:${counts.shallow ?? 0}  skip:${counts.skip ?? 0}`);
    if (tres.usage) logger.log(`  triage tokens: ${tres.usage.tokens_in} in / ${tres.usage.tokens_out} out (${tres.usage.source})`);
  }

  const keepPaths = new Set(triageItems.filter((t) => t.decision !== 'skip').map((t) => t.path));
  const reviewableFiles = fileDiffs.filter((f) => keepPaths.has(f.path));
  const reviewableDiff = reviewableFiles.map((f) => annotateDiff(f.body)).join('');

  if (reviewableFiles.length === 0) {
    logger.log('All files triaged as skip. Nothing to review.');
    const aid = persistFreshAnalysis(db, prId, provider.name, { summary: 'No reviewable files (all triaged as skip).', comments: [], rawResponse: '' }, 0, logger.getLogs());
    persistTriage(db, aid, fileDiffs, triageItems);
    recordTransition(prId, 'DRAFT_READY');
    return;
  }

  const deepPaths = new Set(triageItems.filter((t) => t.decision === 'deep').map((t) => t.path));
  const contexts = reviewableFiles.filter((f) => deepPaths.has(f.path)).map(extractContext);
  const contextBlock = buildContextBlock(contexts);
  if (contextBlock) logger.log(`context: extracted symbols/imports for ${contexts.filter((c) => c.imports.length || c.symbols.length).length} deep files`);

  const lenses = detectRelevantLenses(reviewableDiff, contexts, allFiles);
  logger.log(`lenses: ${formatLenses(lenses)}`);

  const skills = loadSkills(allFiles, undefined, lenses);
  const reviewInput = {
    prTitle: '(see Bitbucket)',
    prDescription: triageContextForPrompt(triageItems),
    diff: reviewableDiff,
    changedFiles: reviewableFiles.map((f) => ({ path: f.path })),
    skills,
    contextBlock,
    prompt: '',
    lenses,
    existingComments,
  };

  logger.log(`pass 1: ${provider.name} candidate review on ${reviewableFiles.length} files...`);
  const t0 = Date.now();
  let candidate;
  const reviewT0 = Date.now();
  try {
    candidate = await provider.review(reviewInput, { model: models.review });
  } catch (err: any) {
    db.prepare(
      `INSERT INTO usage_log (provider, pr_id, ok, ms_elapsed, stage, model, error) VALUES (?,?,0,?,?,?,?)`,
    ).run(provider.name, prId, Date.now() - reviewT0, 'review', models.review ?? null, String(err.message ?? err));
    recordTransition(prId, 'NEW', `analyze failed: ${err.message}`);
    throw err;
  }
  stageUsages.push({ stage: 'review', model: models.review, usage: candidate.usage, ms: Date.now() - reviewT0 });

  if (candidate.thinkingText) {
    logger.log(`\n--- REVIEW MODEL THINKING ---\n${candidate.thinkingText}\n--- END THINKING ---`);
  }
  logger.log(`pass 1 complete: ${candidate.comments.length} candidate comments`);
  if (candidate.usage) logger.log(`  review tokens: ${candidate.usage.tokens_in} in / ${candidate.usage.tokens_out} out (${candidate.usage.source})`);

  let result = candidate;
  if (!opts.skipCritic && candidate.comments.length > 0) {
    // Narrow the diff to only files that have candidate comments — reduces critic input by 50-80%.
    const commentedPaths = new Set(candidate.comments.map((c) => c.file));
    const criticDiff = reviewableFiles
      .filter((f) => commentedPaths.has(f.path))
      .map((f) => annotateDiff(f.body))
      .join('');
    const criticInput = { ...reviewInput, diff: criticDiff };
    logger.log(`\npass 2: critic refining ${candidate.comments.length} candidate comments across ${commentedPaths.size} file(s)...`);
    const ct0 = Date.now();
    try {
      result = await critique(provider, criticInput, candidate, models.critic);
      stageUsages.push({ stage: 'critic', model: models.critic, usage: result.usage, ms: Date.now() - ct0 });
      if (result.thinkingText) {
        logger.log(`\n--- CRITIC MODEL THINKING ---\n${result.thinkingText}\n--- END THINKING ---`);
      }
      if (result.usage) logger.log(`  critic tokens: ${result.usage.tokens_in} in / ${result.usage.tokens_out} out (${result.usage.source})`);
    } catch (err: any) {
      logger.log(`critic pass failed (${err.message}); using candidate as-is`);
    }
  }
  const ms = Date.now() - t0;

  // Roll up token + cost totals across stages
  let totalIn = 0, totalOut = 0, totalCost = 0;
  for (const s of stageUsages) {
    if (!s.usage) continue;
    totalIn += s.usage.tokens_in;
    totalOut += s.usage.tokens_out;
    totalCost += estimateCost(provider.name, s.model, s.usage.tokens_in, s.usage.tokens_out);
  }

  let aid: number;
  if (opts.reAnalyze) {
    aid = mergeReanalysis(db, prId, result, logger.getLogs());
  } else {
    aid = persistFreshAnalysis(db, prId, provider.name, result, ms, logger.getLogs());
  }
  persistTriage(db, aid, fileDiffs, triageItems);

  db.prepare(`UPDATE analysis SET tokens_in_total=?, tokens_out_total=?, cost_usd=? WHERE id=?`)
    .run(totalIn, totalOut, totalCost, aid);

  // Log each stage to usage_log
  const insUsage = db.prepare(
    `INSERT INTO usage_log (provider, pr_id, ok, ms_elapsed, tokens_in, tokens_out, cost_usd, stage, model) VALUES (?,?,1,?,?,?,?,?,?)`
  );
  for (const s of stageUsages) {
    const cost = s.usage ? estimateCost(provider.name, s.model, s.usage.tokens_in, s.usage.tokens_out) : null;
    insUsage.run(
      provider.name, prId, s.ms,
      s.usage?.tokens_in ?? null, s.usage?.tokens_out ?? null,
      cost, s.stage, s.model ?? null,
    );
  }

  recordTransition(prId, 'DRAFT_READY');

  logger.log(`Summary: ${result.summary.slice(0, 100)}...`);
  logger.log(`${result.comments.length} draft comments saved.`);
  if (totalIn || totalOut) {
    logger.log(`tokens: ${totalIn} in / ${totalOut} out  cost: ~${fmtUsd(totalCost)}`);
  }
}

function persistFreshAnalysis(
  db: ReturnType<typeof getDb>,
  prId: string,
  providerName: string,
  result: { summary: string; comments: any[]; rawResponse: string },
  ms: number,
  logs: string,
): number {
  const ins = db.prepare(
    `INSERT INTO analysis (pr_id, provider, summary, logs, raw_response, ms_elapsed) VALUES (?,?,?,?,?,?)`,
  );
  const info = ins.run(prId, providerName, result.summary, logs, result.rawResponse, ms);
  const aid = info.lastInsertRowid as number;

  const insC = db.prepare(`
    INSERT INTO comment_draft (analysis_id, file, line, side, severity, ai_original_body, current_body, confidence, category)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  for (const c of result.comments) {
    insC.run(aid, c.file, c.line, c.side, c.severity, c.body, c.body, c.confidence, c.category ?? 'correctness');
  }
  return aid;
}

function persistTriage(db: ReturnType<typeof getDb>, aid: number, files: { path: string; added: number; removed: number }[], items: TriageItem[]) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const ins = db.prepare(`
    INSERT INTO triage_decision (analysis_id, file, decision, reason, source, added, removed)
    VALUES (?,?,?,?,?,?,?)
  `);
  for (const t of items) {
    const f = byPath.get(t.path);
    ins.run(aid, t.path, t.decision, t.reason, t.source, f?.added ?? 0, f?.removed ?? 0);
  }
}

function triageContextForPrompt(items: TriageItem[]): string {
  const deep = items.filter((t) => t.decision === 'deep').map((t) => t.path);
  const shallow = items.filter((t) => t.decision === 'shallow').map((t) => t.path);
  const skipped = items.filter((t) => t.decision === 'skip').map((t) => t.path);
  const parts: string[] = [];
  if (deep.length) parts.push(`Deep-review files (focus here): ${deep.join(', ')}`);
  if (shallow.length) parts.push(`Shallow-review files (scan only, comment only on real issues): ${shallow.join(', ')}`);
  if (skipped.length) parts.push(`Skipped files (excluded from diff above): ${skipped.join(', ')}`);
  return parts.join('\n');
}

function mergeReanalysis(
  db: ReturnType<typeof getDb>,
  prId: string,
  result: { summary: string; comments: any[]; rawResponse: string },
  logs: string,
): number {
  const prevAnalysis = db
    .prepare(`SELECT id FROM analysis WHERE pr_id=? ORDER BY id DESC LIMIT 1`)
    .get(prId) as { id: number } | undefined;

  const ins = db.prepare(
    `INSERT INTO analysis (pr_id, provider, summary, logs, raw_response, ms_elapsed) VALUES (?,?,?,?,?,?)`,
  );
  const info = ins.run(prId, 'critic-merge', result.summary, logs, result.rawResponse, 0);
  const aid = info.lastInsertRowid as number;

  if (prevAnalysis) {
    const keepers = db
      .prepare(
        `SELECT * FROM comment_draft
         WHERE analysis_id=? AND action IN ('edited','added')`,
      )
      .all(prevAnalysis.id) as Array<any>;
    const move = db.prepare(
      `INSERT INTO comment_draft (analysis_id, file, line, side, severity, ai_original_body, current_body, action, confidence, category)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const k of keepers) {
      move.run(aid, k.file, k.line, k.side, k.severity, k.ai_original_body, k.current_body, k.action, k.confidence, k.category ?? 'correctness');
    }
  }

  const insC = db.prepare(`
    INSERT INTO comment_draft (analysis_id, file, line, side, severity, ai_original_body, current_body, confidence, category)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  for (const c of result.comments) {
    insC.run(aid, c.file, c.line, c.side, c.severity, c.body, c.body, c.confidence, c.category ?? 'correctness');
  }
  return aid;
}

function loadCachedTriage(
  db: ReturnType<typeof getDb>,
  prId: string,
  fileDiffs: { path: string }[],
): TriageItem[] {
  const prevAnalysis = db
    .prepare(`SELECT id FROM analysis WHERE pr_id=? ORDER BY id DESC LIMIT 1`)
    .get(prId) as { id: number } | undefined;
  if (!prevAnalysis) return [];

  const rows = db
    .prepare(`SELECT file, decision, reason, source FROM triage_decision WHERE analysis_id=?`)
    .all(prevAnalysis.id) as Array<{ file: string; decision: string; reason: string; source: string }>;
  if (rows.length === 0) return [];

  const currentPaths = new Set(fileDiffs.map((f) => f.path));
  const cachedPaths = new Set(rows.map((r) => r.file));
  // Only reuse if cached decisions cover every file in the current diff.
  if (![...currentPaths].every((p) => cachedPaths.has(p))) return [];

  return rows
    .filter((r) => currentPaths.has(r.file))
    .map((r) => ({
      path: r.file,
      decision: r.decision as TriageItem['decision'],
      reason: r.reason,
      source: r.source as TriageItem['source'],
    }));
}

function recordTransition(prId: string, to: string, note?: string) {
  const db = getDb();
  const row = db.prepare(`SELECT state FROM pr WHERE id=?`).get(prId) as { state?: string } | undefined;
  const from = row?.state ?? null;
  db.prepare(`UPDATE pr SET state=? WHERE id=?`).run(to, prId);
  db.prepare(`INSERT INTO state_event (pr_id, from_state, to_state, note) VALUES (?,?,?,?)`).run(
    prId,
    from,
    to,
    note ?? null,
  );
}

