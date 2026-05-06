import { getDb, initDb } from '../db.js';

export interface AccuracyOpts {
  category?: string;
  severity?: string;
}

export function showAccuracy(opts: AccuracyOpts = {}): void {
  const db = getDb();

  let query = `
    SELECT
      category,
      severity,
      COUNT(*) as total,
      SUM(CASE WHEN action IN ('kept','edited') THEN 1 ELSE 0 END) as accepted,
      ROUND(100.0 * SUM(CASE WHEN action IN ('kept','edited') THEN 1 ELSE 0 END) / COUNT(*), 1) as rate
    FROM comment_draft
    WHERE 1=1
  `;
  const params: string[] = [];

  if (opts.category) { query += ' AND category = ?'; params.push(opts.category); }
  if (opts.severity) { query += ' AND severity = ?'; params.push(opts.severity); }
  query += ' GROUP BY category, severity ORDER BY category, rate DESC';

  const rows = db.prepare(query).all(...params) as Array<{
    category: string; severity: string; total: number; accepted: number; rate: number;
  }>;

  if (rows.length === 0) {
    console.log('No data yet. Run lens analyze and curate some comments first.');
    return;
  }

  const colW = [18, 12, 8, 10, 8];
  const header = ['Category', 'Severity', 'Total', 'Accepted', 'Rate'].map((h, i) => h.padEnd(colW[i])).join('  ');
  const sep = colW.map((w) => '─'.repeat(w)).join('──');

  console.log('\n' + header);
  console.log(sep);

  let lastCat = '';
  for (const row of rows) {
    if (row.category !== lastCat && lastCat !== '') console.log(sep);
    lastCat = row.category;
    const bar = rateBar(row.rate);
    const line = [
      row.category.padEnd(colW[0]),
      row.severity.padEnd(colW[1]),
      String(row.total).padEnd(colW[2]),
      String(row.accepted).padEnd(colW[3]),
      `${row.rate}%`.padEnd(colW[4]),
    ].join('  ') + '  ' + bar;
    console.log(line);
  }

  console.log(sep);

  // reviewer profiles if available
  const reviewers = db.prepare(`SELECT reviewer, acceptance_rate, total_accepted, total_seen FROM reviewer_profile ORDER BY total_seen DESC LIMIT 10`).all() as Array<{ reviewer: string; acceptance_rate: number; total_accepted: number; total_seen: number }>;
  if (reviewers.length > 0) {
    console.log('\nReviewer profiles:');
    for (const r of reviewers) {
      console.log(`  ${r.reviewer.padEnd(30)} ${Math.round(r.acceptance_rate * 100)}% acceptance (${r.total_accepted}/${r.total_seen})`);
    }
  }
}

function rateBar(rate: number): string {
  const filled = Math.round(rate / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${rate}%`;
}
