import { execa } from 'execa';
import readline from 'node:readline';
import { ReviewInput, ReviewOutput, ReviewOutputSchema, Provider, ReviewOpts, AgentEvent } from './types.js';
import { buildPrompt } from '../prompt.js';

/**
 * OpenAI Codex CLI provider. Uses `codex exec` for non-interactive runs.
 * When streaming is requested we add `--json` so the CLI emits JSONL agent
 * events (task_started, agent_message, agent_reasoning, exec_command_begin/end,
 * token_count, task_complete). Without streaming we fall back to the plain
 * text mode and parse the final blob.
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
    const useStream = !!opts.onAgentEvent;
    const args = ['exec'];
    if (useStream) args.push('--json');
    if (opts.model) args.push('-m', opts.model);
    args.push(prompt);

    const sub = execa(this.bin, args, {
      timeout: 15 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
      cancelSignal: opts.signal,
    });

    let usageFromStream: { tokens_in: number; tokens_out: number } | undefined;
    let assistantText = '';

    if (useStream && sub.stdout) {
      opts.onAgentEvent!({ kind: 'status', phase: 'started', ts: Date.now() });
      const rl = readline.createInterface({ input: sub.stdout });
      rl.on('line', (line) => {
        try {
          const ev = JSON.parse(line);
          const result = handleCodexEvent(ev, opts.onAgentEvent!);
          if (result?.assistantText) assistantText += result.assistantText;
          if (result?.usage) usageFromStream = result.usage;
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

    // Source of text for JSON extraction:
    //   stream mode → accumulated assistant_message text
    //   plain mode  → raw stdout
    const sourceText = useStream && assistantText ? assistantText : stdout;
    const usage = usageFromStream
      ? { ...usageFromStream, source: 'reported' as const }
      : {
          tokens_in: Math.ceil(prompt.length / 4),
          tokens_out: Math.ceil(stdout.length / 4),
          source: 'estimated' as const,
        };

    let parsedJson: unknown;
    try { parsedJson = extractJsonBlock(sourceText); } catch {
      return { summary: '', comments: [], rawResponse: stdout, usage } as ReviewOutput;
    }
    const parsed = ReviewOutputSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { summary: '', comments: [], rawResponse: stdout, usage } as ReviewOutput;
    }
    return { ...parsed.data, rawResponse: stdout, usage };
  }
}

function handleCodexEvent(
  ev: any,
  emit: (e: AgentEvent) => void,
): { assistantText?: string; usage?: { tokens_in: number; tokens_out: number } } | undefined {
  if (!ev || typeof ev !== 'object') return;
  const ts = Date.now();
  const type: string = ev.type ?? '';

  // ── v0.130+ event format ──────────────────────────────────────────────────
  // item.completed wraps all content items (messages, tool calls, outputs).
  if (type === 'item.completed') {
    const item = ev.item;
    if (!item) return;
    switch (item.type) {
      case 'agent_message':
      case 'assistant_message':
      case 'message': {
        const text = item.text ?? item.content ?? item.message ?? '';
        if (text) emit({ kind: 'text', text: String(text), ts });
        return { assistantText: String(text) };
      }
      case 'reasoning': {
        const text = item.text ?? item.content ?? '';
        if (text) emit({ kind: 'thinking', text: String(text), ts });
        return;
      }
      case 'function_call':
      case 'tool_call': {
        emit({ kind: 'tool_use', name: String(item.name ?? item.tool ?? '?'), input: item.arguments ?? item.input, toolId: item.call_id ?? item.id, ts });
        return;
      }
      case 'function_call_output':
      case 'tool_result': {
        const out = item.output ?? item.content ?? '';
        emit({ kind: 'tool_result', toolId: item.call_id ?? item.id, ok: !item.error, summary: typeof out === 'string' ? out.slice(0, 400) : '', ts });
        return;
      }
    }
    return;
  }

  if (type === 'turn.completed') {
    const u = ev.usage;
    if (u) {
      const tIn = u.input_tokens ?? u.prompt_tokens ?? 0;
      const tOut = u.output_tokens ?? u.completion_tokens ?? 0;
      if (tIn || tOut) return { usage: { tokens_in: tIn, tokens_out: tOut } };
    }
    return;
  }

  // ── legacy event format (pre-v0.130) ─────────────────────────────────────
  const msg = ev.msg ?? ev;
  switch (type) {
    case 'agent_message':
    case 'assistant_message': {
      const text = msg.message ?? msg.text ?? msg.content ?? '';
      if (text) emit({ kind: 'text', text: String(text), ts });
      return { assistantText: String(text) };
    }
    case 'agent_reasoning':
    case 'reasoning': {
      const text = msg.text ?? msg.content ?? '';
      if (text) emit({ kind: 'thinking', text: String(text), ts });
      return;
    }
    case 'exec_command_begin':
    case 'tool_call':
    case 'tool_use': {
      const name = type === 'exec_command_begin' ? 'shell' : (msg.name ?? msg.tool ?? '?');
      emit({ kind: 'tool_use', name: String(name), input: msg.command ?? msg.input ?? msg.args, toolId: msg.call_id ?? msg.id, ts });
      return;
    }
    case 'exec_command_end':
    case 'tool_result': {
      const ok = type === 'exec_command_end' ? (msg.exit_code === 0) : (msg.status !== 'error' && !msg.is_error);
      const out = msg.stdout ?? msg.output ?? msg.content ?? '';
      emit({ kind: 'tool_result', toolId: msg.call_id ?? msg.id, ok, summary: typeof out === 'string' ? out.slice(0, 400) : '', ts });
      return;
    }
    case 'token_count':
    case 'usage': {
      const tIn = msg.input_tokens ?? msg.prompt_tokens ?? 0;
      const tOut = msg.output_tokens ?? msg.completion_tokens ?? 0;
      if (tIn || tOut) return { usage: { tokens_in: tIn, tokens_out: tOut } };
      return;
    }
    case 'task_complete': {
      const last = msg.last_agent_message;
      if (last) return { assistantText: String(last) };
      return;
    }
  }
  return;
}

function extractJsonBlock(text: string): unknown {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}
