#!/usr/bin/env node
import { Command } from 'commander';
import { initConfig, loadConfig } from './config.js';
import { initDb } from './db.js';
import { listPRs, analyzePR } from './commands/pr.js';
import { serve } from './commands/serve.js';
import { showUsage } from './commands/usage.js';
import { exportEval } from './commands/eval_export.js';
import { showDiff } from './commands/diff_view.js';
import { runSetup } from './commands/setup.js';
import { installHook, uninstallHook, runHook } from './commands/hook.js';
import { briefPR } from './commands/brief.js';
import { runLearn } from './commands/learn.js';
import { showAccuracy } from './commands/accuracy.js';
import { runIndex } from './commands/index.js';
import { runScan } from './commands/scan.js';
import { runDigest } from './commands/digest.js';

const program = new Command();
program.name('lens').description('Local PR review agent').version('0.0.1');

program
  .command('init')
  .description('Initialize lens config and data dir (template — non-interactive)')
  .action(async () => {
    await initConfig();
    console.log('lens initialized. Edit ~/.lens/config.json to set forge credentials.');
  });

program
  .command('setup')
  .description('Interactive first-run setup: pick provider, forge, auth, and start UI')
  .option('--force', 'overwrite existing config without prompting')
  .option('--no-serve', "don't offer to start the UI at the end")
  .action(async (opts: { force?: boolean; serve?: boolean }) => {
    await runSetup({ force: !!opts.force, noServe: opts.serve === false });
  });

program
  .command('list')
  .description('List open PRs')
  .action(async () => {
    const cfg = loadConfig();
    await listPRs(cfg);
  });

program
  .command('analyze <prId>')
  .description('Analyze a PR with the configured provider')
  .option('-p, --provider <name>', 'override provider (claude|gemini|codex)')
  .option('--re', 're-analyze, keep human-edited/added comments')
  .option('--no-critic', 'skip the critic refinement pass')
  .option('--no-triage', 'skip the triage pre-pass (review every file)')
  .option('-e, --effort <level>', 'low|medium|high — overrides config models')
  .option('--brief', 'post a reviewer briefing to the forge before posting inline comments')
  .action(async (prId: string, opts: { provider?: string; re?: boolean; critic?: boolean; triage?: boolean; effort?: string; brief?: boolean }) => {
    const cfg = loadConfig();
    let effort: 'low' | 'medium' | 'high' | undefined;
    if (opts.effort) {
      if (!['low', 'medium', 'high'].includes(opts.effort)) throw new Error(`--effort must be low|medium|high, got: ${opts.effort}`);
      effort = opts.effort as any;
    }
    if (opts.brief) {
      await briefPR(cfg, prId, { providerOverride: opts.provider, effort });
    }
    await analyzePR(cfg, prId, {
      providerOverride: opts.provider,
      reAnalyze: !!opts.re,
      skipCritic: opts.critic === false,
      skipTriage: opts.triage === false,
      effort,
    });
  });

program
  .command('serve')
  .description('Start local UI on http://localhost:7777')
  .option('--port <port>', 'port', '7777')
  .action(async (opts: { port: string }) => {
    const cfg = loadConfig();
    await serve(cfg, parseInt(opts.port, 10));
  });

program
  .command('export-eval')
  .description('Dump comment drafts as JSONL for fine-tuning / eval')
  .option('-o, --out <file>', 'write to file instead of stdout')
  .option('--pr <prId>', 'limit to one PR')
  .action((opts: { out?: string; pr?: string }) => {
    exportEval({ out: opts.out, prId: opts.pr });
  });

program
  .command('usage')
  .description('Show provider usage')
  .option('--by-pr', 'per-PR token + cost breakdown')
  .option('--by-stage', 'per-stage (triage/review/critic) breakdown')
  .option('--limit <n>', 'limit rows in --by-pr view', '20')
  .action((opts: { byPr?: boolean; byStage?: boolean; limit?: string }) =>
    showUsage({ byPr: opts.byPr, byStage: opts.byStage, limit: opts.limit ? parseInt(opts.limit, 10) : undefined }),
  );

program
  .command('diff')
  .description('Show AI-original vs final-submitted bodies for each comment (the user-voice corpus)')
  .option('--pr <prId>', 'limit to one PR')
  .option('--only-edited', 'only show edited or rejected comments (skip "kept" rows)')
  .action((opts: { pr?: string; onlyEdited?: boolean }) =>
    showDiff({ prId: opts.pr, onlyEdited: opts.onlyEdited }),
  );

