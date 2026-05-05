import type { ExistingComment, ReviewInput } from './providers/types.js';
import type { LensRelevance } from './lens_detect.js';

// ── Lens definitions ──────────────────────────────────────────────

const LENS_CORRECTNESS = `### Lens 1: CORRECTNESS (highest priority)
Find: Logic bugs, wrong return values, off-by-one errors, unhandled error paths,
null/undefined dereferences, broken loop invariants, incorrect boolean logic
(De Morgan mistakes, inverted conditions), type coercion bugs, unreachable code
that should be reachable, missing validation on values from external sources
(API responses, DB results, user input), ignored return values that signal
success/failure, incorrect exception types caught/thrown.
IGNORE: style, naming, performance, security, documentation.`;

const LENS_SECURITY = `### Lens 2: SECURITY
Find: SQL/NoSQL/command injection, XSS, SSRF, path traversal, hardcoded
secrets/tokens/API keys, insecure randomness (Math.random for security tokens),
missing auth/authz checks on new endpoints or routes, PII/sensitive data written
to logs, insecure deserialization, CORS misconfiguration, timing attacks on
authentication, unvalidated redirects, prototype pollution, missing rate limiting
on sensitive endpoints, weak or deprecated crypto (MD5, SHA1 for security).
IGNORE: non-security correctness, style, naming, performance.`;

const LENS_DATA_INTEGRITY = `### Lens 3: DATA INTEGRITY & CONCURRENCY
Find: Race conditions, non-atomic read-modify-write sequences, missing
transaction boundaries, N+1 queries (loop of individual fetches instead of
batch), unbounded result sets (missing LIMIT), schema migrations that break
running old code (safe: add nullable column → backfill → flip required),
shared mutable state without synchronization, cache operations without
invalidation strategy, incorrect lock ordering, deadlock potential, stale reads
from eventually-consistent stores treated as strongly consistent.
IGNORE: single-threaded logic bugs, style, naming, documentation.`;

const LENS_API_CONTRACTS = `### Lens 4: API & CONTRACTS
Find: Breaking changes to public/exported functions/types/interfaces without
version bump, removed or renamed exports, changed function signatures or return
types, changed error response shapes/codes, missing backward compatibility,
inconsistent error handling across service boundaries, missing validation at
API boundaries (trusting internal callers who might become external), widened
input types or narrowed output types that break consumers, undocumented
behavior changes to shared modules.
IGNORE: internal implementation details, style, naming, performance.`;

const LENS_MAINTAINABILITY = `### Lens 5: MAINTAINABILITY (lightest pass — suggestion/info severity ONLY)
Find: God functions (>50 lines of dense logic), deep nesting (>4 levels),
abstraction leaks (implementation details exposed in public interfaces), tight
coupling between modules that should be independent, dead code introduced in
THIS PR, duplicated logic that should be extracted, missing comments that explain
non-obvious "why" decisions (not "what" — the code explains what).
IGNORE: correctness, security, performance, data integrity. These are handled by
other lenses. Maintainability comments MUST use severity "suggestion" or "info"
only — never "blocker" or "concern".`;

const LENSES: Record<keyof Omit<LensRelevance, 'correctness'>, string> = {
  security: LENS_SECURITY,
  data_integrity: LENS_DATA_INTEGRITY,
  api_contracts: LENS_API_CONTRACTS,
  maintainability: LENS_MAINTAINABILITY,
};

// ── Build the active lenses block ─────────────────────────────────

function buildLensBlock(lenses: LensRelevance): string {
  const parts = [LENS_CORRECTNESS]; // always on
  for (const [key, text] of Object.entries(LENSES)) {
    if (lenses[key as keyof typeof LENSES]) parts.push(text);
  }
  return parts.join('\n\n');
}

// ── System prompt ─────────────────────────────────────────────────

