import { getDb } from './db.js';

export interface PatternHit {
  pattern: string;  // brief description
  category: string;
  severity: string;
  count: number;    // how many times this appeared across recent PRs
  files: string[];  // representative files
}

export interface PatternReport {
  hits: PatternHit[];
  prCount: number;
}

/**
 * Detect comment themes that recur across the last `recentPRs` PRs.
 * Works purely from the local DB — no AI call needed.
 */
export function detectCrossPatterns(recentPRs = 10): PatternReport {
  try {
    const db = getDb();

    // Grab recent analysis IDs
    const analyses = db.prepare(`
      SELECT id, pr_id FROM analysis ORDER BY id DESC LIMIT ?
    `).all(recentPRs * 3) as Array<{ id: number; pr_id: string }>;

    if (analyses.length === 0) return { hits: [], prCount: 0 };

    // Unique PR count
    const prIds = new Set(analyses.map((a) => a.pr_id));

    const ids = analyses.map((a) => a.id);
    const placeholders = ids.map(() => '?').join(',');

    const comments = db.prepare(`
      SELECT file, category, severity, ai_original_body, analysis_id
      FROM comment_draft
      WHERE analysis_id IN (${placeholders})
        AND action IN ('kept', 'edited')
    `).all(...ids) as Array<{
      file: string;
      category: string;
      severity: string;
      ai_original_body: string;
      analysis_id: number;
    }>;

    if (comments.length === 0) return { hits: [], prCount: prIds.size };

    // Simple n-gram fingerprinting: extract 3-word phrases from comment bodies
    // Group by (category, severity, leading-phrase) and count
    const phraseMap = new Map<string, { count: number; files: Set<string>; category: string; severity: string }>();

    for (const c of comments) {
      const words = c.ai_original_body
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3);

      // Take the first meaningful 4-word phrase as a fingerprint
      if (words.length < 4) continue;
      const phrase = words.slice(0, 4).join(' ');
      const key = `${c.category}:${c.severity}:${phrase}`;

      if (!phraseMap.has(key)) {
        phraseMap.set(key, { count: 0, files: new Set(), category: c.category, severity: c.severity });
      }
      const entry = phraseMap.get(key)!;
      entry.count++;
      if (c.file) entry.files.add(c.file.split('/').pop() ?? c.file);
    }

    // Keep patterns that appear in ≥2 analyses (recurring, not one-off)
    const hits: PatternHit[] = [];
    for (const [key, entry] of phraseMap.entries()) {
      if (entry.count < 2) continue;
      const phrase = key.split(':').slice(2).join(':');
      hits.push({
        pattern: capitalise(phrase),
        category: entry.category,
        severity: entry.severity,
        count: entry.count,
        files: [...entry.files].slice(0, 3),
      });
    }

    hits.sort((a, b) => b.count - a.count);

    return { hits: hits.slice(0, 10), prCount: prIds.size };
  } catch {
    return { hits: [], prCount: 0 };
  }
}

export function formatPatternReport(report: PatternReport): string {
  if (report.hits.length === 0) return '';
  const lines: string[] = [
    `## Recurring patterns (last ${report.prCount} PR${report.prCount !== 1 ? 's' : ''})`,
    '',
  ];
  for (const h of report.hits) {
    lines.push(`- **[${h.category}/${h.severity}]** "${h.pattern}" — ${h.count}× across ${h.files.join(', ') || 'various files'}`);
  }
  return lines.join('\n');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
