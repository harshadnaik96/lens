export interface PRRef {
  forge: 'github' | 'bitbucket';
  owner: string;   // workspace on bitbucket, owner/org on github
  repo: string;
  number: number;
}

export interface PRSummary {
  ref: PRRef;
  title: string;
  author: string;
  state: string;
  sourceBranch: string;   // may be empty when discovered via search API
  destBranch: string;
  updatedOn: string;
  url?: string;           // web URL
}

export interface Forge {
  name: 'bitbucket' | 'github';
  listOpenPRs(): Promise<PRSummary[]>;
  getDiff(ref: PRRef): Promise<string>;
  postInlineComment(
    ref: PRRef,
    file: string,
    line: number,
    side: 'old' | 'new',
    body: string,
  ): Promise<unknown>;
}

/** Composite id we store in DB and accept on the CLI: `{forge}:{owner}:{repo}:{number}` */
export function refToId(ref: PRRef): string {
  return `${ref.forge === 'github' ? 'gh' : 'bb'}:${ref.owner}:${ref.repo}:${ref.number}`;
}

export function idToRef(id: string): PRRef {
  const m = id.match(/^(gh|bb):([^:]+):([^:]+):(\d+)$/);
  if (!m) throw new Error(`bad PR id: ${id} (expected gh|bb:owner:repo:number)`);
  return {
    forge: m[1] === 'gh' ? 'github' : 'bitbucket',
    owner: m[2],
    repo: m[3],
    number: Number(m[4]),
  };
}
