import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';

export interface IndexProgress {
  phase: 'walk' | 'defs' | 'calls' | 'done';
  filesScanned: number;
  filesTotal: number;
  symbolsFound: number;
  callSitesFound: number;
}

export interface IndexOpts {
  repoRoot: string;
  languages?: string[];
  excludeDirs?: string[];
  onProgress?: (p: IndexProgress) => void;
}

export interface IndexStats {
  files: number;
  symbols: number;
  callSites: number;
  durationMs: number;
}

export interface BlastRadius {
  callSiteCounts: Map<string, number>;
  dependentFiles: string[];
}

// Minimum symbol length to index (avoids noise from short names like 'get', 'set')
const MIN_SYMBOL_LEN = 4;
const SYMBOL_STOPLIST = new Set(['this', 'self', 'true', 'false', 'null', 'void', 'type', 'interface', 'class', 'async', 'await', 'return', 'const', 'function', 'import', 'export', 'default', 'from', 'enum']);

// Extension → language mapping
const EXT_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  go: 'go', java: 'java', py: 'py', dart: 'dart',
};

// Per-language export definition patterns (captures symbol name in group 1)
const DEF_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm,
    /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
    /^\s*export\s+interface\s+(\w+)/gm,
    /^\s*export\s+type\s+(\w+)/gm,
  ],
  js: [
    /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
    /^\s*module\.exports\.(\w+)\s*=/gm,
  ],
  go: [
    /^func\s+(?:\([^)]+\)\s+)?([A-Z]\w+)/gm,  // exported = capital first letter
    /^type\s+([A-Z]\w+)\s+(?:struct|interface)/gm,
  ],
  java: [
    /^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/gm,
    /^\s*public\s+(?:static\s+)?\S+\s+(\w+)\s*\(/gm,
  ],
  py: [
    /^def\s+([a-zA-Z_]\w+)/gm,
    /^class\s+([A-Z]\w+)/gm,
  ],
  dart: [
    /^\s*(?:class|mixin|extension)\s+(\w+)/gm,
    /^\s*(?:Future|Stream|void|[A-Z]\w+)\s+(\w+)\s*\(/gm,
  ],
};

// Call site patterns: look for identifier( or new identifier or extends/implements identifier
const CALL_PATTERN = /\b([A-Z][a-zA-Z0-9]{3,})\s*(?:\(|<)/g; // capitalized symbols likely to be exported

function extractDefs(content: string, lang: string): Array<{ symbol: string; line: number }> {
  const patterns = DEF_PATTERNS[lang] ?? [];
  const results: Array<{ symbol: string; line: number }> = [];
  const lineOffsets = buildLineOffsets(content);

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const sym = m[1];
      if (!sym || sym.length < MIN_SYMBOL_LEN || SYMBOL_STOPLIST.has(sym.toLowerCase())) continue;
      results.push({ symbol: sym, line: offsetToLine(m.index, lineOffsets) });
    }
  }
  return results;
}

function extractCalls(content: string, definedSymbols: Set<string>): Array<{ symbol: string; line: number }> {
  const results: Array<{ symbol: string; line: number }> = [];
  const lineOffsets = buildLineOffsets(content);
  const callRe = new RegExp(CALL_PATTERN.source, 'g');
  callRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(content)) !== null) {
    const sym = m[1];
    if (definedSymbols.has(sym)) {
      results.push({ symbol: sym, line: offsetToLine(m.index, lineOffsets) });
    }
  }
  return results;
}

function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLine(offset: number, offsets: number[]): number {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function walkDir(dir: string, excludeDirs: Set<string>, exts: Set<string>): string[] {
  const results: string[] = [];
  function walk(current: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!excludeDirs.has(e.name) && !e.name.startsWith('.')) walk(full);
      } else if (e.isFile()) {
        const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
        if (exts.has(ext)) results.push(full);
      }
    }
  }
  walk(dir);
  return results;
}

