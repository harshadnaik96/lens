import type { Config } from '../config.js';
import { buildIndex, clearIndex } from '../indexer.js';
import { detectRepoRoot } from '../local_diff.js';
import { getDb, initDb } from '../db.js';

export interface IndexCommandOpts {
  repoRoot?: string;
  force?: boolean;
}

export async function runIndex(cfg: Config, opts: IndexCommandOpts = {}): Promise<void> {
  const db = getDb();
  const repoRoot = opts.repoRoot ?? await detectRepoRoot().catch(() => process.cwd());

  if (!opts.force) {
    const row = db.prepare(
      `SELECT MAX(indexed_at) as last FROM symbol_index WHERE repo_root = ?`
    ).get(repoRoot) as { last: string | null };
    if (row?.last) {
      const ageMs = Date.now() - new Date(row.last).getTime();
      if (ageMs < 5 * 60 * 1000) {
        console.log(`Index is fresh (${Math.round(ageMs / 1000)}s old). Use --force to re-index.`);
        return;
      }
    }
  }

  console.log(`Indexing ${repoRoot}...`);
  process.stdout.write('  ');

  const languages = cfg.index?.languages ?? ['ts', 'js', 'go', 'py', 'java', 'dart'];
  const excludeDirs = cfg.index?.excludeDirs ?? ['node_modules', 'vendor', 'dist', 'build', '.next', '.git'];

  const stats = await buildIndex({ repoRoot, languages, excludeDirs });

  console.log(`\n✓ Indexed ${stats.files} files → ${stats.symbols} symbols, ${stats.callSites} call sites (${stats.durationMs}ms)`);
  console.log('\nTop referenced symbols:');

  const top = db.prepare(
    `SELECT symbol, COUNT(*) as cnt FROM symbol_index WHERE repo_root = ? AND kind = 'call' GROUP BY symbol ORDER BY cnt DESC LIMIT 10`
  ).all(repoRoot) as Array<{ symbol: string; cnt: number }>;

  for (const row of top) {
    console.log(`  ${row.symbol.padEnd(30)} ${row.cnt} call sites`);
  }
}