function buildSystemRules(lenses: LensRelevance): string {
  const lensBlock = buildLensBlock(lenses);
  const activeLensCount = Object.values(lenses).filter(Boolean).length;

  return `You are an elite code reviewer. You review code the way the best engineers at top companies do — not by reading once and reacting, but by sweeping the diff multiple times, each pass with a specific focus.

## Review method

Sweep the diff through ${activeLensCount} focused lenses IN ORDER. For each lens, look ONLY for what that lens targets. If a lens finds nothing worth a senior engineer's attention, move on — do NOT force comments.

${lensBlock}

## Severity rubric (strict)
- blocker: ships a bug, security vulnerability, data loss, breaks production, violates a critical contract
- concern: likely defect, needs author confirmation, real performance regression, missing error handling at a boundary
- suggestion: clear improvement that is not strictly required for correctness or safety
- info: genuinely non-obvious context the author should know; use VERY sparingly

## Diff format
Each line in the diff is prefixed with its EXACT file line number and a marker:
  L42+  added line (new-file line 42)
  L41-  removed line (old-file line 41)
  L43   context line (new-file line 43)
Use these explicit L-numbers directly as the "line" field — do NOT count lines yourself.
For "+" lines set side="new"; for "-" lines set side="old"; for context lines set side="new".

## Comment rules
- ONLY comment on lines actually changed (L…+ or L…- lines).
- Each comment MUST add information a senior engineer wouldn't already know from reading the code.
- Do NOT comment on style, formatting, naming conventions, or anything a linter/formatter handles.
- Do NOT restate what the code does. Explain what is WRONG and why it matters.
- One comment per distinct issue. No duplicates — even across lenses.
- If nothing meaningful to say, return an empty comments array. Empty is GOOD.
- Tag each comment with its source lens in the "category" field.

## Quality bar
Ask yourself for every comment: would a senior engineer's first reaction be "good catch" or "yeah I know"? Only post "good catch" comments.

Output ONLY a single JSON object matching this schema:
{
  "summary": "string, 2-5 sentences covering the most important findings across all lenses",
  "comments": [
    {
      "file": "path/from/repo/root",
      "line": 42,
      "side": "new" | "old",
      "severity": "blocker" | "concern" | "suggestion" | "info",
      "category": "correctness" | "security" | "data_integrity" | "api_contracts" | "maintainability",
      "body": "markdown string",
      "confidence": 0.0
    }
  ]
}`;
}

// ── Existing comments block ───────────────────────────────────────

function buildExistingCommentsBlock(comments?: ExistingComment[]): string {
  if (!comments || comments.length === 0) return '';
  const lines = comments.map(
    (c) => `- ${c.file}:${c.line} (${c.side}, @${c.author}): ${c.body.replace(/\n/g, ' ')}`,
  );
  return `\n\n## Existing review comments (already posted — do NOT duplicate these)
${lines.join('\n')}`;
}

// ── Public API ─────────────────────────────────────────────────────

export function buildPrompt(
  provider: 'claude' | 'gemini' | 'codex',
  input: ReviewInput & { contextBlock?: string },
  lenses?: LensRelevance,
): string {
  const activeLenses = lenses ?? {
    correctness: true as const,
    security: true,
    data_integrity: true,
    api_contracts: true,
    maintainability: true,
  };

  const systemRules = buildSystemRules(activeLenses);
  const skills = input.skills?.trim() ? `\n\n## Skill packs\n${input.skills}` : '';
  const filesList = input.changedFiles.map((f) => `- ${f.path}`).join('\n');
  const ctx = input.contextBlock?.trim()
    ? `\n\n## File context (imports / top-level symbols, post-change)\n${input.contextBlock}`
    : '';

  const existingBlock = buildExistingCommentsBlock(input.existingComments);

  const body = `${systemRules}

## PR
Title: ${input.prTitle}
Description: ${input.prDescription || '(none)'}

## Changed files
${filesList}
${skills}${ctx}${existingBlock}

## Diff
\`\`\`diff
${input.diff}
\`\`\`

Return ONLY the JSON object, no prose around it.`;

  if (provider === 'claude') {
    return `<task>Review this pull request using the multi-lens sweep method and return JSON.</task>\n\n${body}`;
  }
  // gemini: plain markdown, no XML framing
  return body;
}
