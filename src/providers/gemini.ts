import { execa } from 'execa';
import os from 'node:os';
import { ReviewInput, ReviewOutput, ReviewOutputSchema, Provider, ReviewOpts } from './types.js';
import { buildPrompt } from '../prompt.js';

/** Append platform-specific binary dirs that Node may not inherit from the shell. */
function augmentedPath(): string {
  const base = process.env.PATH ?? '';
  const extra = os.platform() === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin']  // Homebrew (Apple Silicon + Intel)
    : [];
  return [base, ...extra].filter(Boolean).join(':');
}

export class GeminiProvider implements Provider {
  name = 'gemini' as const;
  constructor(private bin: string = 'gemini') {}

  async isAvailable(): Promise<boolean> {
    try {
      await execa(this.bin, ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async review(input: ReviewInput, opts: ReviewOpts = {}): Promise<ReviewOutput> {
    const prompt = input.prompt && input.prompt.length > 0 ? input.prompt : buildPrompt('gemini', input, input.lenses);
    // -p '' triggers headless (non-interactive) mode; stdin carries the actual prompt text.
    // --skip-trust bypasses the Gemini CLI workspace-trust check. Without it the CLI blocks
    // waiting for interactive trust confirmation when run from an untrusted directory (any
    // directory not previously trusted by the user — common on Linux servers).
    // -o json requests a single structured response — no streaming, no multi-turn loop.
    // We deliberately omit --approval-mode: without it the CLI uses default approval mode,
    // which prompts interactively before any tool call. In headless mode that prompt can never
    // be answered, so tool calls are blocked and the model falls back to a direct LLM response.
    // Do NOT add --approval-mode plan: it auto-approves read-only tools (grep, file reads) which
    // triggers the full agentic loop and balloons runtime to 5-10 min.
    const args = ['-p', '', '--skip-trust', '-o', 'json'];
    if (opts.model) args.push('--model', opts.model);

    opts.onAgentEvent?.({ kind: 'status', phase: 'started', ts: Date.now() });
    let stdout: string;
    try {
      const r = await execa(this.bin, args, {
        input: prompt,
        timeout: 10 * 60_000,
        maxBuffer: 50 * 1024 * 1024,
        cancelSignal: opts.signal,
        env: { ...process.env, PATH: augmentedPath() },
      });
      stdout = r.stdout;
    } catch (err: any) {
      opts.onAgentEvent?.({ kind: 'status', phase: 'error', detail: String(err.message ?? err), ts: Date.now() });
      throw err;
    }
    opts.onAgentEvent?.({ kind: 'status', phase: 'ended', ts: Date.now() });
    return parseGeminiJsonOutput(stdout);
  }
}

/** Parse the -o json envelope: {"session_id":…,"response":"<model text>","stats":{…}} */
function parseGeminiJsonOutput(stdout: string): ReviewOutput {
  let text = stdout;
  let usage: ReviewOutput['usage'];

  try {
    const wrapper = JSON.parse(stdout);
    if (wrapper.response && typeof wrapper.response === 'string') {
      text = wrapper.response;
    }
    const model = wrapper.stats?.models ? Object.values(wrapper.stats.models)[0] as any : null;
    const tokens = model?.tokens;
    if (tokens) {
      usage = { tokens_in: tokens.input ?? 0, tokens_out: tokens.candidates ?? 0, source: 'reported' };
    }
  } catch { /* stdout isn't the envelope — fall through to raw parse */ }

  if (!usage) {
    usage = { tokens_in: Math.ceil(stdout.length / 4), tokens_out: 0, source: 'estimated' };
  }

  const json = extractJsonBlock(text);
  const parsed = ReviewOutputSchema.safeParse(json);
  if (!parsed.success) {
    return { summary: '', comments: [], rawResponse: stdout, usage } as ReviewOutput;
  }
  return { ...parsed.data, rawResponse: stdout, usage };
}

function extractJsonBlock(text: string): unknown {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}
