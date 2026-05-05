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

export interface ReviewOpts {
  model?: string;
}

export interface Provider {
  name: "claude" | "gemini" | "codex";
  isAvailable(): Promise<boolean>;
  review(input: ReviewInput, opts?: ReviewOpts): Promise<ReviewOutput>;
}
