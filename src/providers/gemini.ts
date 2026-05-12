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
    // -p '' triggers headless mode; the CLI appends that empty string to stdin content.
    // --approval-mode plan = read-only agent mode: no file writes, exits cleanly after responding.
    // Do NOT add -o stream-json: that flag activates the full agentic tool-call loop (file reads,
    // multi-turn planning) which balloons runtime to 5-10 min. Headless + plan mode alone is a
    // single-pass completion that finishes in under a minute.
    const args = ['-p', '', '--approval-mode', 'plan'];
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

    const usage = {
      tokens_in: Math.ceil(prompt.length / 4),
      tokens_out: Math.ceil(stdout.length / 4),
      source: 'estimated' as const,
    };
    const json = extractJsonBlock(stdout);
    const parsed = ReviewOutputSchema.safeParse(json);
    if (!parsed.success) {
      return { summary: '', comments: [], rawResponse: stdout, usage } as ReviewOutput;
    }
    return { ...parsed.data, rawResponse: stdout, usage };
  }
}

function extractJsonBlock(text: string): unknown {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}
