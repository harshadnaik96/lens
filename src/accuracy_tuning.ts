import { getDb } from './db.js';

export interface AccuracyGuidance {
  /** Short guidance paragraph to inject into the critic prompt */
  guidance: string;
  /** Whether any meaningful stats were available */
  hasData: boolean;
}

interface CategoryStats {
  category: string;
  severity: string;
  total: number;
  accepted: number;
  rate: number;
}

export function buildAccuracyGuidance(): AccuracyGuidance {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        COALESCE(category, 'correctness') AS category,
        COALESCE(severity, 'concern') AS severity,
        COUNT(*) AS total,
        SUM(CASE WHEN action IN ('kept','edited') THEN 1 ELSE 0 END) AS accepted
      FROM comment_draft
      WHERE action IS NOT NULL
      GROUP BY category, severity
      HAVING total >= 3
      ORDER BY category, severity
    `).all() as Array<{ category: string; severity: string; total: number; accepted: number }>;

    if (rows.length === 0) return { guidance: '', hasData: false };

    const stats: CategoryStats[] = rows.map((r) => ({
      ...r,
      rate: r.total > 0 ? r.accepted / r.total : 0,
    }));

    const low = stats.filter((s) => s.rate < 0.35 && s.total >= 5);
    const high = stats.filter((s) => s.rate > 0.75 && s.total >= 5);

    if (low.length === 0 && high.length === 0) return { guidance: '', hasData: true };

    const parts: string[] = ['## Accuracy tuning (from past acceptance data)'];

    if (low.length > 0) {
      parts.push('**Low-acceptance combos — apply extra scrutiny, raise the bar before keeping:**');
      for (const s of low) {
        parts.push(`  - ${s.category}/${s.severity}: ${Math.round(s.rate * 100)}% acceptance (${s.accepted}/${s.total} kept)`);
      }
    }

    if (high.length > 0) {
      parts.push('**High-acceptance combos — these land well, keep good examples:**');
      for (const s of high) {
        parts.push(`  - ${s.category}/${s.severity}: ${Math.round(s.rate * 100)}% acceptance (${s.accepted}/${s.total} kept)`);
      }
    }

    return { guidance: parts.join('\n'), hasData: true };
  } catch {
    return { guidance: '', hasData: false };
  }
}
