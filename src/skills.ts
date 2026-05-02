import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LensRelevance } from './lens_detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, '..', 'skills');

export function pickSkillPacks(changedFiles: string[]): string[] {
  const exts = new Set(changedFiles.map((f) => path.extname(f)));
  const packs: string[] = ['general.md'];
  if (exts.has('.ts') || exts.has('.tsx')) packs.push('ts.md', 'js.md');
  else if (exts.has('.js') || exts.has('.jsx')) packs.push('js.md');
  if (exts.has('.go')) packs.push('go.md');
  if (exts.has('.java')) packs.push('java.md');
  if (exts.has('.py')) packs.push('python.md');
  return packs;
}

/**
 * Filter a skill pack body to only include sections whose lens is active.
 * Sections are delimited by `## [lens_name]` headers.
 * Lines before the first `## [` header (e.g. the quality bar preamble) are always kept.
 */
function filterByLens(body: string, lenses: LensRelevance): string {
  const lines = body.split('\n');
  const output: string[] = [];
  let currentLens: string | null = null;
  let keeping = true; // keep preamble lines (before first ## [lens])

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+\[(\w+)\]/);
    if (headerMatch) {
      const lensName = headerMatch[1];
      currentLens = lensName;
      keeping = !!(lenses as unknown as Record<string, boolean>)[lensName];
      if (keeping) output.push(line);
      continue;
    }

    // Top-level headers (# Title) reset to preamble mode
    if (line.match(/^#\s+/) && !line.startsWith('##')) {
      currentLens = null;
      keeping = true;
    }

    if (keeping) output.push(line);
  }

  return output.join('\n');
}

export function loadSkills(
  changedFiles: string[],
  repoRoot?: string,
  lenses?: LensRelevance,
): string {
  const packs = pickSkillPacks(changedFiles);
  const parts: string[] = [];
  for (const p of packs) {
    const fp = path.join(SKILL_DIR, p);
    if (fs.existsSync(fp)) {
      let content = fs.readFileSync(fp, 'utf8');
      if (lenses) content = filterByLens(content, lenses);
      parts.push(`### ${p}\n${content}`);
    }
  }
  if (repoRoot) {
    const repoSkill = path.join(repoRoot, '.lens', 'skills.md');
    if (fs.existsSync(repoSkill)) {
      let content = fs.readFileSync(repoSkill, 'utf8');
      if (lenses) content = filterByLens(content, lenses);
      parts.push(`### repo:.lens/skills.md\n${content}`);
    }
  }
  return parts.join('\n\n');
}
