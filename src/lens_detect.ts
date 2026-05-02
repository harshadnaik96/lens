import type { SymbolContext } from './context.js';

/**
 * Which review lenses are relevant for this diff.
 * Correctness is always on — the other four are activated by heuristic
 * pattern detection on the diff text and extracted symbol context.
 *
 * When a lens is inactive its checklist section is stripped from the
 * prompt to keep token usage lean.
 */
export interface LensRelevance {
  correctness: true;
  security: boolean;
  data_integrity: boolean;
  api_contracts: boolean;
  maintainability: boolean;
}

// ── Pattern banks (case-insensitive matching) ──────────────────────

const SECURITY_TOKENS = [
  'password', 'token', 'secret', 'api_key', 'apikey', 'api-key',
  'auth', 'oauth', 'jwt', 'bearer', 'credential',
  'crypto', 'hash', 'hmac', 'cipher', 'encrypt', 'decrypt',
  'sql', 'query', 'exec', 'eval', 'function(',
  'fetch(', 'http.', 'https.', 'axios', 'cors',
  'cookie', 'session', 'csrf', 'xss',
  'sanitize', 'escape', 'validate',
  'child_process', 'spawn', 'execSync',
  'fs.write', 'fs.read', 'path.join', 'path.resolve',
];

const SECURITY_PATHS = [
  '/routes/', '/middleware/', '/auth/', '/security/',
  '/login', '/signup', '/register', '/oauth/',
  '/api/', '/handler/', '/controller/',
];

const DATA_TOKENS = [
  'transaction', 'commit', 'rollback', 'savepoint',
  'mutex', 'lock', 'unlock', 'semaphore', 'atomic',
  'sync.', 'rwmutex', 'waitgroup',
  'cache', 'redis', 'memcache', 'invalidat',
  'migration', 'schema', 'alter table', 'create table', 'add column',
  'db.', 'prisma.', 'sequelize', 'typeorm', 'mongoose', 'knex',
  '.query(', '.execute(', '.prepare(',
  'promise.all', 'promise.allsettled', 'promise.race',
  'async', 'await', 'goroutine', 'go func', 'channel',
  'synchronized', 'volatile', 'concurrenthashmap',
  '@transactional',
];

const API_TOKENS = [
  'export ', 'export{', 'export default',
  'module.exports',
  'public ', 'public(', '@api', '@public',
  'router.', 'app.get', 'app.post', 'app.put', 'app.delete', 'app.patch',
  'endpoint', 'handler', 'controller',
  'openapi', 'swagger', 'grpc', 'proto',
  '@requestmapping', '@getmapping', '@postmapping',
  'interface ', 'type ',
];

const API_PATHS = [
  '/api/', '/routes/', '/controllers/', '/handlers/',
  '/endpoints/', '/grpc/', '/proto/',
];

// ── Detector ───────────────────────────────────────────────────────

function containsAny(text: string, tokens: string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.some((t) => lower.includes(t));
}

function pathMatchesAny(filePaths: string[], patterns: string[]): boolean {
  return filePaths.some((p) =>
    patterns.some((pat) => ('/' + p.toLowerCase()).includes(pat)),
  );
}

export function detectRelevantLenses(
  diff: string,
  contexts: SymbolContext[],
  changedFiles: string[],
): LensRelevance {
  const allExports = contexts.flatMap((c) => c.symbols);
  const hasExports = allExports.length > 3;

  // Count total changed lines for maintainability threshold
  const changedLines = (diff.match(/^[+-]/gm) ?? []).length;
  const functionCount = contexts.reduce((sum, c) => sum + c.symbols.length, 0);

  return {
    correctness: true as const,

    security:
      containsAny(diff, SECURITY_TOKENS) ||
      pathMatchesAny(changedFiles, SECURITY_PATHS),

    data_integrity:
      containsAny(diff, DATA_TOKENS) ||
      changedFiles.some((f) =>
        f.toLowerCase().includes('migration') ||
        f.toLowerCase().includes('schema'),
      ),

    api_contracts:
      containsAny(diff, API_TOKENS) ||
      pathMatchesAny(changedFiles, API_PATHS) ||
      hasExports,

    maintainability: changedLines > 80 || functionCount > 3,
  };
}

/**
 * Pretty-print active lenses for CLI logging.
 */
export function formatLenses(lenses: LensRelevance): string {
  return Object.entries(lenses)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ');
}
