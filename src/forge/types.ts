export interface PRRef {
  forge: "github" | "bitbucket";
  owner: string; // workspace on bitbucket, owner/org on github
  repo: string;
  number: number;
}

export interface PRSummary {
  ref: PRRef;
  title: string;
  author: string;
  state: string;
  sourceBranch: string; // may be empty when discovered via search API
  destBranch: string;
  updatedOn: string;
  url?: string; // web URL
  /** Forge-native lifecycle state, normalized: OPEN | DRAFT | MERGED | CLOSED. */
  forgeState?: 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED';
  isDraft?: boolean;
}

export interface PRComment {
  file: string;
  line: number;
  side: "old" | "new";
  author: string;
  body: string;
}

export interface ReviewComment {
  file: string;
  line: number | null;
  author: string;
  body: string;
  resolved: boolean;
  createdAt: string;
}

export interface Forge {
  name: "bitbucket" | "github";
  listOpenPRs(): Promise<PRSummary[]>;
  getDiff(ref: PRRef): Promise<string>;
  getComments(ref: PRRef): Promise<PRComment[]>;
  postInlineComment(
    ref: PRRef,
    file: string,
    line: number,
    side: "old" | "new",
    body: string,
  ): Promise<unknown>;
  postTopLevelComment(ref: PRRef, body: string): Promise<unknown>;
  getMergedPRs(limit: number): Promise<PRSummary[]>;
  getReviewComments(ref: PRRef): Promise<ReviewComment[]>;
  /** Fetch the current state of a single PR (regardless of open/closed/merged).
   *  Used to refresh forge_state for PRs that have dropped off the open-list. */
  getPRSummary(ref: PRRef): Promise<PRSummary | null>;
}

/** Composite id we store in DB and accept on the CLI: `{forge}:{owner}:{repo}:{number}` */
export function refToId(ref: PRRef): string {
  return `${ref.forge === "github" ? "gh" : "bb"}:${ref.owner}:${ref.repo}:${ref.number}`;
}

export function idToRef(id: string): PRRef {
  return parseRef(id);
}

/**
 * Accept either a composite ID (`gh:owner:repo:123`, `bb:ws:repo:456`)
 * or a full web URL (GitHub PR or Bitbucket PR).
 */
export function parseRef(input: string): PRRef {
  // Composite ID form
  const idM = input.match(/^(gh|bb):([^:]+):([^:]+):(\d+)$/);
  if (idM) {
    return { forge: idM[1] === "gh" ? "github" : "bitbucket", owner: idM[2], repo: idM[3], number: Number(idM[4]) };
  }

  // GitHub URL: https://github.com/owner/repo/pull/123
  const ghM = input.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (ghM) return { forge: "github", owner: ghM[1], repo: ghM[2], number: Number(ghM[3]) };

  // Bitbucket URL: https://bitbucket.org/workspace/repo/pull-requests/123
  const bbM = input.match(/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/);
  if (bbM) return { forge: "bitbucket", owner: bbM[1], repo: bbM[2], number: Number(bbM[3]) };

  throw new Error(`Cannot parse PR reference: "${input}"\nExpected: gh|bb:owner:repo:N or a GitHub/Bitbucket PR URL`);
}
