import { execa } from 'execa';
import { ReviewInput, ReviewOutput, ReviewOutputSchema, Provider, ReviewOpts } from './types.js';
import { buildPrompt } from '../prompt.js';

export class ClaudeProvider implements Provider {
  name = 'claude' as const;
  constructor(private bin: string = 'claude') {}

  async isAvailable(): Promise<boolean> {
    try {
      await execa(this.bin, ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async review(input: ReviewInput, opts: ReviewOpts = {}): Promise<ReviewOutput> {
    const prompt = input.prompt && input.prompt.length > 0 ? input.prompt : buildPrompt('claude', input, input.lenses);
    const args = ['-p', '--output-format', 'json'];
    if (opts.model) args.push('--model', opts.model);
    const { stdout } = await execa(this.bin, args, {
      input: prompt,
      timeout: 5 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return parseClaudeJson(stdout);
  }
}

function parseClaudeJson(stdout: string): ReviewOutput & { thinkingText?: string } {
  let outer: any;
  try {
    outer = JSON.parse(stdout);
  } catch {
    throw new Error('claude returned non-JSON. raw head: ' + stdout.slice(0, 400));
  }

  // Claude thinking models return a content array with {type:'thinking'} and {type:'text'} blocks.
  // Non-thinking models return a flat result/response/output string.
  let text = '';
  let thinkingText = '';

  if (Array.isArray(outer.content)) {
    for (const block of outer.content) {
      if (block.type === 'thinking' && block.thinking) {
        thinkingText += block.thinking + '\n\n';
      } else if (block.type === 'text' && block.text) {
        text += block.text;
      }
    }
  }

  if (!text) {
    text = outer.result ?? outer.response ?? outer.output ?? '';
  }

  const usage = extractClaudeUsage(outer);

  const json = extractJsonBlock(text);
  const parsed = ReviewOutputSchema.safeParse(json);
  if (!parsed.success) {
    return { summary: '', comments: [], rawResponse: stdout, thinkingText: thinkingText.trim() || undefined, usage } as ReviewOutput;
  }
  return { ...parsed.data, rawResponse: stdout, thinkingText: thinkingText.trim() || undefined, usage };
}

function extractClaudeUsage(outer: any): { tokens_in: number; tokens_out: number; source: 'reported' } | undefined {
  // Claude CLI reports usage in `usage` (newer) or in metadata fields. Includes
  // input_tokens, output_tokens, and optionally cache_creation_input_tokens / cache_read_input_tokens.
  const u = outer?.usage ?? outer?.message?.usage;
  if (!u) return undefined;
  const tIn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const tOut = u.output_tokens ?? 0;
  if (!tIn && !tOut) return undefined;
  return { tokens_in: tIn, tokens_out: tOut, source: 'reported' };
}

function extractJsonBlock(text: string): unknown {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}
