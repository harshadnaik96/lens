import { execa } from 'execa';

export async function detectRepoRoot(cwd?: string): Promise<string> {
  const { stdout } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: cwd ?? process.cwd() });
  return stdout.trim();
}

export async function detectBaseBranch(cwd?: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd: cwd ?? process.cwd() });
    return stdout.trim().replace(/^origin\//, '');
  } catch {
    // try common defaults
    for (const branch of ['main', 'master', 'develop']) {
      try {
        await execa('git', ['rev-parse', '--verify', `origin/${branch}`], { cwd: cwd ?? process.cwd() });
        return branch;
      } catch { /* try next */ }
    }
    return 'main';
  }
}

export async function getLocalDiff(range: string, cwd?: string): Promise<string> {
  const { stdout } = await execa('git', ['diff', range], { cwd: cwd ?? process.cwd(), maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

export async function getMergeBase(base: string, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execa('git', ['merge-base', `origin/${base}`, 'HEAD'], { cwd: cwd ?? process.cwd() });
    return stdout.trim();
  } catch {
    return `origin/${base}`;
  }
}

export function getChangedFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) files.push(m[1]);
  }
  return files;
}
