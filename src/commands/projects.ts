import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb } from '../db.js';
import { buildIndex, type IndexStats, type IndexProgress } from '../indexer.js';
import type { Config } from '../config.js';

export interface LocalRepo {
  localPath: string;
  remote: string;
  workspace: string;
  repo: string;
}

export interface ProjectInfo {
  workspace: string;
  repo: string;
  localPath: string | null;
  lastIndexed: string | null;
  symbolCount: number;
}

function parseRemote(url: string): { workspace: string; repo: string } | null {
  const m = url.match(/[:/]([^/:]+)\/([^/\s]+?)(?:\.git)?\s*$/);
  if (m) return { workspace: m[1], repo: m[2] };
  return null;
}

function readGitRemote(gitDir: string): string | null {
  const configPath = path.join(gitDir, 'config');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const m = content.match(/\[remote "origin"\][^\[]*url\s*=\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const SEARCH_ROOTS = () => {
  const home = os.homedir();
  return [
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'projects'),
    path.join(home, 'code'),
    path.join(home, 'workspace'),
    path.join(home, 'dev'),
    path.join(home, 'src'),
  ].filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
};

function scanDir(dir: string, depth: number, results: LocalRepo[], seen: Set<string>): void {
  if (depth === 0 || seen.has(dir)) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === '.git') {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const remote = readGitRemote(full);
      if (remote) {
        const parsed = parseRemote(remote);
        if (parsed) results.push({ localPath: dir, remote, ...parsed });
      }
      return;
    }
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    scanDir(full, depth - 1, results, seen);
  }
}

export function scanLocalRepos(): LocalRepo[] {
  const results: LocalRepo[] = [];
  const seen = new Set<string>();
  for (const root of SEARCH_ROOTS()) scanDir(root, 4, results, seen);
  return results;
}

/**
 * Find candidate local paths for a given workspace/repo.
 * Returns dirs that either match the repo name or have a matching git remote.
 */
export function findCandidates(workspace: string, repo: string): string[] {
  const repoLower = repo.toLowerCase();
  const candidates: string[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth === 0 || seen.has(dir)) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === '.git') {
        if (seen.has(dir)) continue;
        seen.add(dir);
        // Check by remote URL first (most accurate)
        const remote = readGitRemote(full);
        if (remote) {
          const parsed = parseRemote(remote);
          if (parsed &&
            parsed.workspace.toLowerCase() === workspace.toLowerCase() &&
            parsed.repo.toLowerCase() === repoLower) {
            candidates.unshift(dir); // exact remote match → top of list
            return;
          }
        }
        // Fall back: directory name matches repo name
        if (path.basename(dir).toLowerCase() === repoLower) {
          candidates.push(dir);
        }
        return;
      }
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      walk(full, depth - 1);
    }
  }

  for (const root of SEARCH_ROOTS()) walk(root, 4);
  return [...new Set(candidates)];
}

export function autoMatchProjects(db: ReturnType<typeof getDb>, repos: LocalRepo[]): number {
  const prRepos = db.prepare(`SELECT DISTINCT workspace, repo FROM pr`).all() as Array<{ workspace: string; repo: string }>;
  let matched = 0;
  for (const pr of prRepos) {
    const match = repos.find(r =>
      r.workspace.toLowerCase() === pr.workspace.toLowerCase() &&
      r.repo.toLowerCase() === pr.repo.toLowerCase()
    );
    if (match) {
      db.prepare(`INSERT OR REPLACE INTO project_path (workspace, repo, local_path) VALUES (?,?,?)`)
        .run(pr.workspace, pr.repo, match.localPath);
      matched++;
    }
  }
  return matched;
}

export function getProjects(db: ReturnType<typeof getDb>): ProjectInfo[] {
  const prRepos = db.prepare(`SELECT DISTINCT workspace, repo FROM pr ORDER BY workspace, repo`).all() as Array<{ workspace: string; repo: string }>;
  return prRepos.map(({ workspace, repo }) => {
    const pathRow = db.prepare(`SELECT local_path FROM project_path WHERE workspace=? AND repo=?`).get(workspace, repo) as { local_path: string } | undefined;
    const localPath = pathRow?.local_path ?? null;
    let lastIndexed: string | null = null;
    let symbolCount = 0;
    if (localPath) {
      const row = db.prepare(
        `SELECT MAX(indexed_at) as last, SUM(kind='def') as cnt FROM symbol_index WHERE repo_root=?`
      ).get(localPath) as { last: string | null; cnt: number } | undefined;
      lastIndexed = row?.last ?? null;
      symbolCount = row?.cnt ?? 0;
    }
    return { workspace, repo, localPath, lastIndexed, symbolCount };
  });
}

export async function indexProject(
  cfg: Config,
  localPath: string,
  onProgress?: (p: IndexProgress) => void,
): Promise<IndexStats> {
  const languages = cfg.index?.languages ?? ['ts', 'js', 'go', 'py', 'java', 'dart'];
  const excludeDirs = cfg.index?.excludeDirs ?? ['node_modules', 'vendor', 'dist', 'build', '.next', '.git'];
  return buildIndex({ repoRoot: localPath, languages, excludeDirs, onProgress });
}
