import { execa } from 'execa';
import { ReviewInput, ReviewOutput, ReviewOutputSchema, Provider, ReviewOpts } from './types.js';
import { buildPrompt } from '../prompt.js';

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
    // Pass prompt via stdin to avoid OS ARG_MAX limits for large diffs.
    // -p '' triggers headless mode; the CLI appends that empty string to stdin content.
    // --approval-mode plan = read-only agent mode: no file writes, exits cleanly after responding.
    const args = ['-p', '', '--approval-mode', 'plan'];
    if (opts.model) args.push('--model', opts.model);
    const { stdout } = await execa(this.bin, args, {
      input: prompt,
      timeout: 10 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
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
