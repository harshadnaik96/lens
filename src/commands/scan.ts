import type { Config } from '../config.js';
import { getProvider } from '../providers/index.js';
import { getChangedFilesFromDiff, detectRepoRoot, detectBaseBranch, getMergeBase, getLocalDiff } from '../local_diff.js';
import { runAnalysisPipeline } from './pr.js';

export interface ScanOpts {
  providerOverride?: string;
  skipCritic?: boolean;
  skipTriage?: boolean;
  effort?: 'low' | 'medium' | 'high';
  base?: string;
  post?: boolean; // reserved — scan is local-only for now
}

export async function runScan(cfg: Config, opts: ScanOpts = {}): Promise<void> {
  const provider = getProvider(cfg, opts.providerOverride);
  const ok = await provider.isAvailable();
  if (!ok) throw new Error(`provider ${provider.name} not available on PATH`);

  const repoRoot = await detectRepoRoot(process.cwd());
  const baseBranch = opts.base ?? (await detectBaseBranch(repoRoot));
  const mergeBase = await getMergeBase(baseBranch, repoRoot);

  console.log(`Scanning local diff: ${mergeBase.slice(0, 8)}..HEAD (base: ${baseBranch})`);

  const diff = await getLocalDiff(`${mergeBase}..HEAD`, repoRoot);
  if (!diff.trim()) {
    console.log('No changes vs base branch. Nothing to scan.');
    return;
  }

  const changedFiles = getChangedFilesFromDiff(diff);
  console.log(`${changedFiles.length} changed file(s) to review.`);

  const result = await runAnalysisPipeline(cfg, diff, changedFiles, '(local scan)', '', {
    providerOverride: opts.providerOverride,
    skipCritic: opts.skipCritic,
    skipTriage: opts.skipTriage,
    effort: opts.effort,
    repoRoot,
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary: ${result.summary}`);
  console.log(`${'─'.repeat(60)}\n`);

  if (result.comments.length === 0) {
    console.log('No issues found.');
    return;
  }

  const bySeverity: Record<string, typeof result.comments> = {};
  for (const c of result.comments) {
    (bySeverity[c.severity] ??= []).push(c);
  }

  const order = ['blocker', 'concern', 'suggestion', 'info'];
  for (const sev of order) {
    const items = bySeverity[sev];
    if (!items?.length) continue;
    const label = sev === 'blocker' ? '🚫 BLOCKER' : sev === 'concern' ? '⚠️  CONCERN' : sev === 'suggestion' ? '💡 SUGGESTION' : 'ℹ️  INFO';
    console.log(`\n${label} (${items.length})`);
    for (const c of items) {
      console.log(`  ${c.file}:${c.line ?? '?'}  [${c.category}]`);
      const lines = c.body.split('\n');
      for (const l of lines) console.log(`    ${l}`);
    }
  }

  const blockers = result.comments.filter((c) => c.severity === 'blocker');
  if (blockers.length > 0) {
    console.log(`\n${blockers.length} blocker(s) found — fix before pushing.`);
    process.exitCode = 1;
  }
}
