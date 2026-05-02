import { Provider } from './types.js';
import { ClaudeProvider } from './claude.js';
import { GeminiProvider } from './gemini.js';
import { CodexProvider } from './codex.js';
import type { Config } from '../config.js';

export function getProvider(cfg: Config, override?: string): Provider {
  const name = (override ?? cfg.provider.default) as 'claude' | 'gemini' | 'codex';
  switch (name) {
    case 'claude':
      return new ClaudeProvider(cfg.provider.claudeBin);
    case 'gemini':
      return new GeminiProvider(cfg.provider.geminiBin);
    case 'codex':
      return new CodexProvider(cfg.provider.codexBin);
    default:
      throw new Error(`unknown provider: ${name}`);
  }
}
