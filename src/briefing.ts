import type { Provider } from './providers/types.js';
import type { TriageItem } from './triage.js';
import type { UsageInfo } from './providers/types.js';

export interface PriorComment {
  author: string;
  file: string;
  line: number | null;
  body: string;
}

export interface BriefingInput {
  prTitle: string;
  prDescription: string;
  diff: string;
  changedFiles: string[];
  triageItems: TriageItem[];
  /** Prior human reviewer comments on this PR, if any have been ingested. */
  priorComments?: PriorComment[];
}

export interface Briefing {
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  riskRationale?: string;
  whatChanged: string[];
  focusAreas: Array<{ file: string; reason: string }>;
  safeToSkip: string[];
  hotSpots?: Array<{ file: string; note: string }>;
  estimatedMinutes: number;
  usage?: UsageInfo;
}

const BRIEFING_PROMPT = `You are a PR navigator. Your ONLY job is to help a human reviewer orient themselves quickly. Do NOT review code quality — that is handled separately.

Output a single JSON object (no prose around it):
{
  "riskLevel": "LOW" | "MEDIUM" | "HIGH",
  "riskRationale": "one sentence naming the specific thing that drives this risk level (e.g. 'modifies the Stripe webhook signature check')",
  "whatChanged": ["3-5 bullet points naming concrete behavior changes — refer to specific functions, endpoints, or modules. Avoid vague phrases like 'refactors X' or 'improves Y'."],
  "focusAreas": [{"file": "path/to/file", "reason": "specific reason: a function name, an invariant, a tricky branch — not a category like 'security-relevant'"}],
  "safeToSkip": ["file or directory and why it is safe to skim"],
  "hotSpots": [{"file": "path/to/file", "note": "what prior reviewers flagged here — only include if PRIOR_REVIEWER_COMMENTS section below has entries on this file"}],
  "estimatedMinutes": 15
}

Risk rubric:
- HIGH: security-sensitive paths, core business logic, DB migrations, public API changes, auth, money/payment flows, anything touching user data at scale
- MEDIUM: moderate logic changes, internal API changes, non-trivial refactors, new external dependencies
- LOW: config tweaks, docs, minor additions, test-only changes, dependency patch bumps

Quality bar — these are the failure modes you must avoid:
- Do NOT restate the PR title in whatChanged. Add information beyond the title.
- Do NOT use generic reasons like "security-relevant" or "complex logic" — name the specific function, branch, or invariant.
- Do NOT invent prior reviewer comments. Only populate hotSpots from the PRIOR_REVIEWER_COMMENTS section if present.
- Do NOT pad focusAreas with files that are mechanical (renames, format-only). Quality > quantity; 1–4 entries is normal.

estimatedMinutes: your own honest estimate based on cognitive load (unfamiliarity, branching complexity, surface area) — NOT a formula on line count. A 500-line rename is 5 minutes; a 30-line concurrency fix can be 45.

focusAreas: list only files worth a close read.
safeToSkip: lockfiles, generated code, trivial test additions, config-only changes.`;

