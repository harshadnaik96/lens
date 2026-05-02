import type { Config } from '../config.js';
import type { Forge } from './types.js';
import { BitbucketForge } from './bitbucket.js';
import { GitHubForge } from './github.js';

export type { Forge, PRSummary } from './types.js';

export function getForge(cfg: Config): Forge {
  switch (cfg.forge) {
    case 'github':
      return new GitHubForge(cfg);
    case 'bitbucket':
      return new BitbucketForge(cfg);
    default:
      throw new Error(`unknown forge: ${cfg.forge}`);
  }
}
