import type { FileDiff } from './diff_split.js';

export interface SymbolContext {
  path: string;
  language: string;
  imports: string[];
  symbols: string[];
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  go: 'go', java: 'java', py: 'py', rb: 'rb', rs: 'rs', kt: 'kt',
};

function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? 'other';
}

function postChangeContent(body: string): string {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('-')) continue;
    out.push(line.startsWith('+') ? line.slice(1) : line);
  }
  return out.join('\n');
}

const PATTERNS: Record<string, { imports: RegExp[]; symbols: RegExp[] }> = {
  ts: {
    imports: [/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm, /^\s*import\s+['"]([^'"]+)['"]/gm, /\brequire\(['"]([^'"]+)['"]\)/gm],
    symbols: [
      /^\s*export\s+(?:async\s+)?function\s+(\w+)/gm,
      /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/gm,
      /^\s*export\s+(?:const|let|var)\s+(\w+)/gm,
      /^\s*export\s+interface\s+(\w+)/gm,
      /^\s*export\s+type\s+(\w+)/gm,
      /^\s*(?:async\s+)?function\s+(\w+)/gm,
      /^\s*class\s+(\w+)/gm,
    ],
  },
  js: {
    imports: [/^\s*import\s+.*?from\s+['"]([^'"]+)['"]/gm, /\brequire\(['"]([^'"]+)['"]\)/gm],
    symbols: [/^\s*(?:async\s+)?function\s+(\w+)/gm, /^\s*class\s+(\w+)/gm, /^\s*export\s+(?:const|let|var)\s+(\w+)/gm],
  },
  go: {
    imports: [/^\s*import\s+"([^"]+)"/gm, /^\s+"([^"]+)"\s*$/gm],
    symbols: [/^func\s+(?:\([^)]+\)\s+)?(\w+)/gm, /^type\s+(\w+)\s+(?:struct|interface)/gm],
  },
  java: {
    imports: [/^\s*import\s+(?:static\s+)?([\w.]+);/gm],
    symbols: [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+(\w+)/gm, /^\s*(?:public|private|protected)\s+(?:static\s+)?\S+\s+(\w+)\s*\(/gm],
  },
  py: {
    imports: [/^\s*import\s+([\w.]+)/gm, /^\s*from\s+([\w.]+)\s+import/gm],
    symbols: [/^\s*def\s+(\w+)/gm, /^\s*class\s+(\w+)/gm],
  },
  rb: { imports: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm], symbols: [/^\s*def\s+(\w+)/gm, /^\s*class\s+(\w+)/gm, /^\s*module\s+(\w+)/gm] },
  rs: { imports: [/^\s*use\s+([\w:]+)/gm], symbols: [/^\s*(?:pub\s+)?fn\s+(\w+)/gm, /^\s*(?:pub\s+)?struct\s+(\w+)/gm, /^\s*(?:pub\s+)?enum\s+(\w+)/gm, /^\s*(?:pub\s+)?trait\s+(\w+)/gm] },
  kt: { imports: [/^\s*import\s+([\w.]+)/gm], symbols: [/^\s*(?:public|private|internal)?\s*fun\s+(\w+)/gm, /^\s*(?:public|private|internal)?\s*class\s+(\w+)/gm] },
};

function extractAll(text: string, patterns: RegExp[]): string[] {
  const set = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) set.add(m[1]);
    }
  }
  return Array.from(set);
}

export function extractContext(file: FileDiff): SymbolContext {
  const language = langOf(file.path);
  const pat = PATTERNS[language];
  if (!pat) return { path: file.path, language, imports: [], symbols: [] };
  const content = postChangeContent(file.body);
  return {
    path: file.path,
    language,
    imports: extractAll(content, pat.imports).slice(0, 30),
    symbols: extractAll(content, pat.symbols).slice(0, 40),
  };
}

export function buildContextBlock(ctxs: SymbolContext[]): string {
  const useful = ctxs.filter((c) => c.imports.length || c.symbols.length);
  if (!useful.length) return '';
  const sections = useful.map((c) => {
    const lines: string[] = [`### ${c.path} (${c.language})`];
    if (c.imports.length) lines.push(`imports: ${c.imports.join(', ')}`);
    if (c.symbols.length) lines.push(`symbols: ${c.symbols.join(', ')}`);
    return lines.join('\n');
  });
  return sections.join('\n\n');
}
