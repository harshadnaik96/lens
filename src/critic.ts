import type { Provider, ReviewInput, ReviewOutput, ReviewOpts } from './providers/types.js';
import { ReviewOutputSchema } from './providers/types.js';
import { buildAccuracyGuidance } from './accuracy_tuning.js';

const CRITIC_RULES = `You are an elite review filter. You receive candidate comments from a multi-lens code review, each tagged with a category (correctness, security, data_integrity, api_contracts, maintainability).

Your job: ensure every surviving comment would make a senior engineer say "good catch."

## Filtering rules
- Drop any comment that does not point at a REAL issue in the changed lines.
- Drop comments that restate what the code does — each must explain what is WRONG.
- Drop style nits, naming opinions, or anything a linter/formatter handles.
- Drop vague or hedge-heavy comments ("might be an issue", "consider whether").

## Cross-category deduplication
- If two comments (even from different categories) flag the same issue on the same line, keep the one with higher severity. If tied, prefer: security > correctness > data_integrity > api_contracts > maintainability.
- Collapse near-duplicate comments (same root cause, different wording) into the strongest one.

## Severity calibration (strict)
- blocker: ships a bug, security vulnerability, data loss, breaks production
- concern: likely defect, needs author confirmation, real performance regression
- suggestion: clear improvement, not required for correctness or safety
- info: genuinely non-obvious context; use ONLY when the author truly wouldn't know this
- Maintainability comments may ONLY be suggestion or info. If a maintainability comment is marked blocker or concern, downgrade it.

## Budget enforcement
- Keep at most 15 comments total.
- If over budget, drop in this order:
  1. maintainability info
  2. maintainability suggestion
  3. lowest confidence comments from any category
  4. info from any category
- NEVER drop a security blocker or correctness blocker to hit budget.

## Confidence calibration
- Lower confidence on anything uncertain. Drop comments with confidence < 0.5.
- If a comment references code not visible in the diff, lower confidence to 0.3 (likely hallucinated).

## Summary
- Rewrite the summary to 2-5 sentences covering ONLY the most critical findings.
- Do not list every comment in the summary. Highlight patterns and top risks.

Output ONLY the corrected JSON object in the same schema (including category field):
{
  "summary": "...",
  "comments": [ { "file","line","side","severity","category","body","confidence" } ]
}`;

export async function critique(
  provider: Provider,
  input: ReviewInput,
  candidate: ReviewOutput,
  model?: string,
  extraOpts?: Pick<ReviewOpts, 'onAgentEvent' | 'stage' | 'signal'>,
): Promise<ReviewOutput> {
  const { guidance } = buildAccuracyGuidance();
  const tuningBlock = guidance ? `\n\n${guidance}` : '';
  const critiquePrompt = `${CRITIC_RULES}${tuningBlock}

## Original PR diff (for reference)
\`\`\`diff
${input.diff}
\`\`\`

## CANDIDATE review to critique
\`\`\`json
${JSON.stringify({ summary: candidate.summary, comments: candidate.comments }, null, 2)}
\`\`\`

Return ONLY the corrected JSON.`;

  const refined = await provider.review({
    ...input,
    prompt: critiquePrompt,
    diff: '',
    skills: '',
    prTitle: input.prTitle,
    prDescription: 'Critique pass — see prompt body.',
  }, { model, ...extraOpts });

  try {
    const parsed = ReviewOutputSchema.parse({
      summary: refined.summary,
      comments: refined.comments,
    });
    return { ...parsed, rawResponse: refined.rawResponse, usage: refined.usage, thinkingText: refined.thinkingText };
  } catch {
    return { ...candidate, usage: refined.usage ?? candidate.usage };
  }
}