const hook = program.command('hook').description('Manage the git pre-push review hook');

hook
  .command('install')
  .description('Install lens pre-push hook in the current git repo')
  .option('--force', 'overwrite an existing hook')
  .action(async (opts: { force?: boolean }) => { await installHook({ force: opts.force }); });

hook
  .command('uninstall')
  .description('Remove the lens pre-push hook')
  .action(async () => { await uninstallHook(); });

hook
  .command('run')
  .description('(internal) run by git pre-push — reviews staged changes')
  .option('--base <branch>', 'override base branch detection')
  .option('--timeout <sec>', 'timeout in seconds', '30')
  .action(async (opts: { base?: string; timeout?: string }) => {
    await runHook({ baseBranch: opts.base, timeoutSec: opts.timeout ? parseInt(opts.timeout) : undefined });
  });

program
  .command('brief <prId>')
  .description('Generate and post a reviewer orientation briefing for a PR')
  .option('-p, --provider <name>', 'override provider (claude|gemini|codex)')
  .option('-e, --effort <level>', 'low|medium|high')
  .option('--no-post', 'print briefing without posting to forge')
  .action(async (prId: string, opts: { provider?: string; effort?: string; post?: boolean }) => {
    const cfg = loadConfig();
    await briefPR(cfg, prId, {
      providerOverride: opts.provider,
      effort: opts.effort as any,
      post: opts.post !== false,
    });
  });

program
  .command('learn')
  .description('Mine merged PRs and generate .lens/skills.md with team patterns')
  .option('--max-prs <n>', 'number of merged PRs to mine', '50')
  .option('--no-ai', 'skip AI clustering, use frequency analysis only')
  .option('--dry-run', 'preview without writing files')
  .option('-p, --provider <name>', 'override provider for AI clustering')
  .action(async (opts: { maxPrs?: string; ai?: boolean; dryRun?: boolean; provider?: string }) => {
    const cfg = loadConfig();
    initDb();
    await runLearn(cfg, {
      maxPRs: opts.maxPrs ? parseInt(opts.maxPrs) : undefined,
      useAI: opts.ai !== false,
      dryRun: opts.dryRun,
      providerOverride: opts.provider,
    });
  });

program
  .command('accuracy')
  .description('Show AI comment acceptance rates by category and severity')
  .option('--category <cat>', 'filter to one category')
  .option('--severity <sev>', 'filter to one severity')
  .action((opts: { category?: string; severity?: string }) => {
    initDb();
    showAccuracy({ category: opts.category, severity: opts.severity });
  });

program
  .command('index')
  .description('Build or refresh the codebase symbol index for blast-radius analysis')
  .option('--force', 're-index even if recently indexed')
  .option('--root <path>', 'repo root path (default: auto-detect from cwd)')
  .action(async (opts: { force?: boolean; root?: string }) => {
    const cfg = loadConfig();
    initDb();
    await runIndex(cfg, { repoRoot: opts.root, force: opts.force });
  });

program
  .command('scan')
  .description('Review local uncommitted/unpushed changes (no forge required)')
  .option('-p, --provider <name>', 'override provider (claude|gemini|codex)')
  .option('--base <branch>', 'override base branch detection')
  .option('--no-critic', 'skip the critic refinement pass')
  .option('--no-triage', 'skip the triage pre-pass')
  .option('-e, --effort <level>', 'low|medium|high')
  .action(async (opts: { provider?: string; base?: string; critic?: boolean; triage?: boolean; effort?: string }) => {
    const cfg = loadConfig();
    let effort: 'low' | 'medium' | 'high' | undefined;
    if (opts.effort) {
      if (!['low', 'medium', 'high'].includes(opts.effort)) throw new Error(`--effort must be low|medium|high`);
      effort = opts.effort as any;
    }
    await runScan(cfg, {
      providerOverride: opts.provider,
      base: opts.base,
      skipCritic: opts.critic === false,
      skipTriage: opts.triage === false,
      effort,
    });
  });

program
  .command('digest')
  .description('Weekly activity digest: PRs reviewed, acceptance rates, cost')
  .option('--days <n>', 'rolling window in days', '7')
  .option('-o, --out <file>', 'write markdown to file instead of stdout')
  .action((opts: { days?: string; out?: string }) => {
    initDb();
    runDigest({ days: opts.days ? parseInt(opts.days) : undefined, out: opts.out });
  });

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
