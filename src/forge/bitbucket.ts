import { request } from "undici";
import type { Config } from "../config.js";
import type { Forge, PRComment, PRRef, PRSummary, ReviewComment } from "./types.js";

export class BitbucketForge implements Forge {
  name = "bitbucket" as const;
  private auth: string;
  private base: string;
  private username: string;
  private userUuid: string | undefined;
  private workspace: string;
  private scope: string;

  constructor(cfg: Config) {
    if (!cfg.bitbucket) throw new Error("bitbucket config missing");
    const bb = cfg.bitbucket;
    if (bb.apiToken) {
      if (!bb.email)
        throw new Error("bitbucket.email is required when using apiToken");
      this.auth =
        "Basic " + Buffer.from(`${bb.email}:${bb.apiToken}`).toString("base64");
    } else if (bb.appPassword) {
      this.auth =
        "Basic " +
        Buffer.from(`${bb.username}:${bb.appPassword}`).toString("base64");
    } else {
      throw new Error(
        "bitbucket config requires apiToken (or legacy appPassword)",
      );
    }
    this.base = bb.baseUrl.replace(/\/$/, "");
    this.username = bb.username;
    this.userUuid = bb.userUuid;
    this.workspace = bb.workspace ?? bb.username;
    this.scope = bb.scope ?? "author";
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.auth, Accept: "application/json", ...extra };
  }

  private repoUrl(ref: PRRef, suffix: string): string {
    return `${this.base}/repositories/${ref.owner}/${ref.repo}${suffix}`;
  }

  private async getCurrentUserUuid(): Promise<string> {
    if (this.userUuid) return this.userUuid;
    const res = await request(`${this.base}/user`, { headers: this.headers() });
    if (res.statusCode >= 400)
      throw new Error(
        `Bitbucket /user ${res.statusCode}: ${await res.body.text()}`,
      );
    const data = (await res.body.json()) as any;
    return data.uuid;
  }

  private async fetchAllPages(url: string): Promise<any[]> {
    const results: any[] = [];
    let next: string | null = url;
    while (next) {
      const res = await request(next, { headers: this.headers() });
      if (res.statusCode >= 400)
        throw new Error(
          `Bitbucket list ${res.statusCode}: ${await res.body.text()}`,
        );
      const data = (await res.body.json()) as any;
      results.push(...(data.values ?? []));
      next = data.next ?? null;
    }
    return results;
  }

  private async fetchReviewerPRs(uuid: string): Promise<any[]> {
    const reposUrl = `${this.base}/repositories/${encodeURIComponent(this.workspace)}?pagelen=100&fields=values.slug,next`;
    const repos = await this.fetchAllPages(reposUrl);
    const q = encodeURIComponent(`reviewers.uuid="${uuid}" AND state="OPEN"`);
    const allPRs: any[] = [];
    await Promise.all(
      repos.map(async (r: any) => {
        const url = `${this.base}/repositories/${encodeURIComponent(this.workspace)}/${r.slug}/pullrequests?q=${q}&pagelen=50`;
        const prs = await this.fetchAllPages(url);
        allPRs.push(...prs);
      }),
    );
    return allPRs;
  }

  async listOpenPRs(): Promise<PRSummary[]> {
    const s = this.scope.trim();
    let values: any[];

    if (s === "author") {
      const url = `${this.base}/workspaces/${encodeURIComponent(this.workspace)}/pullrequests/${encodeURIComponent(this.username)}?state=OPEN&pagelen=50`;
      values = await this.fetchAllPages(url);
    } else if (s === "reviewer") {
      const uuid = await this.getCurrentUserUuid();
      values = await this.fetchReviewerPRs(uuid);
    } else if (s.startsWith("repo:")) {
      const [ws, repo] = s.slice(5).split("/");
      if (!ws || !repo)
        throw new Error(`bad scope: ${s} (expected repo:ws/name)`);
      const url = `${this.base}/repositories/${ws}/${repo}/pullrequests?state=OPEN&pagelen=50`;
      values = await this.fetchAllPages(url);
    } else {
      throw new Error(
        `unknown bitbucket scope: ${s} (use author|reviewer|repo:ws/name)`,
      );
    }

    return values.map((v: any) => {
      const fullName: string = v.destination?.repository?.full_name ?? "";
      const [owner, repo] = fullName.split("/");
      return {
        ref: { forge: "bitbucket" as const, owner, repo, number: v.id },
        title: v.title,
        author: v.author?.display_name ?? "unknown",
        state: v.state,
        sourceBranch: v.source?.branch?.name ?? "",
        destBranch: v.destination?.branch?.name ?? "",
        updatedOn: v.updated_on,
        url: v.links?.html?.href,
      };
    });
  }

  async getDiff(ref: PRRef): Promise<string> {
    let url = this.repoUrl(ref, `/pullrequests/${ref.number}/diff`);
    // Follow up to 3 redirects (Bitbucket returns 302 for diff downloads)
    for (let i = 0; i < 3; i++) {
      const res = await request(url, {
        headers: this.headers(),
        maxRedirections: 0,
      });
      if (
        res.statusCode === 301 ||
        res.statusCode === 302 ||
        res.statusCode === 307 ||
        res.statusCode === 308
      ) {
        await res.body.dump();
        url = res.headers.location as string;
        continue;
      }
      if (res.statusCode >= 400)
        throw new Error(
          `Bitbucket diff ${ref.number} ${res.statusCode}: ${await res.body.text()}`,
        );
      return await res.body.text();
    }
    throw new Error(`Bitbucket diff ${ref.number}: too many redirects`);
  }

  async getComments(ref: PRRef): Promise<PRComment[]> {
    const url = this.repoUrl(
      ref,
      `/pullrequests/${ref.number}/comments?pagelen=100`,
    );
    const data = await this.fetchAllPages(url);
    return data
      .filter((c: any) => c.inline)
      .map((c: any) => ({
        file: c.inline.path ?? "",
        line: c.inline.to ?? c.inline.from ?? 0,
        side: (c.inline.to != null ? "new" : "old") as "old" | "new",
        author: c.author?.display_name ?? "unknown",
        body: c.content?.raw ?? "",
      }))
      .filter((c) => c.file && c.line > 0);
  }

  async postInlineComment(
    ref: PRRef,
    file: string,
    line: number,
    side: "old" | "new",
    body: string,
  ): Promise<unknown> {
    const inline =
      side === "old" ? { path: file, from: line } : { path: file, to: line };
    const res = await request(
      this.repoUrl(ref, `/pullrequests/${ref.number}/comments`),
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ content: { raw: body }, inline }),
      },
    );
    if (res.statusCode >= 400)
      throw new Error(
        `Bitbucket comment ${res.statusCode}: ${await res.body.text()}`,
      );
    return await res.body.json();
  }

  async postTopLevelComment(ref: PRRef, body: string): Promise<unknown> {
    const res = await request(this.repoUrl(ref, `/pullrequests/${ref.number}/comments`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content: { raw: body } }),
    });
    if (res.statusCode >= 400) throw new Error(`Bitbucket postTopLevelComment ${res.statusCode}: ${await res.body.text()}`);
    return res.body.json();
  }

  async getMergedPRs(limit: number): Promise<PRSummary[]> {
    const allPRs: PRSummary[] = [];
    const reposRes = await request(`${this.base}/repositories/${this.workspace}?pagelen=50`, { headers: this.headers() });
    if (reposRes.statusCode >= 400) return [];
    const reposData = (await reposRes.body.json()) as any;
    const repos = (reposData.values ?? []).slice(0, 10); // cap at 10 repos
    for (const repo of repos) {
      const slug = repo.slug;
      const prRes = await request(`${this.base}/repositories/${this.workspace}/${slug}/pullrequests?state=MERGED&pagelen=${Math.ceil(limit / repos.length)}`, { headers: this.headers() });
      if (prRes.statusCode >= 400) continue;
      const prData = (await prRes.body.json()) as any;
      for (const p of (prData.values ?? [])) {
        allPRs.push({ ref: { forge: 'bitbucket' as const, owner: this.workspace, repo: slug, number: p.id }, title: p.title, author: p.author?.display_name ?? 'unknown', state: 'merged', sourceBranch: p.source?.branch?.name ?? '', destBranch: p.destination?.branch?.name ?? '', updatedOn: p.updated_on, url: p.links?.html?.href });
      }
      if (allPRs.length >= limit) break;
    }
    return allPRs.slice(0, limit);
  }

  async getReviewComments(ref: PRRef): Promise<ReviewComment[]> {
    const res = await request(this.repoUrl(ref, `/pullrequests/${ref.number}/comments?pagelen=100`), { headers: this.headers() });
    if (res.statusCode >= 400) return [];
    const data = (await res.body.json()) as any;
    return (data.values ?? [])
      .filter((c: any) => !c.deleted && c.inline)
      .map((c: any) => ({
        file: c.inline?.path ?? '',
        line: c.inline?.to ?? null,
        author: c.author?.display_name ?? 'unknown',
        body: c.content?.raw ?? '',
        resolved: false,
        createdAt: c.created_on ?? '',
      }));
  }
}
