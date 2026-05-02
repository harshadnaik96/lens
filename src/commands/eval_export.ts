import fs from 'node:fs';
import { getDb } from '../db.js';

export interface ExportOpts {
  out?: string;
  prId?: string;
}

export function exportEval(opts: ExportOpts = {}) {
  const db = getDb();
  const where = opts.prId ? `WHERE a.pr_id = ?` : '';
  const params = opts.prId ? [opts.prId] : [];
  const rows = db
    .prepare(
      `SELECT
         a.pr_id, a.provider, a.created_at AS analysis_at, a.summary,
         a.tokens_in_total, a.tokens_out_total, a.cost_usd,
         c.id AS comment_id, c.file, c.line, c.side, c.severity, c.category,
         c.ai_original_body, c.current_body, c.action, c.confidence, c.reject_reason,
         pr.title AS pr_title, pr.author AS pr_author
       FROM comment_draft c
       JOIN analysis a ON a.id = c.analysis_id
       LEFT JOIN pr ON pr.id = a.pr_id
       ${where}
       ORDER BY a.pr_id, a.id, c.id`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const lines = rows.map((r) => {
    const aiBody = (r.ai_original_body as string | null) ?? '';
    const curBody = (r.current_body as string | null) ?? '';
    const action = (r.action as string) ?? 'kept';
    const label = action === 'deleted' ? 'rejected' : action === 'edited' ? 'edited' : action === 'added' ? 'human_added' : 'accepted';
    return JSON.stringify({
      pr_id: r.pr_id,
      pr_title: r.pr_title,
      pr_author: r.pr_author,
      provider: r.provider,
      analysis_at: r.analysis_at,
      summary: r.summary,
      tokens_in_total: r.tokens_in_total ?? null,
      tokens_out_total: r.tokens_out_total ?? null,
      cost_usd: r.cost_usd ?? null,
      comment_id: r.comment_id,
      file: r.file,
      line: r.line,
      side: r.side,
      severity: r.severity,
      category: r.category ?? 'correctness',
      ai_body: aiBody,
      final_body: curBody,
      action,
      label,
      reject_reason: r.reject_reason ?? null,
      confidence: r.confidence,
    });
  });

  const text = lines.join('\n') + (lines.length ? '\n' : '');
  if (opts.out) {
    fs.writeFileSync(opts.out, text);
    console.error(`wrote ${lines.length} rows to ${opts.out}`);
  } else {
    process.stdout.write(text);
  }

  if (process.stderr.isTTY || opts.out) {
    const counts = rows.reduce<Record<string, number>>((acc, r) => {
      const k = (r.action as string) ?? 'kept';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    console.error(`counts: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
}
