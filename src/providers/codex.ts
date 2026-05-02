import { execa } from 'execa';
import { ReviewInput, ReviewOutput, ReviewOutputSchema, Provider, ReviewOpts } from './types.js';
import { buildPrompt } from '../prompt.js';

/**
 * OpenAI Codex CLI provider. Uses `codex exec` for non-interactive runs
 * so we get the full assistant response on stdout in one shot.
 *
 * Token counts aren't reported by `codex exec` (it streams a final summary
 * to stderr in some versions, but the format is unstable), so we fall back
 * to the same chars/4 estimate the gemini provider uses.
 */
export class CodexProvider implements Provider {
  name = 'codex' as const;
  constructor(private bin: string = 'codex') {}

  async isAvailable(): Promise<boolean> {
    try {
      await execa(this.bin, ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async review(input: ReviewInput, opts: ReviewOpts = {}): Promise<ReviewOutput> {
    const prompt = input.prompt && input.prompt.length > 0 ? input.prompt : buildPrompt('codex', input, input.lenses);
    const args = ['exec'];
    if (opts.model) args.push('-m', opts.model);
    // `codex exec` reads the prompt from the final positional arg.
    args.push(prompt);

    const { stdout } = await execa(this.bin, args, {
      timeout: 5 * 60_000,
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
