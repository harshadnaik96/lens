import fs from 'node:fs';
import { initDb } from '../db.js';

export interface DigestOpts {
  days?: number;   // window in days (default 7)
  out?: string;    // write to file instead of stdout
}

interface PRRow { id: string; title: string; author: string; state: string; updated_at: string; }
interface CommentRow { pr_id: string; category: string; severity: string; action: string | null; }
interface UsageRow { pr_id: string; cost_usd: number | null; tokens_in_total: number | null; tokens_out_total: number | null; }

export function runDigest(opts: DigestOpts = {}): void {
  const db = initDb();
  const days = opts.days ?? 7;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const prs = db.prepare(`
    SELECT id, title, author, state, updated_at
    FROM pr WHERE updated_at >= ? ORDER BY updated_at DESC
  `).all(since) as PRRow[];

  const comments = db.prepare(`
    SELECT cd.analysis_id, a.pr_id, cd.category, cd.severity, cd.action
    FROM comment_draft cd
    JOIN analysis a ON cd.analysis_id = a.id
    WHERE a.created_at >= ?
  `).all(since) as CommentRow[];

  const usage = db.prepare(`
    SELECT pr_id, SUM(cost_usd) AS cost_usd,
           SUM(tokens_in_total) AS tokens_in_total,
           SUM(tokens_out_total) AS tokens_out_total
    FROM analysis WHERE created_at >= ?
    GROUP BY pr_id
  `).all(since) as UsageRow[];

  const usageByPr = new Map<string, UsageRow>(usage.map((u) => [u.pr_id, u]));

  // Aggregate stats
  const totalCost = usage.reduce((s, u) => s + (u.cost_usd ?? 0), 0);
  const totalIn = usage.reduce((s, u) => s + (u.tokens_in_total ?? 0), 0);
  const totalOut = usage.reduce((s, u) => s + (u.tokens_out_total ?? 0), 0);

  const accepted = comments.filter((c) => c.action === 'kept' || c.action === 'edited').length;
  const rejected = comments.filter((c) => c.action === 'rejected').length;
  const total = comments.filter((c) => c.action !== null).length;
  const acceptRate = total > 0 ? Math.round((accepted / total) * 100) : null;

  const catCounts: Record<string, number> = {};
  for (const c of comments) {
    if (c.action === 'kept' || c.action === 'edited') {
      catCounts[c.category ?? 'unknown'] = (catCounts[c.category ?? 'unknown'] ?? 0) + 1;
    }
  }

  const sevCounts: Record<string, number> = {};
  for (const c of comments) {
    if (c.action === 'kept' || c.action === 'edited') {
      sevCounts[c.severity ?? 'unknown'] = (sevCounts[c.severity ?? 'unknown'] ?? 0) + 1;
    }
  }

  const lines: string[] = [];
  lines.push(`# lens digest — last ${days} day${days !== 1 ? 's' : ''}`);
  lines.push(`> Generated ${new Date().toISOString().slice(0, 10)}\n`);

  lines.push(`## Overview`);
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| PRs seen | ${prs.length} |`);
  lines.push(`| Comments generated | ${comments.length} |`);
  lines.push(`| Comments accepted | ${accepted} |`);
  lines.push(`| Comments rejected | ${rejected} |`);
  lines.push(`| Acceptance rate | ${acceptRate !== null ? `${acceptRate}%` : 'n/a'} |`);
  lines.push(`| Total tokens | ${(totalIn + totalOut).toLocaleString()} |`);
  lines.push(`| Estimated cost | $${totalCost.toFixed(4)} |`);
  lines.push('');

  if (Object.keys(catCounts).length > 0) {
    lines.push(`## Accepted comments by category`);
    for (const [cat, n] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${cat}**: ${n}`);
    }
    lines.push('');
  }

  if (Object.keys(sevCounts).length > 0) {
    lines.push(`## Accepted comments by severity`);
    for (const [sev, n] of Object.entries(sevCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${sev}**: ${n}`);
    }
    lines.push('');
  }

  if (prs.length > 0) {
    lines.push(`## PRs reviewed`);
    lines.push(`| PR | Title | State | Cost |`);
    lines.push(`|----|-------|-------|------|`);
    for (const pr of prs.slice(0, 20)) {
      const u = usageByPr.get(pr.id);
      const cost = u?.cost_usd != null ? `$${u.cost_usd.toFixed(4)}` : '—';
      const title = pr.title.length > 50 ? pr.title.slice(0, 47) + '...' : pr.title;
      lines.push(`| \`${pr.id}\` | ${title} | ${pr.state} | ${cost} |`);
    }
    lines.push('');
  }

  const markdown = lines.join('\n');

  if (opts.out) {
    fs.writeFileSync(opts.out, markdown, 'utf8');
    console.log(`Digest written to ${opts.out}`);
  } else {
    console.log(markdown);
  }
}
