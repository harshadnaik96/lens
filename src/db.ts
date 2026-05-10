import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, LENS_HOME } from './config.js';

let _db: Database.Database | null = null;

export function initDb(): Database.Database {
  fs.mkdirSync(LENS_HOME, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr (
      id TEXT PRIMARY KEY,
      forge TEXT,
      workspace TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER,
      url TEXT,
      title TEXT,
      author TEXT,
      source_branch TEXT,
      dest_branch TEXT,
      state TEXT NOT NULL DEFAULT 'NEW',
      updated_at TEXT,
      raw JSON
    );

    CREATE TABLE IF NOT EXISTS analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      summary TEXT,
      logs TEXT,
      raw_response TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      tokens_in INTEGER,
      tokens_out INTEGER,
      ms_elapsed INTEGER,
      FOREIGN KEY(pr_id) REFERENCES pr(id)
    );

    CREATE TABLE IF NOT EXISTS comment_draft (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      line INTEGER,
      side TEXT,
      severity TEXT,
      ai_original_body TEXT,
      current_body TEXT,
      action TEXT DEFAULT 'kept',
      confidence REAL,
      FOREIGN KEY(analysis_id) REFERENCES analysis(id)
    );

    CREATE TABLE IF NOT EXISTS state_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      at TEXT DEFAULT CURRENT_TIMESTAMP,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS triage_decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_id INTEGER NOT NULL,
      file TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,
      source TEXT,
      added INTEGER,
      removed INTEGER,
      FOREIGN KEY(analysis_id) REFERENCES analysis(id)
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      pr_id TEXT,
      at TEXT DEFAULT CURRENT_TIMESTAMP,
      ok INTEGER NOT NULL,
      ms_elapsed INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      stage TEXT,
      model TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS reviewer_comment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      forge TEXT NOT NULL,
      workspace TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_title TEXT,
      author TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER,
      body TEXT NOT NULL,
      category TEXT,
      resolved INTEGER DEFAULT 0,
      fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(forge, workspace, repo, pr_number, author, file, line)
    );

    CREATE TABLE IF NOT EXISTS reviewer_profile (
      reviewer TEXT PRIMARY KEY,
      categories TEXT,
      acceptance_rate REAL,
      total_accepted INTEGER DEFAULT 0,
      total_seen INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS symbol_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_root TEXT NOT NULL,
      file TEXT NOT NULL,
      symbol TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('def','call')),
      language TEXT NOT NULL,
      line INTEGER NOT NULL,
      indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_symbol
      ON symbol_index(repo_root, symbol);

    CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_file
      ON symbol_index(repo_root, file);

    CREATE TABLE IF NOT EXISTS review_session (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      trigger TEXT,
      provider TEXT,
      model TEXT,
      cancelled INTEGER DEFAULT 0,
      error TEXT,
      final_percent INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL,
      analysis_id INTEGER,
      FOREIGN KEY(pr_id) REFERENCES pr(id)
    );

    CREATE INDEX IF NOT EXISTS idx_review_session_pr
      ON review_session(pr_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS review_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kind TEXT NOT NULL,
      stage TEXT,
      payload TEXT,
      FOREIGN KEY(session_id) REFERENCES review_session(id)
    );

    CREATE INDEX IF NOT EXISTS idx_review_event_session
      ON review_event(session_id, seq);
  `);

  // Defensive ALTERs for existing dbs upgraded from older schema.
  for (const stmt of [
    `ALTER TABLE pr ADD COLUMN forge TEXT`,
    `ALTER TABLE pr ADD COLUMN number INTEGER`,
    `ALTER TABLE pr ADD COLUMN url TEXT`,
    `ALTER TABLE analysis ADD COLUMN logs TEXT`,
    `ALTER TABLE analysis ADD COLUMN cost_usd REAL`,
    `ALTER TABLE analysis ADD COLUMN tokens_in_total INTEGER`,
    `ALTER TABLE analysis ADD COLUMN tokens_out_total INTEGER`,
    `ALTER TABLE comment_draft ADD COLUMN category TEXT DEFAULT 'correctness'`,
    `ALTER TABLE comment_draft ADD COLUMN reject_reason TEXT`,
    `ALTER TABLE comment_draft ADD COLUMN reviewer TEXT`,
    `ALTER TABLE usage_log ADD COLUMN cost_usd REAL`,
    `ALTER TABLE usage_log ADD COLUMN stage TEXT`,
    `ALTER TABLE usage_log ADD COLUMN model TEXT`,
    `ALTER TABLE pr ADD COLUMN last_heartbeat_at TEXT`,
    `ALTER TABLE pr ADD COLUMN forge_state TEXT`,
    `ALTER TABLE pr ADD COLUMN is_draft INTEGER DEFAULT 0`,
    `ALTER TABLE reviewer_comment ADD COLUMN created_at TEXT`,
  ]) {
    try { db.exec(stmt); } catch { /* column already exists */ }
  }

  _db = db;
  return db;
}

export function getDb(): Database.Database {
  if (_db) return _db;
  return initDb();
}
