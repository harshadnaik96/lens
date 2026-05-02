import { getDb } from '../db.js';
import { fmtUsd } from '../pricing.js';

export interface UsageOpts {
  byPr?: boolean;
  byStage?: boolean;
  limit?: number;
}

export function showUsage(opts: UsageOpts = {}) {
  const db = getDb();

  if (opts.byPr) {
    const limit = opts.limit ?? 20;
    const rows = db.prepare(`
      SELECT pr_id,
             SUM(tokens_in)  AS tin,
             SUM(tokens_out) AS tout,
             SUM(cost_usd)   AS cost,
             SUM(ms_elapsed) AS ms,
             MAX(at)         AS last
      FROM usage_log
      WHERE pr_id IS NOT NULL
      GROUP BY pr_id
      ORDER BY last DESC
      LIMIT ?
    `).all(limit) as Array<{ pr_id: string; tin: number; tout: number; cost: number; ms: number; last: string }>;

    if (rows.length === 0) { console.log('No per-PR usage recorded yet.'); return; }
    console.log('PR ID                                  Tokens In  Tokens Out  Cost      Time   Last');
    for (const r of rows) {
      console.log(
        `${(r.pr_id ?? '').padEnd(38)} ${String(r.tin ?? 0).padStart(9)}  ${String(r.tout ?? 0).padStart(10)}  ${fmtUsd(r.cost ?? 0).padEnd(8)}  ${(((r.ms ?? 0) / 1000).toFixed(1) + 's').padStart(5)}  ${r.last ?? ''}`,
      );
    }
    return;
  }

  if (opts.byStage) {
    const rows = db.prepare(`
      SELECT stage, model,
             COUNT(*)        AS n,
             SUM(tokens_in)  AS tin,
             SUM(tokens_out) AS tout,
             SUM(cost_usd)   AS cost,
             AVG(ms_elapsed) AS avg_ms
      FROM usage_log
      WHERE stage IS NOT NULL
      GROUP BY stage, model
      ORDER BY stage, cost DESC
    `).all() as Array<{ stage: string; model: string | null; n: number; tin: number; tout: number; cost: number; avg_ms: number }>;

    if (rows.length === 0) { console.log('No per-stage usage recorded yet.'); return; }
    console.log('Stage    Model                          Calls  Tokens In  Tokens Out  Cost      AvgMs');
    for (const r of rows) {
      console.log(
        `${(r.stage ?? '').padEnd(8)} ${(r.model ?? '(default)').padEnd(30)} ${String(r.n).padStart(5)}  ${String(r.tin ?? 0).padStart(9)}  ${String(r.tout ?? 0).padStart(10)}  ${fmtUsd(r.cost ?? 0).padEnd(8)}  ${String(Math.round(r.avg_ms ?? 0)).padStart(5)}`,
      );
    }
    return;
  }

  // Default: per-provider summary, with cost
  const rows = db
    .prepare(
      `
      SELECT provider,
        SUM(CASE WHEN at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS d1,
        SUM(CASE WHEN at >= datetime('now','-7 day') THEN 1 ELSE 0 END) AS d7,
        SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS errors,
        AVG(ms_elapsed) AS avg_ms,
        SUM(tokens_in)  AS tin,
        SUM(tokens_out) AS tout,
        SUM(cost_usd)   AS cost,
        MAX(at) AS last
      FROM usage_log
      GROUP BY provider
    `,
    )
    .all() as Array<{
      provider: string; d1: number; d7: number; errors: number;
      avg_ms: number | null; tin: number | null; tout: number | null;
      cost: number | null; last: string | null;
    }>;

  if (rows.length === 0) { console.log('No usage recorded yet.'); return; }
  console.log('Provider     Calls/24h  Calls/7d  Errors  AvgMs  Tokens In   Tokens Out  Cost      Last');
  for (const r of rows) {
    console.log(
      `${r.provider.padEnd(12)} ${String(r.d1).padEnd(10)} ${String(r.d7).padEnd(9)} ${String(r.errors).padEnd(7)} ${String(Math.round(r.avg_ms ?? 0)).padEnd(6)} ${String(r.tin ?? 0).padStart(9)}   ${String(r.tout ?? 0).padStart(10)}  ${fmtUsd(r.cost ?? 0).padEnd(8)}  ${r.last ?? ''}`,
    );
  }
  console.log('\nTip: `lens usage --by-pr` for per-PR breakdown, `--by-stage` for stage breakdown.');
}
