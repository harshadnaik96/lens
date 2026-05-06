import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../config.js';
import { detectRepoRoot, detectBaseBranch, getLocalDiff, getMergeBase, getChangedFilesFromDiff } from '../local_diff.js';
import { runAnalysisPipeline } from './pr.js';

const HOOK_MARKER = '# lens:pre-push-hook';
const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}
exec lens hook run
`;

export async function installHook(opts: { force?: boolean } = {}): Promise<void> {
  const root = await detectRepoRoot();
  const hookPath = path.join(root, '.git', 'hooks', 'pre-push');

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(HOOK_MARKER)) {
      console.log('lens pre-push hook already installed.');
      return;
    }
    if (!opts.force) {
      console.error('A pre-push hook already exists. Use --force to overwrite.');
      process.exit(1);
    }
  }

  fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
  console.log(`✓ lens pre-push hook installed at ${hookPath}`);
  console.log('  Every push will now run a quick AI review. Blockers will prompt before proceeding.');
}

export async function uninstallHook(): Promise<void> {
  const root = await detectRepoRoot();
  const hookPath = path.join(root, '.git', 'hooks', 'pre-push');
  if (!fs.existsSync(hookPath)) { console.log('No pre-push hook found.'); return; }
  const content = fs.readFileSync(hookPath, 'utf8');
  if (!content.includes(HOOK_MARKER)) { console.log('Hook exists but was not installed by lens — leaving it untouched.'); return; }
  fs.unlinkSync(hookPath);
  console.log('✓ lens pre-push hook removed.');
}

export async function runHook(opts: { baseBranch?: string; timeoutSec?: number } = {}): Promise<void> {
  const cfg = (() => { try { return loadConfig(); } catch { return null; } })();
  if (!cfg) { process.exit(0); } // no config → don't block

  const hookCfg: NonNullable<typeof cfg.hook> = cfg.hook ?? {} as NonNullable<typeof cfg.hook>;
  const timeoutMs = (opts.timeoutSec ?? hookCfg.timeoutSec ?? 30) * 1000;

  const pipeline = async () => {
    const cwd = process.cwd();
    const base = opts.baseBranch ?? hookCfg.baseBranch ?? await detectBaseBranch(cwd);
    const mergeBase = await getMergeBase(base, cwd);
    const diff = await getLocalDiff(`${mergeBase}..HEAD`, cwd);

    if (!diff.trim()) { process.exit(0); } // nothing to review

    const changedFiles = getChangedFilesFromDiff(diff);
    console.error('\n🔍 lens: reviewing your changes before push...');

    const result = await runAnalysisPipeline(cfg, diff, changedFiles, 'pre-push review', '', {
      effort: hookCfg.effort ?? 'low',
      skipCritic: hookCfg.skipCritic ?? true,
    });

    const blockers = result.comments.filter(c => c.severity === 'blocker');
    const concerns = result.comments.filter(c => c.severity === 'concern');

    console.error(`\nlens found: ${blockers.length} blocker(s), ${concerns.length} concern(s)`);

    if (blockers.length > 0) {
      console.error('\n🚫 Blockers:');
      for (const b of blockers) {
        console.error(`  ${b.file}:${b.line} — ${b.body.split('\n')[0].slice(0, 120)}`);
      }

      // try to open /dev/tty for interactive prompt even when stdin is piped
      const proceed = await promptUser('\nProceed with push anyway? [y/N] ');
      if (!proceed) { console.error('Push cancelled by lens.'); process.exit(1); }
    } else if (concerns.length > 0) {
      console.error('\n⚠️  Concerns flagged — push proceeding.');
    } else {
      console.error('✓ No blockers found — push proceeding.');
    }
  };

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  );

  try {
    await Promise.race([pipeline(), timeout]);
  } catch (err: any) {
    if (err.message === 'timeout') {
      console.error(`\nlens: review timed out after ${opts.timeoutSec ?? 30}s — push proceeding.`);
      process.exit(0);
    }
    console.error(`\nlens hook error: ${err.message} — push proceeding.`);
    process.exit(0); // never block on tool failure
  }
}

async function promptUser(question: string): Promise<boolean> {
  // open /dev/tty directly to get interactive input even when stdin is piped
  if (process.platform !== 'win32') {
    try {
      const ttyFd = fs.openSync('/dev/tty', 'r+');
      const ttyIn = fs.createReadStream('', { fd: ttyFd, autoClose: false });
      const ttyOut = fs.createWriteStream('', { fd: ttyFd, autoClose: false });
      const rl = readline.createInterface({ input: ttyIn, output: ttyOut, terminal: true });
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          rl.close();
          fs.closeSync(ttyFd);
          resolve(answer.toLowerCase().startsWith('y'));
        });
      });
    } catch { /* /dev/tty not available */ }
  }
  // fallback: auto-block when not interactive
  return false;
}
