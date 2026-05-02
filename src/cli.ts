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
  .action(async (prId: string, opts: { provider?: string; re?: boolean; critic?: boolean; triage?: boolean; effort?: string }) => {
    const cfg = loadConfig();
    let effort: 'low' | 'medium' | 'high' | undefined;
    if (opts.effort) {
      if (!['low', 'medium', 'high'].includes(opts.effort)) throw new Error(`--effort must be low|medium|high, got: ${opts.effort}`);
      effort = opts.effort as any;
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

program.parseAsync().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