export async function buildIndex(opts: IndexOpts): Promise<IndexStats> {
  const start = Date.now();
  const db = getDb();
  const langs = new Set(opts.languages ?? Object.keys(DEF_PATTERNS));
  const exts = new Set(Object.entries(EXT_LANG).filter(([, l]) => langs.has(l)).map(([e]) => e));
  const excludeDirs = new Set(opts.excludeDirs ?? ['node_modules', 'vendor', 'dist', 'build', '.next', '.git']);
  const emit = opts.onProgress ?? (() => {});

  // clear existing index for this repo
  db.prepare('DELETE FROM symbol_index WHERE repo_root = ?').run(opts.repoRoot);

  emit({ phase: 'walk', filesScanned: 0, filesTotal: 0, symbolsFound: 0, callSitesFound: 0 });
  const files = walkDir(opts.repoRoot, excludeDirs, exts);
  const filesTotal = files.length;
  emit({ phase: 'walk', filesScanned: filesTotal, filesTotal, symbolsFound: 0, callSitesFound: 0 });

  // pass 1: collect all defined symbols across repo
  const allDefs = new Map<string, Array<{ file: string; line: number; lang: string }>>();
  let scanned = 0, symbolsRunning = 0;
  for (const file of files) {
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); } catch { scanned++; continue; }
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    const lang = EXT_LANG[ext] ?? 'other';
    const relFile = path.relative(opts.repoRoot, file);
    const defs = extractDefs(content, lang);
    for (const d of defs) {
      const existing = allDefs.get(d.symbol) ?? [];
      existing.push({ file: relFile, line: d.line, lang });
      allDefs.set(d.symbol, existing);
      symbolsRunning++;
    }
    scanned++;
    // Emit every ~64 files to avoid flooding listeners.
    if ((scanned & 63) === 0) {
      emit({ phase: 'defs', filesScanned: scanned, filesTotal, symbolsFound: symbolsRunning, callSitesFound: 0 });
    }
  }
  emit({ phase: 'defs', filesScanned: scanned, filesTotal, symbolsFound: symbolsRunning, callSitesFound: 0 });

  const definedSymbols = new Set(allDefs.keys());

  // pass 2: insert defs + calls in a single transaction
  let totalSymbols = 0, totalCalls = 0;
  const insertStmt = db.prepare(
    'INSERT INTO symbol_index (repo_root, file, symbol, kind, language, line) VALUES (?, ?, ?, ?, ?, ?)'
  );

  db.transaction(() => {
    // insert defs
    for (const [symbol, locs] of allDefs) {
      for (const loc of locs) {
        insertStmt.run(opts.repoRoot, loc.file, symbol, 'def', loc.lang, loc.line);
        totalSymbols++;
      }
    }

    // insert calls
    let cscan = 0;
    for (const file of files) {
      let content: string;
      try { content = fs.readFileSync(file, 'utf8'); } catch { cscan++; continue; }
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      const lang = EXT_LANG[ext] ?? 'other';
      const relFile = path.relative(opts.repoRoot, file);
      const calls = extractCalls(content, definedSymbols);
      for (const c of calls) {
        insertStmt.run(opts.repoRoot, relFile, c.symbol, 'call', lang, c.line);
        totalCalls++;
      }
      cscan++;
      if ((cscan & 63) === 0) {
        emit({ phase: 'calls', filesScanned: cscan, filesTotal, symbolsFound: totalSymbols, callSitesFound: totalCalls });
      }
    }
  })();

  emit({ phase: 'done', filesScanned: filesTotal, filesTotal, symbolsFound: totalSymbols, callSitesFound: totalCalls });
  return { files: files.length, symbols: totalSymbols, callSites: totalCalls, durationMs: Date.now() - start };
}

export function clearIndex(repoRoot: string): void {
  getDb().prepare('DELETE FROM symbol_index WHERE repo_root = ?').run(repoRoot);
}

export function queryBlastRadius(repoRoot: string, symbols: string[]): BlastRadius {
  if (symbols.length === 0) return { callSiteCounts: new Map(), dependentFiles: [] };
  const db = getDb();

  const callSiteCounts = new Map<string, number>();
  for (const sym of symbols) {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM symbol_index WHERE repo_root = ? AND symbol = ? AND kind = ?'
    ).get(repoRoot, sym, 'call') as { cnt: number };
    if (row.cnt > 0) callSiteCounts.set(sym, row.cnt);
  }

  // files that call any of the changed symbols
  const placeholders = symbols.map(() => '?').join(',');
  const depRows = db.prepare(
    `SELECT DISTINCT file FROM symbol_index WHERE repo_root = ? AND kind = 'call' AND symbol IN (${placeholders})`
  ).all(repoRoot, ...symbols) as Array<{ file: string }>;

  return {
    callSiteCounts,
    dependentFiles: depRows.map((r) => r.file),
  };
}

export function formatBlastRadius(br: BlastRadius, changedFiles: string[]): string {
  if (br.callSiteCounts.size === 0 && br.dependentFiles.length === 0) return '';

  const lines: string[] = ['## Blast Radius (symbol call-site analysis)', '> Call-site counts reflect the indexed state of the repo — not the PR diff itself.', ''];

  if (br.callSiteCounts.size > 0) {
    lines.push('**Changed exported symbols and their call-site counts:**');
    const sorted = Array.from(br.callSiteCounts.entries()).sort(([, a], [, b]) => b - a);
    for (const [sym, count] of sorted) {
      const risk = count >= 20 ? '🔴 HIGH IMPACT' : count >= 5 ? '🟡' : '🟢';
      lines.push(`- \`${sym}\`: **${count}** call site${count !== 1 ? 's' : ''} ${risk}`);
    }
    lines.push('');
  }

  const externalDeps = br.dependentFiles.filter((f) => !changedFiles.includes(f));
  if (externalDeps.length > 0) {
    lines.push(`**Files outside this PR that depend on changed symbols (${externalDeps.length}):**`);
    for (const f of externalDeps.slice(0, 10)) lines.push(`- ${f}`);
    if (externalDeps.length > 10) lines.push(`- …and ${externalDeps.length - 10} more`);
  }

  return lines.join('\n');
}
