import { execa } from 'execa';
import readline from 'node:readline';
import { ReviewInput, ReviewOutput, ReviewOutputSchema, Provider, ReviewOpts, AgentEvent } from './types.js';
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
    const useStream = !!opts.onAgentEvent;
    // -p '' triggers headless mode; the CLI appends that empty string to stdin content.
    // --approval-mode plan = read-only agent mode: no file writes, exits cleanly after responding.
    const args = ['-p', '', '--approval-mode', 'plan'];
    if (useStream) args.push('-o', 'stream-json');
    if (opts.model) args.push('--model', opts.model);

    const sub = execa(this.bin, args, {
      input: prompt,
      timeout: 10 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
      cancelSignal: opts.signal,
    });

    if (useStream && sub.stdout) {
      opts.onAgentEvent!({ kind: 'status', phase: 'started', ts: Date.now() });
      const rl = readline.createInterface({ input: sub.stdout });
      rl.on('line', (line) => {
        try {
          const ev = JSON.parse(line);
          handleGeminiEvent(ev, opts.onAgentEvent!);
        } catch { /* ignore non-JSON */ }
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

    if (useStream) return parseGeminiStreamJson(stdout, prompt);

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

function handleGeminiEvent(ev: any, emit: (e: AgentEvent) => void) {
  if (!ev || typeof ev !== 'object') return;
  const ts = Date.now();
  switch (ev.type) {
    case 'message':
      if (ev.role === 'assistant' && typeof ev.content === 'string' && ev.content.length) {
        emit({ kind: 'text', text: ev.content, ts });
      }
      break;
    case 'thinking':
      if (ev.content) emit({ kind: 'thinking', text: String(ev.content), ts });
      break;
    case 'tool_call':
    case 'tool_use':
      emit({ kind: 'tool_use', name: String(ev.name ?? ev.tool ?? '?'), input: ev.input ?? ev.args, toolId: ev.id ?? ev.call_id, ts });
      break;
    case 'tool_result':
      emit({
        kind: 'tool_result',
        toolId: ev.id ?? ev.call_id ?? ev.tool_call_id,
        ok: ev.status !== 'error' && !ev.is_error,
        summary: typeof ev.content === 'string' ? ev.content.slice(0, 400) : (typeof ev.output === 'string' ? ev.output.slice(0, 400) : ''),
        ts,
      });
      break;
    // ignore init, result here — final usage comes from parseGeminiStreamJson
  }
}

function parseGeminiStreamJson(stdout: string, prompt: string): ReviewOutput {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  let resultEv: any = null;
  const assistantPieces: string[] = [];
  for (const line of lines) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') resultEv = ev;
    else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
      assistantPieces.push(ev.content);
    }
  }
  const text = assistantPieces.join('');
  const stats = resultEv?.stats;
  const usage = stats
    ? { tokens_in: stats.input_tokens ?? stats.input ?? 0, tokens_out: stats.output_tokens ?? 0, source: 'reported' as const }
    : { tokens_in: Math.ceil(prompt.length / 4), tokens_out: Math.ceil(text.length / 4), source: 'estimated' as const };
  let parsedJson: unknown;
  try { parsedJson = extractJsonBlock(text); } catch {
    return { summary: '', comments: [], rawResponse: stdout, usage } as ReviewOutput;
  }
  const parsed = ReviewOutputSchema.safeParse(parsedJson);
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