export async function generateBriefing(
  provider: Provider,
  input: BriefingInput,
): Promise<Briefing> {
  const filesList = input.changedFiles.map((f) => `- ${f}`).join('\n');
  const triageSummary = input.triageItems
    .map((t) => `${t.path}: ${t.decision}${t.reason ? ` (${t.reason})` : ''}`)
    .join('\n');

  const totalLines = (input.diff.match(/^[+-]/gm) ?? []).length;

  // Build a compact prior-comments block. Cap to the most recent 20 to keep
  // the prompt tight, and trim each body to 280 chars — we just need a hint.
  const priorComments = (input.priorComments ?? []).slice(-20);
  const priorBlock = priorComments.length === 0
    ? '(none ingested)'
    : priorComments.map((c) => {
        const where = c.file + (c.line ? ':' + c.line : '');
        const body = c.body.length > 280 ? c.body.slice(0, 277) + '...' : c.body;
        return `- ${c.author} on \`${where}\`: ${body.replace(/\s+/g, ' ').trim()}`;
      }).join('\n');

  const userBody = `PR Title: ${input.prTitle}
PR Description: ${input.prDescription || '(none)'}

Changed files:
${filesList}

Triage decisions:
${triageSummary}

PRIOR_REVIEWER_COMMENTS (already on this PR — use to populate hotSpots; do NOT invent):
${priorBlock}

Diff size: ${totalLines} changed lines. Use as one signal for review time, not the only one.

Return ONLY the JSON object.`;

  const prompt = `${BRIEFING_PROMPT}\n\n${userBody}`;

  // ReviewInput requires: prTitle, prDescription, diff, changedFiles (FileContext[]), skills, prompt
  const result = await provider.review(
    {
      prompt,
      diff: '',
      changedFiles: input.changedFiles.map((f) => ({ path: f })),
      prTitle: input.prTitle,
      prDescription: input.prDescription,
      skills: '',
    },
    {},
  );

  // parse the raw response as JSON
  let parsed: any = {};
  try {
    const raw = result.rawResponse ?? '';
    const fence = raw.match(/```json\s*([\s\S]*?)```/);
    const candidate = fence ? fence[1] : raw;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1) parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch { /* use defaults */ }

  // Sanity-clamp the model's estimate so a hallucinated 9999 doesn't reach the UI.
  const rawMinutes = typeof parsed.estimatedMinutes === 'number' ? parsed.estimatedMinutes : 15;
  const estimatedMinutes = Math.min(120, Math.max(2, Math.round(rawMinutes)));

  return {
    riskLevel: (['LOW', 'MEDIUM', 'HIGH'].includes(parsed.riskLevel) ? parsed.riskLevel : 'MEDIUM') as Briefing['riskLevel'],
    riskRationale: typeof parsed.riskRationale === 'string' ? parsed.riskRationale : undefined,
    whatChanged: Array.isArray(parsed.whatChanged) ? parsed.whatChanged : [],
    focusAreas: Array.isArray(parsed.focusAreas) ? parsed.focusAreas : [],
    safeToSkip: Array.isArray(parsed.safeToSkip) ? parsed.safeToSkip : [],
    hotSpots: Array.isArray(parsed.hotSpots) ? parsed.hotSpots : [],
    estimatedMinutes,
    usage: result.usage,
  };
}

export function formatBriefingMarkdown(briefing: Briefing, prTitle: string): string {
  const riskEmoji = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🔴' }[briefing.riskLevel];
  const riskLine = briefing.riskRationale
    ? `**Risk:** ${riskEmoji} ${briefing.riskLevel} — ${briefing.riskRationale} &nbsp;|&nbsp; **Estimated review time:** ~${briefing.estimatedMinutes} min`
    : `**Risk:** ${riskEmoji} ${briefing.riskLevel} &nbsp;|&nbsp; **Estimated review time:** ~${briefing.estimatedMinutes} min`;

  const lines: string[] = [
    `## 🔍 Reviewer Briefing — ${prTitle}`,
    '',
    riskLine,
    '',
    '### What changed',
    ...briefing.whatChanged.map((b) => `- ${b}`),
  ];

  if (briefing.focusAreas.length > 0) {
    lines.push('', '### Focus here');
    for (const f of briefing.focusAreas) lines.push(`- **${f.file}** — ${f.reason}`);
  }

  if (briefing.hotSpots && briefing.hotSpots.length > 0) {
    lines.push('', '### Hot spots from prior reviews');
    for (const h of briefing.hotSpots) lines.push(`- **${h.file}** — ${h.note}`);
  }

  if (briefing.safeToSkip.length > 0) {
    lines.push('', '### Safe to skim');
    for (const s of briefing.safeToSkip) lines.push(`- ${s}`);
  }

  lines.push('', '---', '*Generated by [lens](https://github.com/mintoak/lens) — local AI review assistant*');
  return lines.join('\n');
}
