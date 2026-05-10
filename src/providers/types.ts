import { z } from "zod";

export const CategoryValues = [
  "correctness",
  "security",
  "data_integrity",
  "api_contracts",
  "maintainability",
] as const;
export type Category = (typeof CategoryValues)[number];

export const CommentSchema = z.object({
  file: z.string(),
  line: z.number().int(),
  side: z.enum(["old", "new"]).default("new"),
  severity: z.enum(["info", "suggestion", "concern", "blocker"]),
  category: z.enum(CategoryValues).default("correctness"),
  body: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.6),
});

export const ReviewOutputSchema = z.object({
  summary: z.string(),
  comments: z.array(CommentSchema),
});

export interface UsageInfo {
  tokens_in: number;
  tokens_out: number;
  source: "reported" | "estimated";
}

export type ReviewComment = z.infer<typeof CommentSchema>;

export type ReviewOutput = z.infer<typeof ReviewOutputSchema> & {
  rawResponse: string;
  thinkingText?: string; // populated by Claude thinking models
  usage?: UsageInfo;
};

export interface FileContext {
  path: string;
  language?: string;
  truncated?: boolean;
  content?: string;
}

export interface ExistingComment {
  file: string;
  line: number;
  side: "old" | "new";
  author: string;
  body: string;
}

export interface ReviewInput {
  prTitle: string;
  prDescription: string;
  diff: string;
  changedFiles: FileContext[];
  skills: string;
  prompt: string;
  contextBlock?: string;
  lenses?: import("../lens_detect.js").LensRelevance;
  existingComments?: ExistingComment[];
}

/**
 * Normalized agent event surfaced to UI as the CLI agent runs.
 * - thinking: model "thinking" / reasoning text (chunked)
 * - text:     model assistant text (the user-facing answer chunks)
 * - tool_use: agent decided to call a tool (Read / Bash / Grep / etc.)
 * - tool_result: tool returned (summary + ok flag)
 * - status:   meta-events (started, ended, errored)
 */
export type AgentEvent =
  | { kind: "thinking"; text: string; ts?: number }
  | { kind: "text"; text: string; ts?: number }
  | { kind: "tool_use"; name: string; input?: any; toolId?: string; ts?: number }
  | { kind: "tool_result"; toolId?: string; ok: boolean; summary?: string; ts?: number }
  | { kind: "status"; phase: "started" | "ended" | "error"; detail?: string; ts?: number };

export interface ReviewOpts {
  model?: string;
  onAgentEvent?: (e: AgentEvent) => void;
  /**
   * Logical pipeline stage that this provider call belongs to (e.g. "review", "critic", "triage").
   * Pure metadata — passed through onAgentEvent payloads if the consumer wants to tag them.
   */
  stage?: string;
  /**
   * If aborted, the provider should stop the underlying subprocess and reject
   * with an AbortError. Callers use this to cancel mid-run analyses.
   */
  signal?: AbortSignal;
}

export interface Provider {
  name: "claude" | "gemini" | "codex";
  isAvailable(): Promise<boolean>;
  review(input: ReviewInput, opts?: ReviewOpts): Promise<ReviewOutput>;
}
