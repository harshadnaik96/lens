import type { Config } from '../config.js';
import { getForge } from '../forge/index.js';
import { getProvider } from '../providers/index.js';
import { parseRef } from '../forge/types.js';
import { splitDiffByFile } from '../diff_split.js';
import { triage } from '../triage.js';
import { generateBriefing, formatBriefingMarkdown } from '../briefing.js';
import type { Effort } from './pr.js';

export interface BriefOpts {
  providerOverride?: string;
  effort?: Effort;
  post?: boolean;
  print?: boolean;
}

export async function briefPR(cfg: Config, prId: string, opts: BriefOpts = {}): Promise<void> {
  const forge = getForge(cfg);
  const provider = getProvider(cfg, opts.providerOverride);
  const ref = parseRef(prId);

  console.log(`Fetching diff for ${prId}...`);
  const diff = await forge.getDiff(ref);
  const fileDiffs = splitDiffByFile(diff);
  const changedFiles = fileDiffs.map((f) => f.path);

  console.log('Triaging files...');
  // triage(provider, files, model?)
  const triageResult = await triage(provider, fileDiffs);
  const triageItems = triageResult.items;

  console.log('Generating briefing...');
  const pr = { title: prId, description: '' };
  // try to get PR title from DB
  try {
    const { getDb } = await import('../db.js');
    const row = getDb().prepare('SELECT title FROM pr WHERE id = ?').get(prId) as any;
    if (row?.title) pr.title = row.title;
  } catch { /* ok */ }

  const briefing = await generateBriefing(provider, {
    prTitle: pr.title,
    prDescription: pr.description,
    diff,
    changedFiles,
    triageItems,
  });

  const markdown = formatBriefingMarkdown(briefing, pr.title);

  if (opts.print !== false) {
    console.log('\n' + markdown + '\n');
  }

  if (opts.post !== false) {
    console.log('Posting briefing to forge...');
    await forge.postTopLevelComment(ref, markdown);
    console.log('✓ Briefing posted.');
  }
}
