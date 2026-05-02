import { getDb } from '../db.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';

interface CommentRow {
  id: number;
  file: string;
  line: number;
  severity: string;
  category: string;
  ai_original_body: string | null;
  current_body: string | null;
  action: string;
  reject_reason: string | null;
}

export interface DiffOpts {
  prId?: string;
  onlyEdited?: boolean;
}

/**
 * Print AI-original vs final-submitted bodies for each comment, side by side.
 * The diff between the two columns IS the user's voice — what was softened,
 * sharpened, or reframed. This is the corpus for `lens learn` (Phase 11).
 */
export function showDiff(opts: DiffOpts = {}) {
  const db = getDb();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.prId) { where.push('a.pr_id = ?'); params.push(opts.prId); }
  if (opts.onlyEdited) where.push("c.action IN ('edited','deleted')");

  const sql = `
    SELECT c.id, c.file, c.line, c.severity, c.category,
           c.ai_original_body, c.current_body, c.action, c.reject_reason,
           a.pr_id, a.created_at
    FROM comment_draft c
    JOIN analysis a ON a.id = c.analysis_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.pr_id, a.id, c.id
  `;
  const rows = db.prepare(sql).all(...params) as Array<CommentRow & { pr_id: string; created_at: string }>;

  if (rows.length === 0) {
    console.log('No comments matched.');
    return;
  }

  let currentPr = '';
  const counts = { kept: 0, edited: 0, deleted: 0, added: 0 };

  for (const r of rows) {
    counts[r.action as keyof typeof counts] = (counts[r.action as keyof typeof counts] ?? 0) + 1;

    if (r.pr_id !== currentPr) {
      currentPr = r.pr_id;
      console.log(`\n${BOLD}━━━ ${r.pr_id} ━━━${RESET}`);
    }

    const tag = actionTag(r.action);
    console.log(`\n  ${tag}  ${DIM}${r.file}:${r.line}  [${r.severity}/${r.category}]  #${r.id}${RESET}`);

    if (r.action === 'added') {
      console.log(printIndented(GREEN + (r.current_body ?? '') + RESET, '    '));
      continue;
    }

    const ai = (r.ai_original_body ?? '').trim();
    const final = (r.current_body ?? '').trim();

    if (r.action === 'deleted') {
      console.log(printIndented(RED + ai + RESET, '    '));
      if (r.reject_reason) console.log(`    ${YELLOW}reason: ${r.reject_reason}${RESET}`);
      continue;
    }

    if (ai === final) {
      console.log(printIndented(DIM + ai + RESET, '    '));
      continue;
    }

    // edited: show both
    console.log(`    ${DIM}AI:${RESET}`);
    console.log(printIndented(RED + ai + RESET, '      '));
    console.log(`    ${DIM}Final:${RESET}`);
    console.log(printIndented(GREEN + final + RESET, '      '));
  }

  console.log(
    `\n${BOLD}Totals${RESET}: kept=${counts.kept ?? 0}  edited=${counts.edited ?? 0}  rejected=${counts.deleted ?? 0}  human_added=${counts.added ?? 0}`,
  );
}

function actionTag(action: string): string {
  switch (action) {
    case 'kept':    return GREEN + '✓ kept   ' + RESET;
    case 'edited':  return YELLOW + '✎ edited ' + RESET;
    case 'deleted': return RED + '✗ rejected' + RESET;
    case 'added':   return GREEN + '+ added  ' + RESET;
    default:        return DIM + '? ' + action + RESET;
  }
}

function printIndented(s: string, pad: string): string {
  return s.split('\n').map((l) => pad + l).join('\n');
}
