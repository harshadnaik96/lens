import { request } from 'undici';
import { execa } from 'execa';
import type { Config } from '../config.js';
import type { Forge, PRRef, PRSummary } from './types.js';

export class GitHubForge implements Forge {
  name = 'github' as const;
  private base: string;
  private scope: string;
  private tokenP: Promise<string>;
  private headSha = new Map<string, string>();

  constructor(cfg: Config) {
    if (!cfg.github) throw new Error('github config missing');
    this.base = (cfg.github.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.scope = cfg.github.scope ?? 'reviewer';
    this.tokenP = resolveToken(cfg.github.token);
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.tokenP;
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Lens',
      ...extra,
    };
  }

  private repoUrl(ref: PRRef, suffix: string): string {
    return `${this.base}/repos/${ref.owner}/${ref.repo}${suffix}`;
  }

  async listOpenPRs(): Promise<PRSummary[]> {
    const q = scopeToQuery(this.scope);
    if (q.kind === 'single-repo') {
      // use the per-repo pulls endpoint — gives us branch info for free
      const res = await request(`${this.base}/repos/${q.owner}/${q.repo}/pulls?state=open&per_page=50`, {
        headers: await this.headers(),
      });
      if (res.statusCode >= 400) throw new Error(`GitHub list ${res.statusCode}: ${await res.body.text()}`);
      const data = (await res.body.json()) as any[];
      return data.map((p) => ({
        ref: { forge: 'github' as const, owner: q.owner, repo: q.repo, number: p.number },
        title: p.title,
        author: p.user?.login ?? 'unknown',
        state: p.state,
        sourceBranch: p.head?.ref ?? '',
        destBranch: p.base?.ref ?? '',
        updatedOn: p.updated_at,
        url: p.html_url,
      }));
    }

    // search/issues — covers reviewer / author / org / user scopes across all repos
    const url = `${this.base}/search/issues?q=${encodeURIComponent(q.q)}&per_page=50`;
    const res = await request(url, { headers: await this.headers() });
    if (res.statusCode >= 400) throw new Error(`GitHub search ${res.statusCode}: ${await res.body.text()}`);
    const data = (await res.body.json()) as any;
    return (data.items ?? []).map((p: any) => {
      const m = (p.repository_url as string).match(/\/repos\/([^/]+)\/([^/]+)$/);
      const owner = m?.[1] ?? '?';
      const repo = m?.[2] ?? '?';
      return {
        ref: { forge: 'github' as const, owner, repo, number: p.number },
        title: p.title,
        author: p.user?.login ?? 'unknown',
        state: p.state,
        sourceBranch: '',
        destBranch: '',
        updatedOn: p.updated_at,
        url: p.html_url,
      };
    });
  }

  async getDiff(ref: PRRef): Promise<string> {
    const detailRes = await request(this.repoUrl(ref, `/pulls/${ref.number}`), { headers: await this.headers() });
    if (detailRes.statusCode >= 400) throw new Error(`GitHub PR ${ref.number} ${detailRes.statusCode}: ${await detailRes.body.text()}`);
    const detail = (await detailRes.body.json()) as any;
    if (detail?.head?.sha) this.headSha.set(shaKey(ref), detail.head.sha);

    const res = await request(this.repoUrl(ref, `/pulls/${ref.number}`), {
      headers: await this.headers({ Accept: 'application/vnd.github.v3.diff' }),
    });
    if (res.statusCode >= 400) throw new Error(`GitHub diff ${ref.number} ${res.statusCode}: ${await res.body.text()}`);
    return await res.body.text();
  }

  async postInlineComment(
    ref: PRRef,
    file: string,
    line: number,
    side: 'old' | 'new',
    body: string,
  ): Promise<unknown> {
    let sha = this.headSha.get(shaKey(ref));
    if (!sha) {
      const r = await request(this.repoUrl(ref, `/pulls/${ref.number}`), { headers: await this.headers() });
      if (r.statusCode >= 400) throw new Error(`GitHub PR fetch ${r.statusCode}: ${await r.body.text()}`);
      const d = (await r.body.json()) as any;
      sha = d.head.sha;
      this.headSha.set(shaKey(ref), sha!);
    }
    const payload = { body, commit_id: sha, path: file, line, side: side === 'old' ? 'LEFT' : 'RIGHT' };
    const res = await request(this.repoUrl(ref, `/pulls/${ref.number}/comments`), {
      method: 'POST',
      headers: await this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (res.statusCode >= 400) throw new Error(`GitHub comment ${res.statusCode}: ${await res.body.text()}`);
    return await res.body.json();
  }
}

function shaKey(ref: PRRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

type ScopeQuery =
  | { kind: 'search'; q: string }
  | { kind: 'single-repo'; owner: string; repo: string };

function scopeToQuery(scope: string): ScopeQuery {
  const s = scope.trim();
  if (s === 'reviewer') return { kind: 'search', q: 'is:pr is:open review-requested:@me' };
  if (s === 'author')   return { kind: 'search', q: 'is:pr is:open author:@me' };
  if (s.startsWith('org:'))  return { kind: 'search', q: `is:pr is:open org:${s.slice(4)}` };
  if (s.startsWith('user:')) return { kind: 'search', q: `is:pr is:open user:${s.slice(5)}` };
  if (s.startsWith('repo:')) {
    const [owner, repo] = s.slice(5).split('/');
    if (!owner || !repo) throw new Error(`bad scope: ${s} (expected repo:owner/name)`);
    return { kind: 'single-repo', owner, repo };
  }
  throw new Error(`unknown github scope: ${s} (use reviewer|author|org:NAME|user:NAME|repo:owner/name)`);
}

async function resolveToken(configured?: string): Promise<string> {
  if (configured && configured.trim() && !configured.startsWith('YOUR_')) return configured.trim();
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env && env.trim()) return env.trim();
  try {
    const { stdout } = await execa('gh', ['auth', 'token'], { timeout: 5000 });
    const t = stdout.trim();
    if (t) return t;
  } catch {
    // fall through
  }
  throw new Error('GitHub token not found. Set github.token in config, or $GITHUB_TOKEN, or run `gh auth login`.');
}
