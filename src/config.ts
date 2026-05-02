import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

const ConfigSchema = z.object({
  forge: z.enum(['bitbucket', 'github']).default('bitbucket'),
  bitbucket: z
    .object({
      username: z.string(),
      appPassword: z.string(),
      scope: z.string().default('author'),
      baseUrl: z.string().default('https://api.bitbucket.org/2.0'),
    })
    .optional(),
  github: z
    .object({
      token: z.string().optional(),
      scope: z.string().default('reviewer'),
      baseUrl: z.string().default('https://api.github.com'),
    })
    .optional(),
  provider: z.object({
    default: z.enum(['claude', 'gemini', 'codex']).default('claude'),
    claudeBin: z.string().default('claude'),
    geminiBin: z.string().default('gemini'),
    codexBin: z.string().default('codex'),
    models: z
      .object({
        triage: z.string().optional(),
        review: z.string().optional(),
        critic: z.string().optional(),
      })
      .optional(),
  }),
  reviewer: z.object({
    name: z.string(),
    botFooter: z.string().default('[Reviewed by {name} via lens]'),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export const LENS_HOME = path.join(os.homedir(), '.lens');
export const CONFIG_PATH = path.join(LENS_HOME, 'config.json');
export const DB_PATH = path.join(LENS_HOME, 'lens.db');

const TEMPLATE: Config = {
  forge: 'bitbucket',
  bitbucket: {
    username: 'YOUR_BB_USERNAME',
    appPassword: 'YOUR_APP_PASSWORD',
    scope: 'author',
    baseUrl: 'https://api.bitbucket.org/2.0',
  },
  github: {
    token: '',
    scope: 'reviewer',
    baseUrl: 'https://api.github.com',
  },
  provider: {
    default: 'claude',
    claudeBin: 'claude',
    geminiBin: 'gemini',
    codexBin: 'codex',
    models: {
      triage: 'claude-haiku-4-5-20251001',
      review: 'claude-sonnet-4-6',
      critic: 'claude-sonnet-4-6',
    },
  },
  reviewer: {
    name: 'Harshad',
    botFooter: '[Reviewed by {name} via lens]',
  },
};

export async function initConfig() {
  fs.mkdirSync(LENS_HOME, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(TEMPLATE, null, 2));
    console.log(`Wrote template config: ${CONFIG_PATH}`);
    console.log('Edit it to set forge=bitbucket|github and the matching credentials.');
  } else {
    console.log(`Config already exists: ${CONFIG_PATH}`);
  }
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`No config at ${CONFIG_PATH}. Run \`lens init\` first.`);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = ConfigSchema.parse(raw);
  if (cfg.forge === 'bitbucket' && !cfg.bitbucket) throw new Error('forge=bitbucket but no bitbucket config');
  if (cfg.forge === 'github' && !cfg.github) throw new Error('forge=github but no github config');
  return cfg;
}
