import { request } from 'undici';
import type { Config } from '../config.js';
import type { Forge, PRRef, PRSummary } from './types.js';

export class BitbucketForge implements Forge {
  name = 'bitbucket' as const;
  private auth: string;
  private base: string;
  private username: string;
  private scope: string;

  constructor(cfg: Config) {
    if (!cfg.bitbucket) throw new Error('bitbucket config missing');
    this.auth =
      'Basic ' +
      Buffer.from(`${cfg.bitbucket.username}:${cfg.bitbucket.appPassword}`).toString('base64');
    this.base = cfg.bitbucket.baseUrl.replace(/\/$/, '');
    this.username = cfg.bitbucket.username;
    this.scope = cfg.bitbucket.scope ?? 'author';
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.auth, Accept: 'application/json', ...extra };
  }

  private repoUrl(ref: PRRef, suffix: string): string {
    return `${this.base}/repositories/${ref.owner}/${ref.repo}${suffix}`;
  }

  async listOpenPRs(): Promise<PRSummary[]> {
    const s = this.scope.trim();
    let url: string;
    if (s === 'author') {
      url = `${this.base}/pullrequests/${encodeURIComponent(this.username)}?state=OPEN&pagelen=50`;
    } else if (s === 'reviewer') {
      throw new Error('bitbucket scope=reviewer is not supported yet (no per-user reviewer endpoint). Use scope=author or repo:ws/name.');
    } else if (s.startsWith('repo:')) {
      const [ws, repo] = s.slice(5).split('/');
      if (!ws || !repo) throw new Error(`bad scope: ${s} (expected repo:ws/name)`);
      url = `${this.base}/repositories/${ws}/${repo}/pullrequests?state=OPEN&pagelen=50`;
    } else {
      throw new Error(`unknown bitbucket scope: ${s} (use author|repo:ws/name)`);
    }

    const res = await request(url, { headers: this.headers() });
    if (res.statusCode >= 400) throw new Error(`Bitbucket list ${res.statusCode}: ${await res.body.text()}`);
    const data = (await res.body.json()) as any;
    return (data.values ?? []).map((v: any) => {
      const fullName: string = v.destination?.repository?.full_name ?? '';
      const [owner, repo] = fullName.split('/');
      return {
        ref: { forge: 'bitbucket' as const, owner, repo, number: v.id },
        title: v.title,
        author: v.author?.display_name ?? 'unknown',
        state: v.state,
        sourceBranch: v.source?.branch?.name ?? '',
        destBranch: v.destination?.branch?.name ?? '',
        updatedOn: v.updated_on,
        url: v.links?.html?.href,
      };
    });
  }

  async getDiff(ref: PRRef): Promise<string> {
    const res = await request(this.repoUrl(ref, `/pullrequests/${ref.number}/diff`), {
      headers: this.headers(),
    });
    if (res.statusCode >= 400) throw new Error(`Bitbucket diff ${ref.number} ${res.statusCode}: ${await res.body.text()}`);
    return await res.body.text();
  }

  async postInlineComment(
    ref: PRRef,
    file: string,
    line: number,
    side: 'old' | 'new',
    body: string,
  ): Promise<unknown> {
    const inline = side === 'old' ? { path: file, from: line } : { path: file, to: line };
    const res = await request(this.repoUrl(ref, `/pullrequests/${ref.number}/comments`), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ content: { raw: body }, inline }),
    });
    if (res.statusCode >= 400) throw new Error(`Bitbucket comment ${res.statusCode}: ${await res.body.text()}`);
    return await res.body.json();
  }
}
