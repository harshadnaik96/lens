import path from 'node:path';
import { z } from 'zod';
import type { Provider, UsageInfo } from './providers/types.js';
import type { FileDiff } from './diff_split.js';

export type Decision = 'skip' | 'shallow' | 'deep';

export interface TriageItem {
  path: string;
  decision: Decision;
  reason: string;
  source: 'heuristic' | 'model';
}

export interface TriageResult {
  items: TriageItem[];
  usage?: UsageInfo;
}

const SKIP_EXTS = new Set([
  '.lock', '.sum', '.snap', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.map', '.min.js', '.min.css',
]);
const SKIP_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock',
  'poetry.lock', 'composer.lock', 'Gemfile.lock', 'mix.lock',
]);
const SKIP_DIRS = ['/node_modules/', '/vendor/', '/dist/', '/build/', '/.next/', '/coverage/', '/__generated__/'];
const DOC_EXTS = new Set(['.md', '.mdx', '.rst', '.txt']);

export function heuristicTriage(file: FileDiff): TriageItem | null {
  const p = file.path;
  const base = path.basename(p);
  const ext = path.extname(p);
  if (file.isBinary) return { path: p, decision: 'skip', reason: 'binary file', source: 'heuristic' };
  if (file.isDelete) return { path: p, decision: 'shallow', reason: 'deletion only', source: 'heuristic' };
  if (SKIP_FILES.has(base)) return { path: p, decision: 'skip', reason: 'lockfile', source: 'heuristic' };
  if (SKIP_EXTS.has(ext)) return { path: p, decision: 'skip', reason: `extension ${ext}`, source: 'heuristic' };
  if (SKIP_DIRS.some((d) => ('/' + p).includes(d))) {
    return { path: p, decision: 'skip', reason: 'generated/vendored path', source: 'heuristic' };
  }
  if (DOC_EXTS.has(ext)) return { path: p, decision: 'shallow', reason: 'docs', source: 'heuristic' };
  if (file.added + file.removed <= 3) {
    return { path: p, decision: 'shallow', reason: 'tiny change', source: 'heuristic' };
  }
  if (file.added + file.removed >= 200) {
    return { path: p, decision: 'deep', reason: 'large change', source: 'heuristic' };
  }
  return null;
}

const TriageSchema = z.object({
  items: z.array(z.object({
    path: z.string(),
    decision: z.enum(['skip', 'shallow', 'deep']),
    reason: z.string(),
  })),
});

export async function triage(provider: Provider, files: FileDiff[], model?: string): Promise<TriageResult> {
  const decided: TriageItem[] = [];
  const undecided: FileDiff[] = [];
  for (const f of files) {
    const h = heuristicTriage(f);
    if (h) decided.push(h);
    else undecided.push(f);
  }
  if (undecided.length === 0) return { items: decided };

  const summary = undecided.map((f) =>
    `- ${f.path}  (+${f.added}/-${f.removed})  hunks:\n${f.body.split('\n').slice(0, 30).join('\n')}`
  ).join('\n\n');

  const prompt = `You are a triage step for a PR review. Classify each file by review risk.
Use ONLY these decisions:
- "deep": real logic change, needs careful review (business logic, security, data, control flow)
- "shallow": low risk, scan only (config tweak, comment, simple rename, minor refactor)
- "skip": no value reviewing (autoformat, generated, trivial whitespace)

Output ONLY this JSON:
{"items":[{"path":"...","decision":"deep|shallow|skip","reason":"<=80 chars"}]}

Files (path + first hunks):
${summary}`;

  let output;
  try {
    output = await provider.review({
      prTitle: 'triage', prDescription: '', diff: '', changedFiles: [], skills: '', prompt,
    }, { model });
  } catch {
    return { items: [...decided, ...undecided.map((f) => ({
      path: f.path, decision: 'deep' as Decision, reason: 'triage failed; default deep', source: 'heuristic' as const,
    }))] };
  }

  // rawResponse is the full provider envelope (e.g. Claude's outer JSON).
  // We try to extract the triage {"items":[...]} from multiple places.
  const raw = output.rawResponse ?? '';

  // 1. Try to parse the inner text content from provider envelopes
  let triageText = '';
  try {
    const outer = JSON.parse(raw);
    if (Array.isArray(outer.content)) {
      // Claude thinking model content array
      triageText = outer.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    } else {
      triageText = outer.result ?? outer.response ?? outer.output ?? raw;
    }
  } catch {
    // Not JSON (Gemini returns plain text stdout)
    triageText = raw;
  }

  const json = safeExtract(triageText) ?? safeExtract(raw);
  if (!json) {
    return { items: [...decided, ...undecided.map((f) => ({
      path: f.path, decision: 'deep' as Decision, reason: 'triage parse failed', source: 'heuristic' as const,
    }))], usage: output.usage };
  }
  const parsed = TriageSchema.safeParse(json);
  if (!parsed.success) {
    return { items: [...decided, ...undecided.map((f) => ({
      path: f.path, decision: 'deep' as Decision, reason: 'triage schema invalid', source: 'heuristic' as const,
    }))], usage: output.usage };
  }
  const byPath = new Map(parsed.data.items.map((i) => [i.path, i]));
  for (const f of undecided) {
    const item = byPath.get(f.path);
    decided.push(item
      ? { path: f.path, decision: item.decision, reason: item.reason, source: 'model' }
      : { path: f.path, decision: 'deep', reason: 'unclassified by model', source: 'heuristic' });
  }
  return { items: decided, usage: output.usage };
}

function safeExtract(text: string): unknown | null {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}
