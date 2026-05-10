import { execa } from 'execa';
import readline from 'node:readline';
import { ReviewInput, ReviewOutput, ReviewOutputSchema, Provider, ReviewOpts, AgentEvent } from './types.js';
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

    // When a consumer wants live agent events, use stream-json so we can emit them
    // turn-by-turn. Otherwise stay on the simpler --output-format json path that
    // returns one final blob — same code path as before for non-streaming callers.
    const useStream = !!opts.onAgentEvent;
    const args = ['-p'];
    if (useStream) args.push('--output-format', 'stream-json', '--verbose');
    else args.push('--output-format', 'json');
    if (opts.model) args.push('--model', opts.model);

    const sub = execa(this.bin, args, {
      input: prompt,
      timeout: 5 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
      cancelSignal: opts.signal,
    });

    if (useStream && sub.stdout) {
      opts.onAgentEvent!({ kind: 'status', phase: 'started', ts: Date.now() });
      // Track tool_use blocks across a single message so tool_result events can reference them.
      const rl = readline.createInterface({ input: sub.stdout });
      const lineBuf: string[] = [];
      rl.on('line', (line) => {
        lineBuf.push(line);
        if (lineBuf.length > 4000) lineBuf.shift(); // cap memory; final result still parseable from stdout
        try {
          const ev = JSON.parse(line);
          handleClaudeEvent(ev, opts.onAgentEvent!);
        } catch {
          // partial / non-JSON line — ignore
        }
      });
    }

    let stdout: string;
    try {
      const r = await sub;
      stdout = r.stdout;
    } catch (err: any) {
      if (useStream) opts.onAgentEvent!({ kind: 'status', phase: 'error', detail: String(err.message ?? err), ts: Date.now() });
      throw err;
    }
    if (useStream) opts.onAgentEvent!({ kind: 'status', phase: 'ended', ts: Date.now() });

    return useStream ? parseClaudeStreamJson(stdout) : parseClaudeJson(stdout);
  }
}

function handleClaudeEvent(ev: any, emit: (e: AgentEvent) => void) {
  if (!ev || typeof ev !== 'object') return;
  const ts = Date.now();
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        emit({ kind: 'thinking', text: String(block.thinking), ts });
      } else if (block.type === 'text' && block.text) {
        emit({ kind: 'text', text: String(block.text), ts });
      } else if (block.type === 'tool_use') {
        emit({ kind: 'tool_use', name: String(block.name ?? '?'), input: block.input, toolId: block.id, ts });
      }
    }
  } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        const raw = block.content;
        let summary: string;
        if (typeof raw === 'string') summary = raw;
        else if (Array.isArray(raw)) summary = raw.map((b: any) => b?.text ?? '').join('').slice(0, 400);
        else summary = '';
        emit({ kind: 'tool_result', toolId: block.tool_use_id, ok: !block.is_error, summary: summary.slice(0, 400), ts });
      }
    }
  }
}

/**
 * Parse the final stdout blob from --output-format stream-json. We just take the
 * last `result` event line and pull `result` (assembled assistant text) and `usage`.
 */
function parseClaudeStreamJson(stdout: string): ReviewOutput {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  let resultEv: any = null;
  const thinkingPieces: string[] = [];
  const textPieces: string[] = [];
  for (const line of lines) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') resultEv = ev;
    else if (ev.type === 'assistant' && ev.message?.content) {
      for (const b of ev.message.content) {
        if (b.type === 'thinking' && b.thinking) thinkingPieces.push(b.thinking);
        if (b.type === 'text' && b.text) textPieces.push(b.text);
      }
    }
  }
  const text = resultEv?.result ?? textPieces.join('');
  const thinkingText = thinkingPieces.join('\n\n').trim() || undefined;
  const usage = resultEv?.usage ? extractUsageFromResult(resultEv.usage) : undefined;
  let parsedJson: unknown;
  try { parsedJson = extractJsonBlock(text); } catch {
    return { summary: '', comments: [], rawResponse: stdout, thinkingText, usage } as ReviewOutput;
  }
  const parsed = ReviewOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { summary: '', comments: [], rawResponse: stdout, thinkingText, usage } as ReviewOutput;
  }
  return { ...parsed.data, rawResponse: stdout, thinkingText, usage };
}

function extractUsageFromResult(u: any): { tokens_in: number; tokens_out: number; source: 'reported' } | undefined {
  const tIn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const tOut = u.output_tokens ?? 0;
  if (!tIn && !tOut) return undefined;
  return { tokens_in: tIn, tokens_out: tOut, source: 'reported' };
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
