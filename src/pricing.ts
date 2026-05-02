/**
 * Static price table (USD per 1M tokens).
 * These are public list prices — actual cost depends on subscription tier
 * and cache hit rate. Treat output as "rough estimate, useful for relative
 * comparison between PRs and stages."
 */
interface Price { in: number; out: number }

const PRICES: Record<string, Price> = {
  // Anthropic (USD / 1M)
  'claude-haiku-4-5-20251001': { in: 1.0,  out: 5.0  },
  'claude-haiku-4-5':          { in: 1.0,  out: 5.0  },
  'claude-sonnet-4-6':         { in: 3.0,  out: 15.0 },
  'claude-opus-4-7':           { in: 15.0, out: 75.0 },
  // Google
  'gemini-2.5-pro':            { in: 1.25, out: 10.0 },
  'gemini-2.5-flash':          { in: 0.30, out: 2.50 },
  // OpenAI (Codex CLI)
  'gpt-5':                     { in: 1.25, out: 10.0 },
  'gpt-5-mini':                { in: 0.25, out: 2.0  },
  'o4-mini':                   { in: 1.10, out: 4.40 },
};

const FALLBACK_BY_PROVIDER: Record<string, Price> = {
  claude:      { in: 3.0,  out: 15.0 },  // assume sonnet
  gemini:      { in: 0.30, out: 2.50 },  // assume flash
  codex:       { in: 1.25, out: 10.0 },  // assume gpt-5-class
};

export function priceFor(provider: string, model?: string): Price {
  if (model && PRICES[model]) return PRICES[model];
  if (model) {
    // partial match (e.g. user passes a versioned name we don't know exactly)
    for (const [k, v] of Object.entries(PRICES)) {
      if (model.startsWith(k) || k.startsWith(model)) return v;
    }
  }
  return FALLBACK_BY_PROVIDER[provider] ?? { in: 1.0, out: 5.0 };
}

export function estimateCost(provider: string, model: string | undefined, tokensIn: number, tokensOut: number): number {
  const p = priceFor(provider, model);
  return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
}

/** Format USD for display: $0.0042  /  $1.23 */
export function fmtUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** Approximate token count from string length. Public APIs charge by tokens; ~4 chars/token is a reasonable rough estimate for English. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
