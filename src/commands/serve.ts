import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db.js';
import type { Config } from '../config.js';
import { getForge } from '../forge/index.js';
import { idToRef } from '../forge/types.js';
import { analyzePR, listPRs, PIPELINE_STAGES, PIPELINE_GROUPS, type StageEvent, type StageStatus } from './pr.js';
import type { AgentEvent } from '../providers/types.js';
import { getProjects, indexProject, findCandidates, scanLocalRepos, autoMatchProjects } from './projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = path.resolve(__dirname, '../../DOCS.md');

// Cap in-memory agent timeline per PR to bound memory under chatty stream-json runs.
const MAX_AGENT_EVENTS = 500;

// Concurrency cap for active analyses; the rest queue and drain in FIFO order.
const MAX_CONCURRENT_ANALYSES = 3;
// PRs whose state hasn't been heartbeat-updated in this long are considered stuck.
const STUCK_HEARTBEAT_MS = 3 * 60_000;
// Boot sweep: any PR sitting in ANALYZING/QUEUED on startup is reset to NEW.
const BOOT_SWEEP_NOTE = 'stale: server restart';

interface StageState {
  id: string;
  status: StageStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface AnalysisState {
  prId: string;
  startedAt: number;
  logs: string[];
  triage: any[];
  stages: Map<string, StageState>;
  currentStage: string | null;
  percent: number;
  etaMs: number;
  agentEvents: AgentEvent[]; // ring buffer (most recent last)
  lastAgent: AgentEvent | null;
}

const activeAnalyses = new Map<string, AnalysisState>();
// FIFO of prIds waiting for an active slot. Mirrored in DB as state='QUEUED'.
const analysisQueue: string[] = [];
// Cancellation handles per active prId. Used to abort in-flight subprocesses.
const runHandles = new Map<string, { abort: AbortController; cancelled: boolean }>();
const sseClients = new Map<string, Set<http.ServerResponse>>();
const dashboardClients = new Set<http.ServerResponse>();
// Per-project indexing state. Keyed by `${workspace}/${repo}`. Holds the most
// recent IndexProgress so HTTP/SSE consumers can surface live status without
// each having to hold its own subscription back to the running buildIndex.
interface IndexJobState {
  startedAt: number;
  files: number;
  filesTotal: number;
  symbols: number;
  callSites: number;
  phase: 'walk' | 'defs' | 'calls' | 'done' | 'error';
  error?: string;
}
const activeIndexes = new Map<string, IndexJobState>();

function broadcast(prId: string, event: string, data: any) {
  const clients = sseClients.get(prId);
  if (clients) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }
}

// Active session id per prId — set when runAnalysis opens a session row.
const activeSessions = new Map<string, { id: number; seq: number }>();

function persistEvent(prId: string, kind: string, payload: any, stage?: string | null) {
  const ses = activeSessions.get(prId);
  if (!ses) return;
  ses.seq += 1;
  try {
    getDb().prepare(
      `INSERT INTO review_event (session_id, seq, kind, stage, payload) VALUES (?, ?, ?, ?, ?)`,
    ).run(ses.id, ses.seq, kind, stage ?? null, JSON.stringify(payload));
  } catch {
    // never let persistence failures break the live stream
  }
}

function broadcastDashboard(event: string, data: any) {
  if (dashboardClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of dashboardClients) res.write(payload);
}

// Kick off an indexing job for `${workspace}/${repo}`, tracking progress in
// activeIndexes and pushing index_progress / index_done events to dashboard
// SSE subscribers. Throttles broadcasts so very large repos don't flood the
// stream — the writer only sees a tick when the phase or files counter moves.
function startIndexJob(cfg: Config, key: string, localPath: string): Promise<void> {
  if (activeIndexes.has(key)) return Promise.resolve();
  const job: IndexJobState = {
    startedAt: Date.now(),
    files: 0, filesTotal: 0, symbols: 0, callSites: 0, phase: 'walk',
  };
  activeIndexes.set(key, job);
  broadcastDashboard('index_progress', { key, ...job });
  let lastEmit = 0;
  return indexProject(cfg, localPath, (p) => {
    job.phase = p.phase;
    job.files = p.filesScanned;
    job.filesTotal = p.filesTotal;
    job.symbols = p.symbolsFound;
    job.callSites = p.callSitesFound;
    const now = Date.now();
    if (p.phase === 'done' || p.phase === 'walk' || now - lastEmit >= 250) {
      lastEmit = now;
      broadcastDashboard('index_progress', { key, ...job });
    }
  })
    .then((stats) => {
      activeIndexes.delete(key);
      broadcastDashboard('index_done', { key, ok: true, ...stats });
    })
    .catch((err: any) => {
      job.phase = 'error';
      job.error = String(err?.message ?? err);
      activeIndexes.delete(key);
      broadcastDashboard('index_done', { key, ok: false, error: job.error });
    });
}

const TOTAL_WEIGHT = PIPELINE_STAGES.reduce((s, x) => s + x.weight, 0);

function summarizeForDashboard(s: AnalysisState) {
  const stage = s.currentStage ? PIPELINE_STAGES.find((x) => x.id === s.currentStage) : null;
  return {
    prId: s.prId,
    analyzing: true,
    currentStage: s.currentStage,
    currentLabel: stage?.label ?? null,
    percent: s.percent,
    etaMs: s.etaMs,
    elapsedMs: Date.now() - s.startedAt,
    lastAgent: s.lastAgent,
    stages: PIPELINE_STAGES.map((cfg) => {
      const st = s.stages.get(cfg.id);
      return {
        id: cfg.id,
        label: cfg.label,
        weight: cfg.weight,
        group: cfg.group,
        status: st?.status ?? 'pending',
        detail: st?.detail ?? null,
        elapsedMs: st?.startedAt ? (st.finishedAt ?? Date.now()) - st.startedAt : null,
      };
    }),
    groups: PIPELINE_GROUPS.map((g) => g.id),
  };
}

function recomputeProgress(s: AnalysisState) {
  let doneWeight = 0;
  let runningWeight = 0;
  let runningElapsed = 0;
  let runningStartedAt: number | null = null;
  for (const cfg of PIPELINE_STAGES) {
    const st = s.stages.get(cfg.id);
    if (!st) continue;
    if (st.status === 'done' || st.status === 'skipped') doneWeight += cfg.weight;
    else if (st.status === 'running') {
      runningWeight = cfg.weight;
      runningStartedAt = st.startedAt ?? null;
      runningElapsed = st.startedAt ? Date.now() - st.startedAt : 0;
    }
  }
  // Half-credit for currently running stage (visual continuity).
  const percent = Math.min(99, Math.round(((doneWeight + runningWeight * 0.5) / TOTAL_WEIGHT) * 100));
  s.percent = percent;
  // ETA: estimate from elapsed/percent if we have non-zero progress, else from total weight remaining at a default rate.
  const elapsed = Date.now() - s.startedAt;
  if (percent > 5 && percent < 99) {
    const projectedTotal = (elapsed / percent) * 100;
    s.etaMs = Math.round(Math.max(0, projectedTotal - elapsed));
  } else {
    s.etaMs = 0;
  }
  // void unused locals for future use
  void runningStartedAt; void runningElapsed;
}

export async function serve(cfg: Config, port: number) {
  const db = getDb();
  const bb = getForge(cfg);
  const diffCache = new Map<string, string>();

  // Boot sweep: nothing in the in-memory queue/active map exists across restarts,
  // so any row claiming ANALYZING or QUEUED is by definition stale.
  const stale = db.prepare(`SELECT id, state FROM pr WHERE state IN ('ANALYZING','QUEUED')`).all() as Array<{ id: string; state: string }>;
  if (stale.length > 0) {
    const upd = db.prepare(`UPDATE pr SET state='NEW' WHERE id=?`);
    const ev = db.prepare(`INSERT INTO state_event (pr_id, from_state, to_state, note) VALUES (?,?,?,?)`);
    for (const row of stale) { upd.run(row.id); ev.run(row.id, row.state, 'NEW', BOOT_SWEEP_NOTE); }
    console.log(`Boot sweep: reset ${stale.length} stale PR(s) (${stale.map(s => s.state).join(', ')}).`);
  }

  // ── Queue helpers ──────────────────────────────────────────────────────
  const setPrState = (prId: string, to: string, note?: string) => {
    const row = db.prepare(`SELECT state FROM pr WHERE id=?`).get(prId) as { state?: string } | undefined;
    const from = row?.state ?? null;
    if (from === to) return;
    db.prepare(`UPDATE pr SET state=? WHERE id=?`).run(to, prId);
    db.prepare(`INSERT INTO state_event (pr_id, from_state, to_state, note) VALUES (?,?,?,?)`).run(prId, from, to, note ?? null);
  };

  const queueSummary = (prId: string) => ({
    prId,
    analyzing: false,
    queued: true,
    queuePosition: analysisQueue.indexOf(prId) + 1,
    queueLength: analysisQueue.length,
  });

  function enqueueAnalysis(prId: string): { ok: true; queued: boolean; position?: number } | { ok: false; error: string } {
    if (activeAnalyses.has(prId)) return { ok: false, error: 'Already analyzing' };
    if (analysisQueue.includes(prId)) return { ok: false, error: 'Already queued' };
    if (activeAnalyses.size < MAX_CONCURRENT_ANALYSES) {
      runAnalysis(prId);
      return { ok: true, queued: false };
    }
    analysisQueue.push(prId);
    setPrState(prId, 'QUEUED', `queued: position ${analysisQueue.length}`);
    broadcastDashboard('queued', queueSummary(prId));
    return { ok: true, queued: true, position: analysisQueue.length };
  }

  function drainQueue() {
    while (activeAnalyses.size < MAX_CONCURRENT_ANALYSES && analysisQueue.length > 0) {
      const next = analysisQueue.shift()!;
      // Skip if it was reset/cancelled while waiting.
      const cur = db.prepare(`SELECT state FROM pr WHERE id=?`).get(next) as { state?: string } | undefined;
      if (cur?.state !== 'QUEUED') continue;
      runAnalysis(next);
    }
  }

  // If a local path is bound but the symbol index is missing or older than
  // INDEX_STALE_MS, kick off a background reindex. The analysis itself isn't
  // blocked — a stale index still produces a useful blast-radius signal — but
  // the next run will see fresh data, and the user gets visible feedback that
  // we're refreshing it.
  const INDEX_STALE_MS = 24 * 60 * 60 * 1000;
  function maybeAutoIndex(prId: string) {
    const row = db.prepare(`SELECT workspace, repo FROM pr WHERE id=?`).get(prId) as { workspace: string; repo: string } | undefined;
    if (!row) return;
    const pathRow = db.prepare(`SELECT local_path FROM project_path WHERE workspace=? AND repo=?`).get(row.workspace, row.repo) as { local_path: string } | undefined;
    if (!pathRow?.local_path) return;
    const key = `${row.workspace}/${row.repo}`;
    if (activeIndexes.has(key)) return;
    const idx = db.prepare(`SELECT MAX(indexed_at) as last FROM symbol_index WHERE repo_root=?`).get(pathRow.local_path) as { last: string | null } | undefined;
    const lastMs = idx?.last ? Date.parse(idx.last + 'Z') : 0;
    if (lastMs && Date.now() - lastMs < INDEX_STALE_MS) return;
    // Fire-and-forget; broadcastDashboard surfaces progress to the UI.
    startIndexJob(cfg, key, pathRow.local_path);
  }

  function runAnalysis(prId: string) {
    maybeAutoIndex(prId);
    const abort = new AbortController();
    runHandles.set(prId, { abort, cancelled: false });
    const state: AnalysisState = {
      prId,
      startedAt: Date.now(),
      logs: [],
      triage: [],
      stages: new Map(),
      currentStage: null,
      percent: 0,
      etaMs: 0,
      agentEvents: [],
      lastAgent: null,
    };
    activeAnalyses.set(prId, state);
    db.prepare(`UPDATE pr SET last_heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(prId);

    // Open a new review_session row. Every analyze/reanalyze gets its own id.
    const sessionRes = db.prepare(
      `INSERT INTO review_session (pr_id, trigger, provider, model, status) VALUES (?, ?, ?, ?, 'running')`,
    ).run(prId, 'analyze', cfg.provider?.default ?? null, (cfg as any)?.model ?? null);
    const sessionId = Number(sessionRes.lastInsertRowid);
    activeSessions.set(prId, { id: sessionId, seq: 0 });
    persistEvent(prId, 'session_start', { prId, startedAt: state.startedAt });

    broadcast(prId, 'status', { analyzing: true, sessionId });
    broadcastDashboard('start', { ...summarizeForDashboard(state), sessionId });

    const closeSession = (status: 'completed' | 'cancelled' | 'error', extra: any = {}) => {
      const s = activeAnalyses.get(prId);
      const finalPercent = s?.percent ?? null;
      try {
        db.prepare(
          `UPDATE review_session SET ended_at=CURRENT_TIMESTAMP, status=?, cancelled=?, error=?, final_percent=? WHERE id=?`,
        ).run(
          status,
          status === 'cancelled' ? 1 : 0,
          extra.error ?? null,
          finalPercent,
          sessionId,
        );
      } catch { /* ignore */ }
      persistEvent(prId, 'session_end', { status, ...extra });
      activeSessions.delete(prId);
    };

    analyzePR(cfg, prId, {
      reAnalyze: true,
      signal: abort.signal,
      onLog: (msg) => {
        const s = activeAnalyses.get(prId);
        if (s) s.logs.push(msg);
        broadcast(prId, 'log', msg);
        persistEvent(prId, 'log', msg);
      },
      onTriage: (items) => {
        const s = activeAnalyses.get(prId);
        if (s) s.triage = items;
        broadcast(prId, 'triage', items);
        persistEvent(prId, 'triage', items);
      },
      onStage: (e: StageEvent) => {
        const s = activeAnalyses.get(prId);
        if (!s) return;
        const existing = s.stages.get(e.stage) ?? { id: e.stage, status: 'pending' as StageStatus };
        if (e.status === 'running') {
          existing.startedAt = e.ts;
          s.currentStage = e.stage;
        } else if (e.status === 'done' || e.status === 'skipped' || e.status === 'error') {
          existing.finishedAt = e.ts;
          if (s.currentStage === e.stage) s.currentStage = null;
        }
        existing.status = e.status;
        existing.detail = e.detail;
        s.stages.set(e.stage, existing);
        recomputeProgress(s);
        // Heartbeat: prove the run is alive.
        db.prepare(`UPDATE pr SET last_heartbeat_at=CURRENT_TIMESTAMP WHERE id=?`).run(prId);
        const summary = summarizeForDashboard(s);
        broadcast(prId, 'stage', summary);
        broadcastDashboard('progress', summary);
        persistEvent(prId, 'stage', { stage: e.stage, status: e.status, detail: e.detail, ts: e.ts }, e.stage);
      },
      onAgentEvent: (stageName: string, ev: AgentEvent) => {
        const s = activeAnalyses.get(prId);
        if (!s) return;
        const tagged = { ...ev, stage: stageName } as AgentEvent & { stage: string };
        s.agentEvents.push(tagged);
        if (s.agentEvents.length > MAX_AGENT_EVENTS) s.agentEvents.splice(0, s.agentEvents.length - MAX_AGENT_EVENTS);
        s.lastAgent = tagged;
        broadcast(prId, 'agent', tagged);
        broadcastDashboard('agent', { prId, stage: stageName, event: tagged });
        persistEvent(prId, 'agent', tagged, stageName);
      },
    }).then(() => {
      const handle = runHandles.get(prId);
      const s = activeAnalyses.get(prId);
      activeAnalyses.delete(prId);
      runHandles.delete(prId);
      const finalPercent = s?.percent ?? 100;
      if (handle?.cancelled) {
        closeSession('cancelled');
        broadcast(prId, 'done', { ok: false, cancelled: true });
        broadcastDashboard('end', { prId, ok: false, cancelled: true });
      } else {
        closeSession('completed');
        broadcast(prId, 'done', { ok: true });
        broadcastDashboard('end', { prId, ok: true, finalPercent });
      }
      drainQueue();
    }).catch((e: any) => {
      const handle = runHandles.get(prId);
      activeAnalyses.delete(prId);
      runHandles.delete(prId);
      if (handle?.cancelled) {
        // pr.ts catch handler already reverted state to NEW with note. Nothing else to do.
        closeSession('cancelled');
        broadcast(prId, 'done', { ok: false, cancelled: true });
        broadcastDashboard('end', { prId, ok: false, cancelled: true });
      } else {
        closeSession('error', { error: e.message });
        broadcast(prId, 'done', { ok: false, error: e.message });
        broadcastDashboard('end', { prId, ok: false, error: e.message });
      }
      drainQueue();
    });
  }

  function cancelAnalysis(prId: string): { ok: boolean; where: 'queue' | 'active' | 'none' } {
    const qIdx = analysisQueue.indexOf(prId);
    if (qIdx >= 0) {
      analysisQueue.splice(qIdx, 1);
      setPrState(prId, 'NEW', 'cancelled while queued');
      broadcastDashboard('end', { prId, ok: false, cancelled: true });
      return { ok: true, where: 'queue' };
    }
    const handle = runHandles.get(prId);
    if (handle) {
      handle.cancelled = true;
      handle.abort.abort();
      // The .catch in runAnalysis will fire when subprocess exits; it cleans up state.
      // Also revert DB state immediately so UI reflects cancellation without waiting for the kill.
      setPrState(prId, 'NEW', 'cancelled while running');
      return { ok: true, where: 'active' };
    }
    return { ok: false, where: 'none' };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      // Match against the raw (encoded) pathname so percent-encoded slashes in
      // path segments — e.g. project keys like `workspace%2Frepo` — survive
      // routing. Individual handlers decodeURIComponent on the captured key.
      const pathname = url.pathname;

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderIndex(db, cfg));
        return;
      }

      if (pathname === '/docs') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderDocs());
        return;
      }

      const prMatch = pathname.match(/^\/pr\/([\w:.\-]+)$/);
      if (prMatch) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderPR(db, prMatch[1]));
        return;
      }

      const streamMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/stream$/);
      if (streamMatch && req.method === 'GET') {
        const prId = streamMatch[1];
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        if (!sseClients.has(prId)) sseClients.set(prId, new Set());
        sseClients.get(prId)!.add(res);

        const state = activeAnalyses.get(prId);
        const initPayload: any = {
          analyzing: !!state,
          logs: state?.logs || [],
          triage: state?.triage || [],
          agent: state?.agentEvents || [],
        };
        if (state) initPayload.summary = summarizeForDashboard(state);
        res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);

        req.on('close', () => {
          const clients = sseClients.get(prId);
          if (clients) {
            clients.delete(res);
            if (clients.size === 0) sseClients.delete(prId);
          }
        });
        return;
      }

      // Multiplexed dashboard stream: every active PR's progress, on a single connection.
      if (pathname === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        dashboardClients.add(res);
        const initial = [...activeAnalyses.values()].map(summarizeForDashboard);
        const indexes = [...activeIndexes.entries()].map(([key, job]) => ({ key, ...job }));
        res.write(`event: init\ndata: ${JSON.stringify({ active: initial, indexes })}\n\n`);
        req.on('close', () => { dashboardClients.delete(res); });
        return;
      }

      if (pathname === '/api/prs/sync' && req.method === 'POST') {
        try {
          await listPRs(cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      const diffMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/diff$/);
      if (diffMatch && req.method === 'GET') {
        const id = diffMatch[1];
        let diff = diffCache.get(id);
        if (!diff) {
          diff = await bb.getDiff(idToRef(id));
          diffCache.set(id, diff);
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(diff);
        return;
      }

      const editMatch = pathname.match(/^\/api\/comment\/(\d+)$/);
      if (editMatch && req.method === 'POST') {
        const body = await readBody(req);
        const { current_body, severity, action, category, reject_reason } = JSON.parse(body);
        const fields: string[] = [];
        const vals: any[] = [];
        if (current_body !== undefined) { fields.push('current_body=?'); vals.push(current_body); }
        if (severity !== undefined) { fields.push('severity=?'); vals.push(severity); }
        if (category !== undefined) { fields.push('category=?'); vals.push(category); }
        if (action !== undefined) { fields.push('action=?'); vals.push(action); }
        if (reject_reason !== undefined) { fields.push('reject_reason=?'); vals.push(reject_reason); }
        if (fields.length) {
          vals.push(Number(editMatch[1]));
          db.prepare(`UPDATE comment_draft SET ${fields.join(', ')} WHERE id=?`).run(...vals);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      const addMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/comment$/);
      if (addMatch && req.method === 'POST') {
        const prId = addMatch[1];
        const { file, line, side, severity, category, body } = JSON.parse(await readBody(req));
        const a = db
          .prepare(`SELECT id FROM analysis WHERE pr_id=? ORDER BY id DESC LIMIT 1`)
          .get(prId) as { id: number } | undefined;
        if (!a) { res.writeHead(400); res.end('no analysis'); return; }
        db.prepare(`
          INSERT INTO comment_draft (analysis_id, file, line, side, severity, ai_original_body, current_body, action, confidence, category)
          VALUES (?,?,?,?,?,?,?, 'added', 1.0, ?)
        `).run(a.id, file, Number(line), side ?? 'new', severity ?? 'suggestion', '', body, category ?? 'correctness');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      const submitMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/submit$/);
      if (submitMatch && req.method === 'POST') {
        const prId = submitMatch[1];
        const a = db
          .prepare(`SELECT id FROM analysis WHERE pr_id=? ORDER BY id DESC LIMIT 1`)
          .get(prId) as { id: number } | undefined;
        if (!a) { res.writeHead(400); res.end('no analysis'); return; }
        const drafts = db
          .prepare(`SELECT * FROM comment_draft WHERE analysis_id=? AND action != 'deleted' ORDER BY id`)
          .all(a.id) as Array<any>;
        // const footer = cfg.reviewer.botFooter.replace('{name}', cfg.reviewer.name);
        let posted = 0;
        const errors: string[] = [];
        for (const d of drafts) {
          const body = d.current_body;
          try {
            await bb.postInlineComment(idToRef(prId), d.file, d.line, d.side ?? 'new', body);
            posted++;
          } catch (e: any) {
            errors.push(`#${d.id} ${d.file}:${d.line} — ${e.message}`);
          }
        }
        db.prepare(`UPDATE pr SET state='SUBMITTED' WHERE id=?`).run(prId);
        db.prepare(`INSERT INTO state_event (pr_id, from_state, to_state, note) VALUES (?,?,?,?)`).run(
          prId, 'DRAFT_READY', 'SUBMITTED', errors.length ? `errors: ${errors.length}` : null,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, posted, errors }));
        return;
      }

      const resetMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/reset$/);
      if (resetMatch && req.method === 'POST') {
        const prId = resetMatch[1];
        const r = cancelAnalysis(prId);
        if (!r.ok) {
          // Not running, not queued — could still be a stuck DB row. Reset it directly.
          const cur = db.prepare(`SELECT state FROM pr WHERE id=?`).get(prId) as { state?: string } | undefined;
          if (cur && (cur.state === 'ANALYZING' || cur.state === 'QUEUED')) {
            setPrState(prId, 'NEW', 'manual reset (no in-memory handle)');
            broadcastDashboard('end', { prId, ok: false, cancelled: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, where: 'db' }));
            return;
          }
        }
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r));
        return;
      }

      const analyzeMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/analyze$/);
      if (analyzeMatch && req.method === 'POST') {
        const prId = analyzeMatch[1];
        const result = enqueueAnalysis(prId);
        res.writeHead(result.ok ? 202 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      const sessionsListMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/sessions$/);
      if (sessionsListMatch && req.method === 'GET') {
        const prId = sessionsListMatch[1];
        const rows = db.prepare(
          `SELECT s.id, s.started_at, s.ended_at, s.status, s.trigger, s.provider, s.model,
                  s.cancelled, s.error, s.final_percent,
                  (SELECT COUNT(*) FROM review_event e WHERE e.session_id = s.id) AS event_count
             FROM review_session s
            WHERE s.pr_id = ?
            ORDER BY s.id DESC`,
        ).all(prId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
        return;
      }

      const sessionEventsMatch = pathname.match(/^\/api\/session\/(\d+)\/events$/);
      if (sessionEventsMatch && req.method === 'GET') {
        const sessionId = Number(sessionEventsMatch[1]);
        const session = db.prepare(`SELECT * FROM review_session WHERE id=?`).get(sessionId);
        if (!session) { res.writeHead(404); res.end('no session'); return; }
        const events = db.prepare(
          `SELECT id, seq, ts, kind, stage, payload FROM review_event WHERE session_id=? ORDER BY seq`,
        ).all(sessionId) as Array<any>;
        for (const e of events) {
          try { e.payload = JSON.parse(e.payload); } catch { /* keep raw */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session, events }));
        return;
      }

      if (pathname === '/api/projects/scan' && req.method === 'POST') {
        try {
          const repos = scanLocalRepos();
          const matched = autoMatchProjects(db, repos);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, found: repos.length, matched }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
      }

      if (pathname === '/api/projects' && req.method === 'GET') {
        const projects = getProjects(db).map(p => {
          const job = activeIndexes.get(`${p.workspace}/${p.repo}`);
          return { ...p, indexing: !!job, progress: job ? { phase: job.phase, files: job.files, filesTotal: job.filesTotal, symbols: job.symbols } : null };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(projects));
        return;
      }

      const candidatesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/candidates$/);
      if (candidatesMatch && req.method === 'GET') {
        const key = decodeURIComponent(candidatesMatch[1]);
        const [workspace, ...repoParts] = key.split('/');
        const repo = repoParts.join('/');
        const candidates = findCandidates(workspace, repo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(candidates));
        return;
      }

      const projectPathMatch = pathname.match(/^\/api\/projects\/([^/]+)\/path$/);
      if (projectPathMatch && req.method === 'POST') {
        const key = decodeURIComponent(projectPathMatch[1]);
        const [workspace, ...repoParts] = key.split('/');
        const repo = repoParts.join('/');
        const { local_path } = JSON.parse(await readBody(req));
        if (!local_path) { res.writeHead(400); res.end('missing local_path'); return; }
        db.prepare(`INSERT OR REPLACE INTO project_path (workspace, repo, local_path) VALUES (?,?,?)`)
          .run(workspace, repo, local_path);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      const projectIndexMatch = pathname.match(/^\/api\/projects\/([^/]+)\/index$/);
      if (projectIndexMatch && req.method === 'POST') {
        const key = decodeURIComponent(projectIndexMatch[1]);
        const [workspace, ...repoParts] = key.split('/');
        const repo = repoParts.join('/');
        if (activeIndexes.has(key)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Already indexing' }));
          return;
        }
        const pathRow = db.prepare(`SELECT local_path FROM project_path WHERE workspace=? AND repo=?`).get(workspace, repo) as { local_path: string } | undefined;
        if (!pathRow?.local_path) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No local path set for this project' }));
          return;
        }
        startIndexJob(cfg, key, pathRow.local_path);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err: any) {
      console.error('[serve] request error:', req.url, err?.message ?? err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err.message ?? err));
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Lens UI: http://localhost:${port}`);
  });
}

const LOGO_SVG = `<svg width="80" height="32" viewBox="0 0 100 40" xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="28" fill="#0969da" style="font: bold 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; letter-spacing: -0.5px;">Lens</text>
</svg>`;

// Shared "Thinking Log" component — used by the PR detail drawer and the
// dashboard's expanded row. Keeps DOM mutations local (no innerHTML resets on
// the parent) so updates don't cause layout shifts. Coalesces consecutive
// text/thinking events from the same stage into one block, parses fenced code
// blocks into <pre><code>, and pretty-prints JSON. Sticky auto-scroll: only
// follows the tail when the user is already near the bottom.
const THINKING_LOG_CSS = `<style>
  .tl-root { font-family: var(--mono); font-size: 12px; line-height: 1.55; }
  .tl-row { display:flex; gap:10px; align-items:flex-start; padding:3px 0;
            opacity:0; transform: translateY(2px);
            transition: opacity 160ms ease, transform 160ms ease; }
  .tl-row.tl-in { opacity:1; transform: translateY(0); }
  .tl-stage { font-size:10px; color:var(--fg-muted); flex:0 0 auto;
              min-width:54px; padding-top:2px;
              text-transform:uppercase; letter-spacing:0.04em; }
  .tl-body { flex:1; min-width:0; word-break:break-word; }
  .tl-thinking .tl-body { font-style:italic; color:var(--fg-muted); }
  .tl-tool_use .tl-body { color:var(--accent-blue, #0969da); }
  .tl-tool_use .tl-tool { font-weight:700; }
  .tl-tool_use .tl-tool-args { color:var(--fg-muted); font-weight:400; }
  .tl-tool_result .tl-body { color:var(--fg-muted); padding-left:14px; }
  .tl-row.tl-err .tl-body { color:var(--accent-red, #cf222e); }
  .tl-status .tl-body { color:var(--fg-muted); font-size:11px; }
  .tl-prose { white-space:pre-wrap; }
  .tl-code { background:rgba(110,118,129,0.08);
             border:1px solid var(--border, #d0d7de);
             border-radius:6px; padding:8px 10px; margin:6px 0;
             font-size:11.5px; overflow-x:auto; white-space:pre;
             max-height:320px; overflow-y:auto; }
  .tl-code code { background:none; padding:0; font-family: var(--mono); }
  .tl-placeholder { color:var(--fg-muted); padding:8px 0; }
  .tl-ok { color:var(--accent-green, #1f883d); }
  .tl-fail { color:var(--accent-red, #cf222e); }
  /* Compact variant for the dashboard expanded row. */
  .tl-compact .tl-row { padding:1px 0; }
  .tl-compact .tl-stage { min-width:42px; font-size:9px; }
  .tl-compact .tl-code { display:none; }
  @media (prefers-reduced-motion: reduce) {
    .tl-row { transition:none; opacity:1; transform:none; }
  }
</style>`;

const THINKING_LOG_JS = `<script>
window.ThinkingLog = (function(){
  function escapeHtml(s){
    return (s == null ? '' : String(s))
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
  }
  function fmtStage(s){
    if (!s) return '';
    return s.split('_').map(function(w){
      return w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
    }).join(' ');
  }
  // Split a coalesced text body around fenced \`\`\`code\`\`\` blocks.
  function renderTextBody(text){
    var parts = [];
    var re = /\`\`\`([a-zA-Z0-9_-]*)\\n?([\\s\\S]*?)\`\`\`/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push({type:'p', text: text.slice(last, m.index)});
      parts.push({type:'code', lang: m[1] || '', text: m[2]});
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({type:'p', text: text.slice(last)});
    if (parts.length === 0) parts.push({type:'p', text: text});
    return parts.map(function(p){
      if (p.type === 'code') {
        var pretty = p.text;
        if ((p.lang || '').toLowerCase() === 'json') {
          try { pretty = JSON.stringify(JSON.parse(p.text), null, 2); } catch(e){}
        }
        return '<pre class="tl-code"><code>' + escapeHtml(pretty) + '</code></pre>';
      }
      return '<span class="tl-prose">' + escapeHtml(p.text) + '</span>';
    }).join('');
  }
  function mount(container, opts){
    opts = opts || {};
    container.classList.add('tl-root');
    if (opts.compact) container.classList.add('tl-compact');
    var maxRows = opts.maxRows || 0;
    var state = { lastBlock:null, lastKind:null, lastStage:null,
                  autoScroll:true, rowCount:0, cleared:false };
    container.addEventListener('scroll', function(){
      var nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 24;
      state.autoScroll = nearBottom;
    });
    function maybeScroll(){
      if (state.autoScroll) container.scrollTop = container.scrollHeight;
    }
    function trim(){
      if (!maxRows) return;
      while (state.rowCount > maxRows && container.firstElementChild) {
        container.removeChild(container.firstElementChild);
        state.rowCount--;
      }
    }
    function ensureCleared(){
      if (state.cleared) return;
      Array.prototype.slice.call(container.children).forEach(function(c){
        if (!c.classList || (!c.classList.contains('tl-row') && !c.classList.contains('tl-placeholder'))) {
          container.removeChild(c);
        }
      });
      state.cleared = true;
    }
    function newRow(kind, stage){
      var row = document.createElement('div');
      row.className = 'tl-row tl-' + kind;
      var gutter = document.createElement('span');
      gutter.className = 'tl-stage';
      gutter.textContent = fmtStage(stage || '');
      var body = document.createElement('span');
      body.className = 'tl-body';
      row.appendChild(gutter);
      row.appendChild(body);
      container.appendChild(row);
      requestAnimationFrame(function(){ row.classList.add('tl-in'); });
      state.rowCount++;
      trim();
      return body;
    }
    function append(ev){
      if (!ev) return;
      ensureCleared();
      var ph = container.querySelector('.tl-placeholder');
      if (ph) ph.remove();
      var stage = ev.stage || null;
      if (ev.kind === 'text' || ev.kind === 'thinking') {
        if (state.lastKind === ev.kind && state.lastStage === stage && state.lastBlock) {
          state.lastBlock._raw = (state.lastBlock._raw || '') + (ev.text || '');
          state.lastBlock.innerHTML = renderTextBody(state.lastBlock._raw);
        } else {
          var body = newRow(ev.kind, ev.stage);
          body._raw = ev.text || '';
          body.innerHTML = renderTextBody(body._raw);
          state.lastBlock = body;
          state.lastKind = ev.kind;
          state.lastStage = stage;
        }
      } else if (ev.kind === 'tool_use') {
        var b2 = newRow('tool_use', ev.stage);
        var inp = ev.input ? ' ' + JSON.stringify(ev.input).slice(0, 300) : '';
        b2.innerHTML = '<span class="tl-arrow">▸</span> <span class="tl-tool">' + escapeHtml(ev.name || '') + '</span><span class="tl-tool-args">' + escapeHtml(inp) + '</span>';
        state.lastBlock = null; state.lastKind = 'tool_use'; state.lastStage = stage;
      } else if (ev.kind === 'tool_result') {
        var row = newRow('tool_result', ev.stage);
        if (ev.ok === false) row.parentElement.classList.add('tl-err');
        row.innerHTML = (ev.ok ? '<span class="tl-ok">✓</span> ' : '<span class="tl-fail">✗</span> ') + escapeHtml((ev.summary || '').slice(0, 400));
        state.lastBlock = null; state.lastKind = 'tool_result'; state.lastStage = stage;
      } else if (ev.kind === 'status') {
        var b4 = newRow('status', ev.stage);
        b4.textContent = '[' + (ev.phase || '') + (ev.detail ? ': ' + ev.detail : '') + ']';
        state.lastBlock = null; state.lastKind = 'status'; state.lastStage = stage;
      }
      maybeScroll();
    }
    function clear(){
      container.innerHTML = '';
      state.lastBlock = null; state.lastKind = null; state.lastStage = null;
      state.rowCount = 0; state.cleared = true;
    }
    function setPlaceholder(text){
      clear();
      var p = document.createElement('div');
      p.className = 'tl-placeholder';
      p.textContent = text;
      container.appendChild(p);
    }
    return { append: append, clear: clear, setPlaceholder: setPlaceholder };
  }
  return { mount: mount };
})();
</script>`;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function forgeStatusBadge(r: any): string {
  const fs = (r.forge_state ?? 'OPEN') as string;
  // Draft overrides forge_state for display (forge_state may still be OPEN).
  const display = r.is_draft ? 'DRAFT' : fs;
  return `<span class="ForgeState ForgeState--${display}" title="Forge state: ${display}">${display}</span>`;
}

function renderIndex(db: ReturnType<typeof getDb>, cfg: Config): string {
  const rows = db
    .prepare(`SELECT id, workspace, repo, number, title, author, state, source_branch, dest_branch, url, last_heartbeat_at, forge_state, is_draft
              FROM pr ORDER BY workspace, repo, updated_at DESC`)
    .all() as Array<any>;
  const now = Date.now();
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = `${r.workspace}/${r.repo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const sections = [...groups.entries()].map(([repoKey, list]) => {
    const [workspace, ...repoParts] = repoKey.split('/');
    const repo = repoParts.join('/');
    const pathRow = db.prepare(`SELECT local_path FROM project_path WHERE workspace=? AND repo=?`).get(workspace, repo) as { local_path: string } | undefined;
    const localPath = pathRow?.local_path ?? null;
    let lastIndexed: string | null = null;
    let symbolCount = 0;
    if (localPath) {
      const idxRow = db.prepare(`SELECT MAX(indexed_at) as last, SUM(kind='def') as cnt FROM symbol_index WHERE repo_root=?`).get(localPath) as { last: string | null; cnt: number } | undefined;
      lastIndexed = idxRow?.last ?? null;
      symbolCount = idxRow?.cnt ?? 0;
    }
    const ek = encodeURIComponent(repoKey);
    // Single index badge whose contents are mutated client-side as SSE
    // index_progress events arrive. Server renders the initial state from DB
    // (no local path / not indexed / N symbols), and the dashboard SSE client
    // upgrades it in place to "Indexing… 1234 / 4800 files" while a job runs.
    let indexBadgeBody: string;
    if (!localPath) {
      indexBadgeBody = `No local path — <button class="btn-link" style="font-size:11px;" onclick="scanForRepo('${ek}',this)">scan</button> or <button class="btn-link" style="font-size:11px;" onclick="setRepoPath('${ek}')">set path</button>`;
    } else if (!lastIndexed) {
      indexBadgeBody = `Not indexed — <button class="btn-link" style="font-size:11px;color:var(--accent-blue,#0969da);" onclick="indexRepo('${ek}',this)">Index now</button>`;
    } else {
      indexBadgeBody = `${symbolCount} symbols · ${new Date(lastIndexed).toLocaleDateString()} — <button class="btn-link" style="font-size:11px;" onclick="indexRepo('${ek}',this)">re-index</button>`;
    }
    const indexBadge = `<span class="idx-badge" data-idx-key="${ek}" style="font-size:11px;color:var(--fg-muted);font-weight:400;">${indexBadgeBody}</span>`;
    const items = list.map((r) => {
      const search = escape((r.title ?? '') + ' ' + (r.author ?? '') + ' ' + (r.source_branch ?? '') + ' ' + (r.dest_branch ?? '') + ' ' + (r.number ?? r.id)).toLowerCase();
      // Stuck detection: ANALYZING with no heartbeat within STUCK_HEARTBEAT_MS
      // (or no heartbeat at all → assume stale; boot-sweep should have handled it).
      const isAnalyzing = r.state === 'ANALYZING';
      const isQueued = r.state === 'QUEUED';
      const hbMs = r.last_heartbeat_at ? Date.parse(r.last_heartbeat_at + 'Z') : 0;
      const isStuck = isAnalyzing && (!hbMs || (now - hbMs > STUCK_HEARTBEAT_MS));
      const showResetBtn = isAnalyzing || isQueued;
      const stuckBadge = isStuck ? `<span class="pr-stuck-badge" title="No heartbeat for >3min — likely stale" style="margin-left:6px; color:var(--accent-red,#cf222e); font-size:11px;">⚠ stuck</span>` : '';
      const resetBtn = showResetBtn ? `<button class="btn-link pr-reset-btn" data-pr-id="${escape(r.id)}" style="font-size:11px; margin-left:6px;">Reset</button>` : '';
      const authorLc = (r.author ?? '').toLowerCase();
      const stateBucket = (r.state === 'NEW' || r.state === 'QUEUED' || r.state === 'ANALYZING') ? 'open' : 'reviewed';
      return `<tr class="pr-row" data-pr-id="${escape(r.id)}" data-search="${search}" data-author="${escape(authorLc)}" data-state-bucket="${stateBucket}">
      <td style="width:28px; padding:6px 4px 6px 12px;">
        <input type="checkbox" class="pr-checkbox" data-pr-id="${escape(r.id)}" onclick="event.stopPropagation()">
      </td>
      <td style="width:24px; padding-right:0; text-align:center;">
        <span class="pr-expand-arrow" data-toggle="${escape(r.id)}" style="cursor:pointer; color:var(--fg-muted); display:inline-block; transition:transform 0.15s; user-select:none;">▸</span>
      </td>
      <td style="width: 80px; font-family: var(--mono); color: var(--fg-muted); font-size: 12px;">#${r.number ?? r.id}</td>
      <td><a href="/pr/${r.id}" style="font-weight: 500;">${escape(r.title ?? '')}</a></td>
      <td style="font-size: 13px; color: var(--fg-muted);">${escape(r.author ?? '')}</td>
      <td style="font-size: 13px; color: var(--fg-muted);">${escape(r.source_branch ?? '')} <span style="opacity: 0.3">→</span> ${escape(r.dest_branch ?? '')}</td>
      <td class="pr-state-cell"><span class="state-stack">${forgeStatusBadge(r)}<span class="State State--${r.state} pr-state-static">${formatLabel(r.state)}</span>${stuckBadge}${resetBtn}<span class="pr-state-live" style="display:none;"></span></span></td>
      <td style="text-align: right;">${r.url ? `<a href="${r.url}" target="_blank" class="btn-link text-small">Open ↗</a>` : ''}</td>
    </tr>
    <tr class="pr-stage-row" data-pr-id="${escape(r.id)}" style="display:none;">
      <td colspan="8" style="background:rgba(0,0,0,0.02); padding:0;">
        <div class="pr-stage-content" style="padding:14px 20px 14px 56px; font-size:12px;">
          <div class="pr-stage-empty" style="color:var(--fg-muted);">Not currently analyzing — last run details on the PR detail page.</div>
        </div>
      </td>
    </tr>`;
    }).join('');
    return `<div class="Box mb-4 shadow-sm" data-repo-group="${escape(repoKey)}">
      <div class="Box-header" style="display:flex;align-items:center;gap:12px;">
        <h3 class="Box-title" style="font-weight:500;flex:0 0 auto;">${escape(repoKey)} <span class="Counter ml-2">${list.length}</span></h3>
        <div style="flex:1;">${indexBadge}</div>
      </div>
      <table class="dashboard-table">
        <tbody>${items}</tbody>
      </table>
    </div>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dashboard — Lens</title>
  ${BASE_CSS}
</head>
<body>
  <header class="Header">
    <div class="Header-item">
      <a href="/" class="Header-link d-flex flex-items-center" style="padding: 0;">
        <div style="color: var(--primary-black); display: flex;">${LOGO_SVG}</div>
      </a>
    </div>
    <div class="Header-item Header-item--full"></div>
    <div class="Header-item">
      <a href="/docs" class="Header-link" style="font-weight: 500; font-size: 14px;">Docs</a>
    </div>
  </header>

  ${THINKING_LOG_CSS}
  <style>
    .pr-progress-bar { display:inline-block; height:6px; background:var(--accent-blue-dim, #ddf4ff); border-radius:3px; overflow:hidden; vertical-align:middle; min-width:80px; max-width:140px; }
    .pr-progress-fill { height:100%; background:var(--accent-blue, #0969da); transition:width 250ms ease; width:0%; }
    .pr-progress-text { font-family:var(--mono); font-size:11px; color:var(--fg-muted); white-space:nowrap;
                        font-variant-numeric: tabular-nums; min-width: 220px; display:inline-block; }
    .pr-stage-elapsed { font-variant-numeric: tabular-nums; }
    .pr-state-live { display:flex; align-items:center; gap:8px; }
    .pr-row.is-expanded .pr-expand-arrow { transform: rotate(90deg); }
    /* Linear pipeline: dots connected by a horizontal rail. Each stage is a
       fixed-share column with the dot above the label so the row is read
       left-to-right with no wrapping clutter. The connector left of each dot
       is colored by this stage's status, so the rail visually fills as work
       advances. Stage detail (e.g. "57 files") moves to a native tooltip. */
    .pr-stage-list {
      display:flex; align-items:flex-start; gap:0;
      padding:18px 4px 8px; font-family: var(--mono);
    }
    .pr-stage-groups { display:flex; flex-direction:column; gap:10px; }
    .pr-stage-group {
      border:1px solid var(--border, #d0d7de); border-radius:8px;
      background: var(--canvas-subtle, #f6f8fa); padding:6px 12px 10px;
    }
    .pr-stage-group.is-running { border-color: var(--accent-blue, #0969da); background: rgba(9,105,218,0.04); }
    .pr-stage-group.is-done    { border-color: var(--accent-green, #1f883d); background: rgba(31,136,61,0.04); }
    .pr-stage-group.is-error   { border-color: var(--accent-red, #cf222e); background: rgba(207,34,46,0.04); }
    .pr-stage-group-header {
      display:flex; align-items:center; justify-content:space-between;
      padding:6px 4px 0; font-family: var(--mono);
    }
    .pr-stage-group-title { font-size:12px; font-weight:700; letter-spacing:0.02em; color:var(--fg, #1f2328); }
    .pr-stage-group-status { font-size:10.5px; color:var(--fg-muted, #656d76); text-transform:uppercase; letter-spacing:0.05em; }
    .pr-stage-group.is-running .pr-stage-group-status { color: var(--accent-blue, #0969da); }
    .pr-stage-group.is-done    .pr-stage-group-status { color: var(--accent-green, #1f883d); }
    .pr-stage-group.is-error   .pr-stage-group-status { color: var(--accent-red, #cf222e); }
    .pr-stage-group .pr-stage-list { padding:14px 4px 4px; }
    .pr-stage-item {
      flex: 1 1 0; min-width:0;
      display:flex; flex-direction:column; align-items:center;
      position:relative; text-align:center;
    }
    .pr-stage-item:not(:first-child)::before {
      content:''; position:absolute; top:6px;
      left:calc(-50% + 10px); right:calc(50% + 10px);
      height:2px; background: var(--border, #d0d7de);
      transition: background 250ms ease;
    }
    .pr-stage-item.is-done::before,
    .pr-stage-item.is-running::before,
    .pr-stage-item.is-skipped::before { background: var(--accent-green, #1f883d); }
    .pr-stage-item.is-error::before { background: var(--accent-red, #cf222e); }
    .pr-stage-dot {
      width:10px; height:10px; border-radius:50%;
      background: var(--border, #d0d7de);
      position:relative; z-index:1;
      box-shadow: 0 0 0 3px var(--canvas, #fff);
      transition: background 200ms ease, box-shadow 200ms ease;
    }
    .pr-stage-item.is-running .pr-stage-dot {
      background: var(--accent-blue, #0969da);
      box-shadow: 0 0 0 3px var(--canvas, #fff), 0 0 0 6px rgba(9,105,218,0.18);
      animation: pr-pulse 1.4s ease-in-out infinite;
    }
    .pr-stage-item.is-done .pr-stage-dot,
    .pr-stage-item.is-skipped .pr-stage-dot { background: var(--accent-green, #1f883d); }
    .pr-stage-item.is-error .pr-stage-dot { background: var(--accent-red, #cf222e); }
    .pr-stage-label {
      margin-top:10px; font-size:11px; font-weight:500; line-height:1.3;
      color: var(--fg-muted, #656d76);
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      max-width:100%; padding:0 4px; transition: color 200ms ease;
    }
    .pr-stage-item.is-running .pr-stage-label,
    .pr-stage-item.is-done .pr-stage-label { color: var(--fg, #1f2328); }
    .pr-stage-item.is-error .pr-stage-label { color: var(--accent-red, #cf222e); }
    .pr-stage-elapsed {
      margin-top:3px; font-size:10px; color: var(--fg-muted);
      font-variant-numeric: tabular-nums; min-height:13px;
    }
    /* Detail moved to native tooltip on hover — keeps the rail uncluttered. */
    .pr-stage-item[title]:not([title=""]) .pr-stage-label::after {
      content:' ⓘ'; opacity:0.45; font-size:9px;
    }
    .pr-thinking-log { margin-top:14px; max-height:140px; overflow:auto;
                       border-top:1px dashed var(--border, #d0d7de); padding-top:8px; }
    @keyframes pr-pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
    .idx-badge { transition: color 200ms ease; }
    .idx-spin { display:inline-block; width:8px; height:8px; border-radius:50%;
                background: var(--accent-blue, #0969da); margin-right:4px;
                vertical-align: middle; animation: pr-pulse 1.2s ease-in-out infinite; }
    .pr-checkbox { cursor:pointer; }
    .pr-action-bar { position:fixed; bottom:0; left:0; right:0; background:var(--canvas,#fff); border-top:1px solid var(--border,#d0d7de); padding:10px 20px; box-shadow: 0 -2px 8px rgba(0,0,0,0.06); display:none; z-index:200; align-items:center; gap:12px; }
    .pr-action-bar.is-open { display:flex; }
    .pr-action-bar .pr-action-count { font-weight:600; }
    .pr-action-bar .pr-action-spacer { flex:1; }
    .State.State--QUEUED { background: #fff8e1; color: #8a6d00; }
    .pr-reset-btn { color: var(--accent-red,#cf222e); cursor:pointer; }
    .pr-reset-btn:hover { text-decoration:underline; }
    .filter-group { display:inline-flex; align-items:center; gap:6px; }
    .filter-label { font-size:11px; color:var(--fg-muted); text-transform:uppercase;
                    letter-spacing:0.04em; font-weight:600; margin-right:2px; }
    .filter-chip { font-size:12px; padding:3px 10px; border:1px solid var(--border, #d0d7de);
                   border-radius:999px; background:var(--canvas, #fff); color:var(--fg-muted);
                   cursor:pointer; transition: all 150ms ease; font-family: inherit; }
    .filter-chip:hover { color:var(--fg); border-color:var(--fg-muted); }
    .filter-chip.is-active { background:var(--accent-blue, #0969da); color:#fff;
                             border-color:var(--accent-blue, #0969da); }
  </style>
  <main class="container-lg p-responsive mt-4">
    <div class="d-flex flex-justify-between flex-items-center mb-3">
      <h1 class="h2" style="font-weight: 700;">Pull Requests</h1>
      <div class="d-flex flex-items-center" style="gap: 8px;">
        <input id="pr-search" type="search" placeholder="Search PRs…" autocomplete="off"
          style="padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; width: 220px; outline: none; background: var(--canvas); color: var(--fg);"
          oninput="applyFilters()">
        <button class="btn btn-sm btn-primary" onclick="syncPRs(this)">Sync PRs</button>
      </div>
    </div>
    <div id="pr-filters" class="d-flex flex-items-center mb-3" style="gap:14px; flex-wrap:wrap;"
         data-me-default="${escape(((cfg as any).bitbucket?.username) || ((cfg as any).reviewer?.name) || '')}">
      <div class="filter-group" data-filter="author">
        <span class="filter-label">Author</span>
        <button type="button" class="filter-chip is-active" data-val="all">All</button>
        <button type="button" class="filter-chip" data-val="me">Me as author</button>
        <button type="button" class="filter-chip" data-val="others">Not me (to review)</button>
      </div>
      <div class="filter-group" data-filter="state">
        <span class="filter-label">State</span>
        <button type="button" class="filter-chip is-active" data-val="all">All</button>
        <button type="button" class="filter-chip" data-val="open">Open</button>
        <button type="button" class="filter-chip" data-val="reviewed">Reviewed</button>
      </div>
      <div class="filter-group" style="margin-left:auto;">
        <span class="filter-label">I'm</span>
        <input id="pr-me" type="text" placeholder="your handle"
          style="padding:3px 8px; border:1px solid var(--border); border-radius:6px; font-size:12px; width:140px; font-family:var(--mono); background:var(--canvas); color:var(--fg);"
          oninput="onMeChange(this.value)">
      </div>
    </div>

    ${rows.length === 0
      ? '<div class="blankslate"><h3>No pull requests found</h3><p>Run <code>lens list</code>.</p></div>'
      : `<div id="pr-list">${sections}</div>`}
  </main>

  <div class="modal-backdrop" id="custom-modal-backdrop">
    <div class="modal">
      <div class="modal-header" id="modal-title">Confirm</div>
      <div class="modal-body" id="modal-body"></div>
      <div class="modal-footer">
        <button class="btn btn-sm" id="modal-cancel">Cancel</button>
        <button class="btn btn-sm btn-primary" id="modal-ok">OK</button>
      </div>
    </div>
  </div>

  <div class="pr-action-bar" id="pr-action-bar">
    <span class="pr-action-count"><span id="pr-action-num">0</span> selected</span>
    <button class="btn btn-sm btn-primary" id="pr-bulk-analyze">Analyze selected</button>
    <button class="btn btn-sm" id="pr-bulk-reset">Reset selected</button>
    <span class="pr-action-spacer"></span>
    <button class="btn btn-sm btn-link" id="pr-clear-selection">Clear</button>
  </div>

  ${THINKING_LOG_JS}

  <script>
    // Filter state lives in localStorage so chip + "me" selections survive page
    // reloads (the dashboard reloads on sync, on PR completion, etc).
    const filterState = {
      author: localStorage.getItem('lens.filter.author') || 'all',
      state: localStorage.getItem('lens.filter.state') || 'all',
      me: (localStorage.getItem('lens.filter.me') || '').toLowerCase(),
    };

    function initFilters() {
      const meInput = document.getElementById('pr-me');
      const meDefault = (document.getElementById('pr-filters')?.dataset.meDefault || '').toLowerCase();
      if (!filterState.me && meDefault) filterState.me = meDefault;
      if (meInput) meInput.value = filterState.me;
      document.querySelectorAll('#pr-filters .filter-group').forEach(grp => {
        const key = grp.dataset.filter;
        grp.querySelectorAll('.filter-chip').forEach(btn => {
          btn.classList.toggle('is-active', btn.dataset.val === filterState[key]);
          btn.addEventListener('click', () => {
            filterState[key] = btn.dataset.val;
            localStorage.setItem('lens.filter.' + key, btn.dataset.val);
            grp.querySelectorAll('.filter-chip').forEach(b => b.classList.toggle('is-active', b === btn));
            applyFilters();
          });
        });
      });
      applyFilters();
    }

    function onMeChange(val) {
      filterState.me = (val || '').trim().toLowerCase();
      localStorage.setItem('lens.filter.me', filterState.me);
      applyFilters();
    }

    function applyFilters() {
      const q = (document.getElementById('pr-search')?.value || '').trim().toLowerCase();
      const me = filterState.me;
      // If author filter is "me"/"others" but we have no identity yet, fall
      // back to "all" — otherwise the list silently empties and the user
      // can't tell why.
      const authorMode = (filterState.author !== 'all' && !me) ? 'all' : filterState.author;
      const stateMode = filterState.state;
      document.querySelectorAll('[data-repo-group]').forEach(group => {
        let visibleRows = 0;
        group.querySelectorAll('tr.pr-row').forEach(row => {
          const author = row.dataset.author || '';
          const bucket = row.dataset.stateBucket || '';
          let ok = !q || (row.dataset.search || '').includes(q);
          if (ok && authorMode === 'me') ok = author === me;
          if (ok && authorMode === 'others') ok = author !== me;
          if (ok && stateMode !== 'all') ok = bucket === stateMode;
          row.style.display = ok ? '' : 'none';
          const id = row.dataset.prId;
          const stageRow = group.querySelector('tr.pr-stage-row[data-pr-id="' + (id || '').replace(/(["\\\\])/g, '\\\\$1') + '"]');
          if (stageRow) {
            const wasExpanded = row.classList.contains('is-expanded');
            stageRow.style.display = (ok && wasExpanded) ? '' : 'none';
          }
          if (ok) visibleRows++;
        });
        group.style.display = visibleRows === 0 ? 'none' : '';
      });
    }

    document.addEventListener('DOMContentLoaded', initFilters);

    function uiAlert(message, title = 'Notification') {
      return new Promise((resolve) => {
        const backdrop = document.getElementById('custom-modal-backdrop');
        const titleEl = document.getElementById('modal-title');
        const bodyEl = document.getElementById('modal-body');
        const okBtn = document.getElementById('modal-ok');
        const cancelBtn = document.getElementById('modal-cancel');
        cancelBtn.onclick = null;

        titleEl.textContent = title;
        bodyEl.textContent = message;
        cancelBtn.style.display = 'none';
        backdrop.classList.add('is-open');

        function cleanup() {
          backdrop.classList.remove('is-open');
          okBtn.removeEventListener('click', onOk);
        }
        function onOk() { cleanup(); resolve(); }
        okBtn.addEventListener('click', onOk);
      });
    }

    async function syncPRs(btn) {
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Syncing...';
      try {
        const r = await fetch('/api/prs/sync', { method: 'POST' });
        const j = await r.json();
        if (j.ok) { location.reload(); }
        else { await uiAlert('Sync failed: ' + j.error, 'Error'); btn.disabled = false; btn.textContent = orig; }
      } catch (err) { await uiAlert('Network error: ' + err.message, 'Error'); btn.disabled = false; btn.textContent = orig; }
    }

    async function scanForRepo(ek, btn) {
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Scanning…';
      try {
        const r = await fetch('/api/projects/scan', { method: 'POST' });
        const j = await r.json();
        if (j.ok && j.matched > 0) { location.reload(); }
        else if (j.ok) { btn.disabled = false; btn.textContent = orig; await uiAlert('No match found. Use "set path" to link manually.', 'Not found'); }
        else { btn.disabled = false; btn.textContent = orig; await uiAlert('Scan error: ' + j.error, 'Error'); }
      } catch (e) { btn.disabled = false; btn.textContent = orig; }
    }

    function setRepoPath(ek) {
      const backdrop = document.getElementById('custom-modal-backdrop');
      const titleEl = document.getElementById('modal-title');
      const bodyEl = document.getElementById('modal-body');
      const okBtn = document.getElementById('modal-ok');
      const cancelBtn = document.getElementById('modal-cancel');
      titleEl.textContent = 'Set local path';
      bodyEl.innerHTML = '<input type="text" id="path-input" placeholder="/Users/you/projects/my-repo" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:13px;box-sizing:border-box;">';
      cancelBtn.style.display = '';
      backdrop.classList.add('is-open');
      setTimeout(() => document.getElementById('path-input').focus(), 50);
      function cleanup() { backdrop.classList.remove('is-open'); okBtn.removeEventListener('click', onOk); cancelBtn.removeEventListener('click', cleanup); }
      async function onOk() {
        const val = document.getElementById('path-input').value.trim();
        if (!val) { cleanup(); return; }
        cleanup();
        await fetch('/api/projects/' + ek + '/path', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ local_path: val }) });
        location.reload();
      }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', cleanup);
    }

    // ── Per-PR live progress + expandable stage row ──────────────────────
    const prState = new Map(); // prId → last summary
    const prTickers = new Map(); // prId → setInterval handle for ETA countdown

    function fmtMs(ms) {
      if (ms == null || ms < 0) return '';
      if (ms < 1000) return Math.round(ms) + 'ms';
      const s = Math.round(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      return m + 'm ' + (s % 60) + 's';
    }

    function escapeHtml(unsafe) {
      return (unsafe == null ? '' : String(unsafe))
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    // Per-PR mini ThinkingLog instances mounted lazily on first agent event.
    const prThinkingLogs = new Map();
    function getThinkingLog(prId) {
      if (prThinkingLogs.has(prId)) return prThinkingLogs.get(prId);
      const stageContent = document.querySelector('.pr-stage-row[data-pr-id="' + cssEscape(prId) + '"] .pr-stage-content');
      if (!stageContent) return null;
      ensureStageSkeleton(stageContent);
      const logEl = stageContent.querySelector('.pr-thinking-log');
      if (!logEl) return null;
      const tl = window.ThinkingLog.mount(logEl, { compact: true, maxRows: 12 });
      prThinkingLogs.set(prId, tl);
      return tl;
    }

    // Build the per-PR stage row skeleton once. Subsequent updates mutate
    // existing nodes in place to avoid the layout shift / flicker that comes
    // from rewriting innerHTML on every SSE tick.
    function ensureStageSkeleton(stageContent) {
      if (stageContent.querySelector('.pr-stage-groups')) return;
      stageContent.innerHTML =
        '<div class="pr-stage-groups">' +
          '<div class="pr-stage-group" data-group="triage">' +
            '<div class="pr-stage-group-header"><span class="pr-stage-group-title">Stage 1 · Triage</span><span class="pr-stage-group-status" data-role="status"></span></div>' +
            '<div class="pr-stage-list" data-group="triage"></div>' +
          '</div>' +
          '<div class="pr-stage-group" data-group="review">' +
            '<div class="pr-stage-group-header"><span class="pr-stage-group-title">Stage 2 · Review</span><span class="pr-stage-group-status" data-role="status"></span></div>' +
            '<div class="pr-stage-list" data-group="review"></div>' +
          '</div>' +
        '</div>' +
        '<div class="pr-thinking-log"></div>';
    }

    function ensureLiveCellSkeleton(c) {
      if (c.querySelector('.pr-progress-bar')) return;
      c.innerHTML =
        '<div class="pr-progress-bar"><div class="pr-progress-fill"></div></div>' +
        '<span class="pr-progress-text"></span>';
    }

    function updateProgressText(c, summary) {
      const txt = c.querySelector('.pr-progress-text');
      if (!txt) return;
      // Always render an ETA suffix (placeholder dash if unknown) so the cell
      // width never collapses and re-expands when ETA toggles in/out.
      const etaStr = summary.etaMs > 0 ? '~' + fmtMs(summary.etaMs) : '—';
      const next = summary.percent + '% · ' + (summary.currentLabel || '...') + ' · ' + etaStr;
      if (txt.textContent !== next) txt.textContent = next;
    }

    function applyProgress(summary) {
      prState.set(summary.prId, summary);
      const sel = '.pr-row[data-pr-id="' + cssEscape(summary.prId) + '"]';
      const liveCells = document.querySelectorAll(sel + ' .pr-state-live');
      const staticCells = document.querySelectorAll(sel + ' .pr-state-static');
      const stageContent = document.querySelector('.pr-stage-row[data-pr-id="' + cssEscape(summary.prId) + '"] .pr-stage-content');

      liveCells.forEach(c => {
        if (c.style.display === 'none' || c.style.display === '') c.style.display = '';
        ensureLiveCellSkeleton(c);
        const fill = c.querySelector('.pr-progress-fill');
        if (fill) fill.style.width = summary.percent + '%';
        updateProgressText(c, summary);
      });
      staticCells.forEach(c => { if (c.style.display !== 'none') c.style.display = 'none'; });

      if (stageContent) {
        ensureStageSkeleton(stageContent);
        const empty = stageContent.querySelector('.pr-stage-empty');
        if (empty) empty.remove();
        const groupCounts = { triage: { done:0, running:0, error:0, total:0 }, review: { done:0, running:0, error:0, total:0 } };
        summary.stages.forEach(s => {
          const groupKey = s.group || 'triage';
          const listEl = stageContent.querySelector('.pr-stage-list[data-group="' + groupKey + '"]');
          if (!listEl) return;
          let item = listEl.querySelector('.pr-stage-item[data-stage="' + cssEscape(s.id) + '"]');
          if (!item) {
            item = document.createElement('div');
            item.dataset.stage = s.id;
            item.innerHTML =
              '<span class="pr-stage-dot"></span>' +
              '<span class="pr-stage-label"></span>' +
              '<span class="pr-stage-elapsed"></span>';
            item.querySelector('.pr-stage-label').textContent = s.label;
            listEl.appendChild(item);
          }
          const wantItemCls = 'pr-stage-item is-' + s.status;
          if (item.className !== wantItemCls) item.className = wantItemCls;
          const wantTitle = s.detail || '';
          if (item.title !== wantTitle) item.title = wantTitle;
          const elapsed = item.querySelector('.pr-stage-elapsed');
          const wantElapsed = s.elapsedMs != null ? fmtMs(s.elapsedMs) : '—';
          if (elapsed.textContent !== wantElapsed) elapsed.textContent = wantElapsed;
          // tally for group header
          const g = groupCounts[groupKey];
          if (g) {
            g.total++;
            if (s.status === 'done' || s.status === 'skipped') g.done++;
            else if (s.status === 'running') g.running++;
            else if (s.status === 'error') g.error++;
          }
        });
        // update group headers with status text + class
        ['triage', 'review'].forEach(gk => {
          const groupEl = stageContent.querySelector('.pr-stage-group[data-group="' + gk + '"]');
          if (!groupEl) return;
          const c = groupCounts[gk];
          let cls = 'is-pending', txt = c.total ? c.done + '/' + c.total : '';
          if (c.error) { cls = 'is-error'; txt = 'failed · ' + c.done + '/' + c.total; }
          else if (c.running) { cls = 'is-running'; txt = 'running · ' + c.done + '/' + c.total; }
          else if (c.total && c.done === c.total) { cls = 'is-done'; txt = 'done'; }
          const wantCls = 'pr-stage-group ' + cls;
          if (groupEl.className !== wantCls) groupEl.className = wantCls;
          const statusEl = groupEl.querySelector('[data-role="status"]');
          if (statusEl && statusEl.textContent !== txt) statusEl.textContent = txt;
        });
      }

      if (!prTickers.has(summary.prId)) {
        const h = setInterval(() => {
          const cur = prState.get(summary.prId);
          if (!cur) return;
          // Tick the running stage locally so its elapsed time advances even
          // when the server is idle between agent events (e.g. waiting on the
          // model). Server progress events overwrite this on arrival.
          let tickedStage = null;
          if (Array.isArray(cur.stages)) {
            for (const st of cur.stages) {
              if (st.status === 'running') {
                st.elapsedMs = (st.elapsedMs || 0) + 1000;
                tickedStage = st;
                break;
              }
            }
          }
          if (cur.etaMs > 0) {
            cur.etaMs = Math.max(0, cur.etaMs - 1000);
            cur.elapsedMs += 1000;
            document.querySelectorAll(sel + ' .pr-progress-text').forEach(t => updateProgressText(t.parentElement, cur));
          }
          if (tickedStage) {
            const stageRow = document.querySelector('.pr-stage-row[data-pr-id="' + cssEscape(cur.prId) + '"]');
            const item = stageRow && stageRow.querySelector('.pr-stage-item[data-stage="' + cssEscape(tickedStage.id) + '"]');
            const el = item && item.querySelector('.pr-stage-elapsed');
            if (el) {
              const next = fmtMs(tickedStage.elapsedMs);
              if (el.textContent !== next) el.textContent = next;
            }
          }
        }, 1000);
        prTickers.set(summary.prId, h);
      }
    }

    function endProgress(prId, ok) {
      prState.delete(prId);
      prThinkingLogs.delete(prId);
      const t = prTickers.get(prId);
      if (t) { clearInterval(t); prTickers.delete(prId); }
      const sel = '.pr-row[data-pr-id="' + cssEscape(prId) + '"]';
      document.querySelectorAll(sel + ' .pr-state-live').forEach(c => { c.style.display = 'none'; c.innerHTML = ''; });
      document.querySelectorAll(sel + ' .pr-state-static').forEach(c => { c.style.display = ''; });
      if (ok) setTimeout(() => location.reload(), 700);
    }

    function applyAgentLast(prId, ev) {
      const tl = getThinkingLog(prId);
      if (tl) tl.append(ev);
    }

    function cssEscape(s) {
      // Minimal CSS attribute-selector escape for our prId values (they may contain : . / etc.)
      return String(s).replace(/(["\\\\])/g, '\\\\$1');
    }

    // Toggle expand row on arrow click (and row click outside the title link)
    document.addEventListener('click', (e) => {
      const arrow = e.target.closest('.pr-expand-arrow');
      if (!arrow) return;
      e.stopPropagation();
      const id = arrow.dataset.toggle;
      const row = document.querySelector('.pr-row[data-pr-id="' + cssEscape(id) + '"]');
      const stageRow = document.querySelector('.pr-stage-row[data-pr-id="' + cssEscape(id) + '"]');
      if (!row || !stageRow) return;
      const open = stageRow.style.display !== 'none';
      stageRow.style.display = open ? 'none' : '';
      row.classList.toggle('is-expanded', !open);
    });

    // Connect to multiplexed dashboard SSE
    try {
      const dashSrc = new EventSource('/api/stream');
      dashSrc.addEventListener('init', (e) => {
        const d = JSON.parse(e.data);
        (d.active || []).forEach(applyProgress);
        (d.indexes || []).forEach(applyIndexProgress);
      });
      dashSrc.addEventListener('start', (e) => applyProgress(JSON.parse(e.data)));
      dashSrc.addEventListener('progress', (e) => applyProgress(JSON.parse(e.data)));
      dashSrc.addEventListener('queued', (e) => {
        const d = JSON.parse(e.data);
        applyQueued(d);
      });
      dashSrc.addEventListener('agent', (e) => {
        const d = JSON.parse(e.data);
        applyAgentLast(d.prId, d.event);
      });
      dashSrc.addEventListener('end', (e) => {
        const d = JSON.parse(e.data);
        endProgress(d.prId, d.ok && !d.cancelled);
      });
      dashSrc.addEventListener('index_progress', (e) => applyIndexProgress(JSON.parse(e.data)));
      dashSrc.addEventListener('index_done', (e) => applyIndexDone(JSON.parse(e.data)));
    } catch (err) { console.warn('dashboard stream unavailable', err); }

    // Render live index progress into the badge for that repo. Falls back to
    // a no-op if the badge isn't present (filtered out, different page, etc).
    function applyIndexProgress(d) {
      if (!d || !d.key) return;
      const ek = encodeURIComponent(d.key);
      const badge = document.querySelector('.idx-badge[data-idx-key="' + ek + '"]');
      if (!badge) return;
      const phaseLabel = d.phase === 'walk' ? 'Scanning' : d.phase === 'defs' ? 'Indexing definitions' : d.phase === 'calls' ? 'Linking call sites' : 'Indexing';
      const ratio = d.filesTotal ? Math.min(100, Math.round((d.files / d.filesTotal) * 100)) : null;
      const counter = d.filesTotal ? d.files + ' / ' + d.filesTotal + ' files' : 'preparing…';
      badge.innerHTML =
        '<span class="idx-spin"></span> ' + phaseLabel + ' · ' + counter +
        (ratio != null ? ' · ' + ratio + '%' : '') +
        (d.symbols ? ' · ' + d.symbols + ' symbols' : '');
    }

    async function applyIndexDone(d) {
      if (!d || !d.key) return;
      const ek = encodeURIComponent(d.key);
      const badge = document.querySelector('.idx-badge[data-idx-key="' + ek + '"]');
      if (!badge) return;
      if (!d.ok) {
        badge.innerHTML = '<span style="color:var(--accent-red,#cf222e);">Index failed</span> — ' + escapeHtml(d.error || '') +
          ' · <button class="btn-link" style="font-size:11px;" onclick="indexRepo(\\'' + ek + '\\',this)">retry</button>';
        return;
      }
      // Refresh the badge from /api/projects so the persisted "N symbols · date"
      // form replaces the live progress indicator.
      try {
        const r = await fetch('/api/projects');
        const projects = await r.json();
        const mine = projects.find(p => encodeURIComponent(p.workspace + '/' + p.repo) === ek);
        if (mine) {
          if (mine.lastIndexed) {
            const dt = new Date(mine.lastIndexed);
            badge.innerHTML = mine.symbolCount + ' symbols · ' + dt.toLocaleDateString() +
              ' — <button class="btn-link" style="font-size:11px;" onclick="indexRepo(\\'' + ek + '\\',this)">re-index</button>';
          }
        }
      } catch (e) {}
    }

    function applyQueued(d) {
      const liveCells = document.querySelectorAll('.pr-row[data-pr-id="' + cssEscape(d.prId) + '"] .pr-state-live');
      const staticCells = document.querySelectorAll('.pr-row[data-pr-id="' + cssEscape(d.prId) + '"] .pr-state-static');
      liveCells.forEach(c => {
        c.style.display = '';
        c.innerHTML = '<span class="State State--QUEUED">Queued · #' + d.queuePosition + '</span>';
      });
      staticCells.forEach(c => { c.style.display = 'none'; });
    }

    // ── Multi-select + bulk actions ────────────────────────────────────────
    function selectedPrIds() {
      return [...document.querySelectorAll('.pr-checkbox:checked')].map(cb => cb.dataset.prId);
    }

    function refreshActionBar() {
      const ids = selectedPrIds();
      const bar = document.getElementById('pr-action-bar');
      const num = document.getElementById('pr-action-num');
      num.textContent = ids.length;
      bar.classList.toggle('is-open', ids.length > 0);
    }

    document.addEventListener('change', (e) => {
      if (e.target.classList && e.target.classList.contains('pr-checkbox')) refreshActionBar();
    });

    document.getElementById('pr-clear-selection').addEventListener('click', () => {
      document.querySelectorAll('.pr-checkbox:checked').forEach(cb => { cb.checked = false; });
      refreshActionBar();
    });

    document.getElementById('pr-bulk-analyze').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const ids = selectedPrIds();
      if (ids.length === 0) return;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = 'Analyzing ' + ids.length + '…';
      const results = await Promise.all(ids.map(async id => {
        try {
          const r = await fetch('/api/pr/' + id + '/analyze', { method: 'POST' });
          const j = await r.json();
          return { id, ok: !!j.ok, queued: !!j.queued, error: j.error };
        } catch (err) { return { id, ok: false, error: err.message }; }
      }));
      btn.disabled = false;
      btn.textContent = orig;
      const failed = results.filter(r => !r.ok);
      if (failed.length) {
        await uiAlert(failed.length + ' of ' + results.length + ' could not be queued: ' + failed.map(f => f.id + ' (' + f.error + ')').join(', '), 'Bulk analyze');
      }
    });

    document.getElementById('pr-bulk-reset').addEventListener('click', async (e) => {
      const ids = selectedPrIds();
      if (ids.length === 0) return;
      if (!confirm('Reset ' + ids.length + ' PR(s)? Any in-flight analyses will be cancelled.')) return;
      await Promise.all(ids.map(id => fetch('/api/pr/' + id + '/reset', { method: 'POST' }).catch(() => {})));
      // The dashboard SSE will fire 'end' events which will reload. As a belt-and-braces, reload after a short wait.
      setTimeout(() => location.reload(), 600);
    });

    // Per-row Reset button (visible when state is ANALYZING/QUEUED/stuck)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.pr-reset-btn');
      if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      const id = btn.dataset.prId;
      if (!confirm('Reset this PR? Any in-flight analysis will be cancelled.')) return;
      try {
        const r = await fetch('/api/pr/' + id + '/reset', { method: 'POST' });
        const j = await r.json();
        if (!j.ok) await uiAlert('Reset returned: ' + (j.error || JSON.stringify(j)), 'Reset');
        setTimeout(() => location.reload(), 400);
      } catch (err) { await uiAlert('Network error: ' + err.message, 'Error'); }
    });

    // Kick off an index. Progress + completion are handled by the dashboard
    // SSE listeners (applyIndexProgress / applyIndexDone), which mutate the
    // badge in place — no modal, no polling, no premature reload.
    async function indexRepo(ek) {
      const badge = document.querySelector('.idx-badge[data-idx-key="' + ek + '"]');
      if (badge) badge.innerHTML = '<span class="idx-spin"></span> Starting…';
      try {
        const r = await fetch('/api/projects/' + ek + '/index', { method: 'POST' });
        const j = await r.json();
        if (!j.ok) {
          if (badge) badge.innerHTML = '<span style="color:var(--accent-red,#cf222e);">' + (j.error || 'failed') + '</span>';
        }
      } catch (e) {
        if (badge) badge.innerHTML = '<span style="color:var(--accent-red,#cf222e);">' + e.message + '</span>';
      }
    }
  </script>
</body>
</html>`;
}

function renderUsageBadge(analysis: any): string {
  const tin = analysis.tokens_in_total as number | null;
  const tout = analysis.tokens_out_total as number | null;
  const cost = analysis.cost_usd as number | null;
  if (!tin && !tout && !cost) return '';
  const tinFmt = tin ? `${(tin / 1000).toFixed(1)}K` : '?';
  const toutFmt = tout ? `${(tout / 1000).toFixed(1)}K` : '?';
  const costFmt = cost != null ? (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`) : '—';
  return `<button class="btn-link text-small color-fg-muted" onclick="openDrawer('cost-drawer')" title="Click for per-stage breakdown" style="margin-left:auto; font-family: var(--mono); padding: 4px 10px; background: rgba(0,0,0,0.04); border-radius: var(--radius); border: none; cursor: pointer;">
    ${tinFmt} in / ${toutFmt} out  ·  ~${costFmt}
  </button>`;
}

function fmtCost(c: number | null): string {
  if (c == null) return '—';
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

function renderCostDrawer(stages: any[], analysis: any): string {
  if (!analysis) return '';
  const total = analysis.cost_usd as number | null;
  return `
  <div class="side-drawer" id="cost-drawer">
    <div class="side-drawer-header">
      <h3 class="h4 m-0">Cost & Token Breakdown</h3>
      <button onclick="closeDrawer()" title="Close (Esc)" style="background:none;border:1px solid var(--border);cursor:pointer;padding:4px 10px;border-radius:6px;color:var(--fg);font-size:16px;line-height:1;display:flex;align-items:center;font-weight:600;" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='none'">&#x2715;</button>
    </div>
    <div class="side-drawer-body" style="padding: 24px;">
      ${stages.length === 0 ? '<p class="color-fg-muted">No per-stage usage logged yet.</p>' : `
      <table class="text-small" style="width:100%; border-collapse: collapse;">
        <thead>
          <tr style="border-bottom: 1px solid var(--border); text-align: left;">
            <th style="padding: 8px; font-weight: 600;">Stage</th>
            <th style="padding: 8px; font-weight: 600;">Model</th>
            <th style="padding: 8px; font-weight: 600; text-align: right;">In</th>
            <th style="padding: 8px; font-weight: 600; text-align: right;">Out</th>
            <th style="padding: 8px; font-weight: 600; text-align: right;">Cost</th>
            <th style="padding: 8px; font-weight: 600; text-align: right;">Time</th>
          </tr>
        </thead>
        <tbody>
          ${stages.map((s) => `
          <tr style="border-bottom: 1px dashed var(--border);">
            <td style="padding: 10px 8px;"><span class="Label Label--${s.stage}">${escape(s.stage)}</span></td>
            <td style="padding: 10px 8px; font-family: var(--mono); font-size: 11px;">${escape(s.model ?? '(default)')}</td>
            <td style="padding: 10px 8px; text-align: right; font-family: var(--mono);">${s.tokens_in ?? '?'}</td>
            <td style="padding: 10px 8px; text-align: right; font-family: var(--mono);">${s.tokens_out ?? '?'}</td>
            <td style="padding: 10px 8px; text-align: right; font-family: var(--mono);">${fmtCost(s.cost_usd)}</td>
            <td style="padding: 10px 8px; text-align: right; font-family: var(--mono); color: var(--fg-muted);">${s.ms_elapsed ? (s.ms_elapsed / 1000).toFixed(1) + 's' : '—'}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border);">
            <td colspan="4" style="padding: 12px 8px; font-weight: 600;">Total</td>
            <td style="padding: 12px 8px; text-align: right; font-family: var(--mono); font-weight: 600;">${fmtCost(total)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <p class="text-small color-fg-muted" style="margin-top: 24px; line-height: 1.5;">
        Costs are estimates from a static price table; actual billing depends on your subscription tier and cache hit rate. Gemini tokens are estimated from string length (~4 chars/token).
      </p>`}
    </div>
  </div>`;
}

function formatLabel(str: string): string {
  if (!str) return '';
  return str.split('_').map(w => w.toLowerCase() === 'api' ? 'API' : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function renderPR(db: ReturnType<typeof getDb>, prId: string): string {
  const pr = db.prepare(`SELECT * FROM pr WHERE id=?`).get(prId) as any;
  if (!pr) return `<p>PR ${prId} not found. Run <code>lens list</code>.</p>`;
  const pathRow = db.prepare(`SELECT local_path FROM project_path WHERE workspace=? AND repo=?`).get(pr.workspace, pr.repo) as { local_path: string } | undefined;
  const localPath = pathRow?.local_path ?? null;
  const idxRow = localPath ? db.prepare(`SELECT MAX(indexed_at) as last, SUM(kind='def') as cnt FROM symbol_index WHERE repo_root=?`).get(localPath) as { last: string | null; cnt: number } | undefined : undefined;
  const isIndexed = !!(idxRow?.last);
  const idxLabel = isIndexed ? `Re-index (${idxRow!.cnt} symbols)` : 'Index project';
  const prKey = encodeURIComponent(`${pr.workspace}/${pr.repo}`);
  const analysis = db
    .prepare(`SELECT * FROM analysis WHERE pr_id=? ORDER BY id DESC LIMIT 1`)
    .get(prId) as any;
  const drafts = analysis ? db
    .prepare(`SELECT * FROM comment_draft WHERE analysis_id=? ORDER BY file, line`)
    .all(analysis.id) as Array<any> : [];
  const triage = analysis ? db
    .prepare(`SELECT file, decision, reason, source, added, removed FROM triage_decision WHERE analysis_id=? ORDER BY decision, file`)
    .all(analysis.id) as Array<any> : [];
  const stageUsage = db
    .prepare(`SELECT stage, model, tokens_in, tokens_out, cost_usd, ms_elapsed
              FROM usage_log
              WHERE pr_id=? AND stage IS NOT NULL
              ORDER BY id DESC
              LIMIT 10`)
    .all(prId) as Array<any>;
  const existingComments = db
    .prepare(`SELECT author, file, line, body, created_at
              FROM reviewer_comment
              WHERE forge=? AND workspace=? AND repo=? AND pr_number=?
              ORDER BY file, line, created_at`)
    .all(pr.forge, pr.workspace, pr.repo, pr.number) as Array<any>;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escape(pr.title ?? '')} — lens</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html@3.4.47/bundles/css/diff2html.min.css"/>
  <script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.47/bundles/js/diff2html.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  ${BASE_CSS}
</head>
<body class="App">
  <header class="App-header Header">
    <div class="Header-item">
      <a href="/" class="Header-link d-flex flex-items-center" style="padding: 0;">
        <div style="color: var(--primary-black); display: flex;">${LOGO_SVG}</div>
      </a>
    </div>
    
    <div class="Header-item Header-item--full">
      <div class="header-pr-info">
        <span class="state-stack">${forgeStatusBadge(pr)}<span class="State State--${pr.state}">${formatLabel(pr.state)}</span></span>
        <div class="header-pr-title">
          ${escape(pr.title ?? '')}
          <span class="header-pr-number">#${pr.number ?? prId}</span>
        </div>
      </div>
    </div>

    <div class="Header-item" style="gap: 8px;">
      ${pr.url ? `<a href="${pr.url}" target="_blank" class="btn btn-sm">View ↗</a>` : ''}
      <button id="index-btn" class="btn btn-sm" onclick="indexBtnClick('${prKey}', '${escape(pr.repo)}', ${localPath ? 1 : 0})">
        <span id="index-btn-text">${idxLabel}</span>
      </button>
      <span class="idx-badge" data-idx-key="${prKey}" style="font-size:11px;color:var(--fg-muted);"></span>
      <button id="analyze-btn" class="btn btn-sm" onclick="analyzePR('${prId}')">
        <span class="btn-text">${analysis ? 'Re-analyze' : 'Analyze'}</span>
        <span class="btn-loader" style="display:none">Analyzing...</span>
      </button>
      <button class="btn btn-sm btn-primary" onclick="submitAll('${prId}')">Submit Review</button>
    </div>
  </header>

  <div class="App-body">
    <aside class="Sidebar" id="sidebar">
      <div class="Sidebar-header">
        <button class="btn btn-sm sidebar-toggle-btn" onclick="toggleSidebar()" title="Toggle file tree" style="background:transparent; border:none; padding:4px; color: var(--fg-muted); display: flex;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
        </button>
        <span class="sidebar-title">Files changed</span>
      </div>
      <div class="Sidebar-content" id="sidebar-content">
        <div style="padding: 16px; color: var(--fg-muted);">Loading files...</div>
      </div>
    </aside>

    <main class="MainView">
      <div class="MainView-content">
        <div class="Box mb-4" style="background: rgba(250,250,250,0.3);">
          <div class="Box-header d-flex flex-items-center gap-2" style="background:transparent; border-bottom:none; padding-bottom:4px; cursor:pointer; user-select:none;" onclick="toggleSummary()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            <h3 class="Box-title" style="font-size:16px; flex:1;">AI Review Summary</h3>
            <svg id="summary-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transition:transform 0.2s;"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div id="summary-body">
            <div class="Box-body text-small color-fg-muted" id="review-summary" style="white-space: pre-wrap; padding-top:0; padding-bottom:20px; line-height: 1.5;">${escape(analysis?.summary ?? 'No analysis yet.')}</div>
          </div>
          <div class="Box-footer" style="background:transparent; border-top: 1px dashed var(--border); padding: 12px 20px; display:flex; gap:12px; align-items:center;">
            <button class="btn btn-sm btn-outline text-small d-flex flex-items-center gap-2" onclick="openDrawer('logs-drawer')">
              Thinking Logs
            </button>

            <button id="triage-btn" class="btn btn-sm btn-outline text-small d-flex flex-items-center gap-2" onclick="openDrawer('triage-drawer')" style="${triage.length ? '' : 'display:none;'}">
              Triage Analysis (<span id="triage-count">${triage.length}</span> files)
            </button>

            ${existingComments.length > 0 ? `<button class="btn btn-sm btn-outline text-small d-flex flex-items-center gap-2" onclick="openDrawer('existing-comments-drawer')">
              Reviewer Comments (${existingComments.length})
            </button>` : ''}

            <button class="btn btn-sm btn-outline text-small d-flex flex-items-center gap-2" onclick="openSessionsDrawer()">
              Past Runs
            </button>

            ${analysis ? renderUsageBadge(analysis) : ''}
          </div>
        </div>

        <div class="d-flex flex-justify-end" style="margin-bottom: 24px;">
          <button class="btn btn-sm btn-outline text-small py-2" onclick="toggleAllFiles()" id="collapse-all-btn">Collapse All</button>
        </div>

        <div id="diff" class="diff-container">
          <div class="blankslate">Loading diff data...</div>
        </div>
      </div>
    </main>
  </div>
  
  <div class="drawer-backdrop" id="drawer-backdrop" onclick="closeDrawer()"></div>
  
  <div class="side-drawer" id="logs-drawer">
    <div class="side-drawer-header">
      <h3 class="h4 m-0">Thinking Logs</h3>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn-link text-small logs-tab is-active" data-tab="timeline" style="text-decoration:none;">Timeline</button>
        <button class="btn-link text-small logs-tab" data-tab="raw" style="text-decoration:none; color:var(--fg-muted);">Raw</button>
        <button onclick="closeDrawer()" title="Close (Esc)" style="background:none;border:1px solid var(--border);cursor:pointer;padding:4px 10px;border-radius:6px;color:var(--fg);font-size:16px;line-height:1;display:flex;align-items:center;font-weight:600;" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='none'">&#x2715;</button>
      </div>
    </div>
    <div class="side-drawer-body p-0">
      <div id="agent-timeline" class="agent-timeline" style="padding:14px 18px; height:100%; overflow:auto; box-sizing:border-box;" ${analysis?.thinking_text ? `data-seed-text="${escape(analysis.thinking_text).replace(/"/g, '&quot;')}"` : ''}>
        ${analysis?.thinking_text ? '' : '<div class="tl-placeholder">No agent events yet. Trigger an analysis to see live thinking, tool calls, and results.</div>'}
      </div>
      <pre id="raw-logs" class="terminal-logs" style="margin:0; height:100%; border-radius:0; border:none; max-height:none; display:none;">${escape(analysis?.logs ?? '')}</pre>
    </div>
  </div>
  ${THINKING_LOG_CSS}
  <style>
    .logs-tab.is-active { color: var(--fg) !important; font-weight:600; }
    .idx-badge { transition: color 200ms ease; margin-left:4px; }
    .idx-spin { display:inline-block; width:8px; height:8px; border-radius:50%;
                background: var(--accent-blue, #0969da); margin-right:4px;
                vertical-align: middle; animation: idx-pulse 1.2s ease-in-out infinite; }
    @keyframes idx-pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
  </style>

  <div class="side-drawer" id="triage-drawer">
    <div class="side-drawer-header">
      <h3 class="h4 m-0">Triage Analysis</h3>
      <button onclick="closeDrawer()" title="Close (Esc)" style="background:none;border:1px solid var(--border);cursor:pointer;padding:4px 10px;border-radius:6px;color:var(--fg);font-size:16px;line-height:1;display:flex;align-items:center;font-weight:600;" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='none'">&#x2715;</button>
    </div>
    <div class="side-drawer-body p-0" style="overflow-y:auto;">
      <table class="triage-table text-small" style="margin:0;">
        <tbody id="triage-tbody">
          ${triage.map((t) => `
          <tr>
            <td class="v-align-top" style="padding:12px 16px; width:1px;"><span class="Label Label--${t.decision}">${formatLabel(t.decision)}</span></td>
            <td style="padding:12px 16px;">
              <div class="text-bold" style="font-family: var(--mono); font-size: 11px; word-break: break-all;">${escape(t.file)}</div>
              <div class="color-fg-muted mt-1">${escape(t.reason)}</div>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  ${renderCostDrawer(stageUsage, analysis)}

  <div class="side-drawer" id="existing-comments-drawer">
    <div class="side-drawer-header">
      <h3 class="h4 m-0">Existing Reviewer Comments</h3>
      <button onclick="closeDrawer()" title="Close (Esc)" style="background:none;border:1px solid var(--border);cursor:pointer;padding:4px 10px;border-radius:6px;color:var(--fg);font-size:16px;line-height:1;display:flex;align-items:center;font-weight:600;" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='none'">&#x2715;</button>
    </div>
    <div class="side-drawer-body" style="overflow-y:auto; padding:0;">
      ${existingComments.length === 0 ? `<div style="padding:24px; color:var(--fg-muted); font-size:13px;">No reviewer comments synced yet. They land here on the next sync.</div>` :
        existingComments.map((c) => `
          <div style="padding:14px 18px; border-bottom:1px dashed var(--border);">
            <div style="display:flex; align-items:baseline; gap:10px; margin-bottom:6px;">
              <span style="font-weight:600; font-size:13px;">${escape(c.author ?? 'unknown')}</span>
              <span style="font-family:var(--mono); font-size:11px; color:var(--fg-muted); word-break:break-all;">${escape(c.file ?? '')}${c.line ? ':' + c.line : ''}</span>
              <span style="margin-left:auto; font-size:11px; color:var(--fg-muted);">${c.created_at ? escape(new Date(c.created_at).toLocaleString()) : ''}</span>
            </div>
            <div style="font-size:13px; line-height:1.5; white-space:pre-wrap;">${escape(c.body ?? '')}</div>
          </div>
        `).join('')}
    </div>
  </div>

  <div class="side-drawer" id="sessions-drawer" style="width:min(880px, 95vw);">
    <div class="side-drawer-header">
      <h3 class="h4 m-0" id="sessions-drawer-title">Past Runs</h3>
      <button onclick="closeDrawer()" title="Close (Esc)" style="background:none;border:1px solid var(--border);cursor:pointer;padding:4px 10px;border-radius:6px;color:var(--fg);font-size:16px;line-height:1;display:flex;align-items:center;font-weight:600;" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background='none'">&#x2715;</button>
    </div>
    <div class="side-drawer-body p-0" style="display:grid; grid-template-columns: 280px 1fr; height:100%; overflow:hidden;">
      <div id="sessions-list" style="border-right:1px solid var(--border); overflow-y:auto;"></div>
      <div id="sessions-detail" style="overflow-y:auto; padding:14px 18px;">
        <div style="color:var(--fg-muted); font-size:13px;">Pick a run on the left to replay its events.</div>
      </div>
    </div>
  </div>
  <style>
    .session-row { padding:10px 14px; border-bottom:1px dashed var(--border); cursor:pointer; font-size:12.5px; }
    .session-row:hover { background: var(--accent-bg, rgba(9,105,218,0.06)); }
    .session-row.is-active { background: var(--accent-bg, rgba(9,105,218,0.12)); }
    .session-row .meta { color: var(--fg-muted); font-size:11px; margin-top:2px; }
    .session-row .pill { display:inline-block; padding:1px 7px; border-radius:10px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }
    .session-row .pill.completed { background:#dafbe1; color:#1a7f37; }
    .session-row .pill.cancelled { background:#eee; color:#555; }
    .session-row .pill.error { background:#ffebe9; color:#cf222e; }
    .session-row .pill.running { background:#ddf4ff; color:#0969da; }
    .ev-row { padding:6px 0; border-bottom:1px dotted var(--border); font-size:12px; line-height:1.5; }
    .ev-row .ev-kind { display:inline-block; min-width:64px; font-family:var(--mono); font-size:10.5px; color:var(--fg-muted); text-transform:uppercase; }
    .ev-row .ev-stage { font-family:var(--mono); font-size:10.5px; color:#6639ba; margin-right:6px; }
    .ev-row pre { margin:4px 0 0 0; padding:8px 10px; background:var(--canvas-subtle, #f6f8fa); border-radius:6px; white-space:pre-wrap; word-break:break-word; font-size:11.5px; max-height:320px; overflow:auto; }
  </style>

  <div class="modal-backdrop" id="custom-modal-backdrop">
    <div class="modal">
      <div class="modal-header" id="modal-title">Confirm</div>
      <div class="modal-body" id="modal-body"></div>
      <div class="modal-footer">
        <button class="btn btn-sm" id="modal-cancel">Cancel</button>
        <button class="btn btn-sm btn-primary" id="modal-ok">OK</button>
      </div>
    </div>
  </div>

  <div class="modal-backdrop" id="index-modal-backdrop" style="z-index:2100;">
    <div class="modal" style="width:520px;">
      <div class="modal-header">Index project</div>
      <div class="modal-body" id="index-modal-body" style="padding:0;"></div>
      <div class="modal-footer">
        <button class="btn btn-sm" onclick="closeIndexModal()">Cancel</button>
      </div>
    </div>
  </div>

  ${THINKING_LOG_JS}

  <script>
    const PRID = '${prId}';
    const DRAFTS = ${JSON.stringify(drafts)};

    function uiAlert(message, title = 'Notification') {
      return new Promise((resolve) => {
        const backdrop = document.getElementById('custom-modal-backdrop');
        const titleEl = document.getElementById('modal-title');
        const bodyEl = document.getElementById('modal-body');
        const okBtn = document.getElementById('modal-ok');
        const cancelBtn = document.getElementById('modal-cancel');
        cancelBtn.onclick = null;

        titleEl.textContent = title;
        bodyEl.textContent = message;
        cancelBtn.style.display = 'none';
        backdrop.classList.add('is-open');

        function cleanup() {
          backdrop.classList.remove('is-open');
          okBtn.removeEventListener('click', onOk);
        }
        function onOk() { cleanup(); resolve(); }
        okBtn.addEventListener('click', onOk);
      });
    }

    function uiConfirm(message, title = 'Confirm') {
      return new Promise((resolve) => {
        const backdrop = document.getElementById('custom-modal-backdrop');
        const titleEl = document.getElementById('modal-title');
        const bodyEl = document.getElementById('modal-body');
        const okBtn = document.getElementById('modal-ok');
        const cancelBtn = document.getElementById('modal-cancel');

        titleEl.textContent = title;
        bodyEl.textContent = message;
        cancelBtn.style.display = 'inline-flex';
        backdrop.classList.add('is-open');

        function cleanup() {
          backdrop.classList.remove('is-open');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
        }
        function onOk() { cleanup(); resolve(true); }
        function onCancel() { cleanup(); resolve(false); }
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
      });
    }
    
    function formatLabel(str) {
      if (!str) return '';
      return str.split('_').map(w => w.toLowerCase() === 'api' ? 'API' : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    
    // --- Live SSE ---
    const _tlContainer = document.getElementById('agent-timeline');
    const _tl = _tlContainer ? window.ThinkingLog.mount(_tlContainer, { maxRows: 0 }) : null;
    if (_tl && _tlContainer && _tlContainer.dataset.seedText) {
      _tl.append({ kind: 'thinking', text: _tlContainer.dataset.seedText });
      _tlContainer.removeAttribute('data-seed-text');
    }
    function appendAgentRow(ev) { if (_tl) _tl.append(ev); }

    document.querySelectorAll('.logs-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.logs-tab').forEach(b => {
          b.classList.remove('is-active');
          b.style.color = 'var(--fg-muted)';
        });
        btn.classList.add('is-active');
        btn.style.color = '';
        const tab = btn.dataset.tab;
        document.getElementById('agent-timeline').style.display = tab === 'timeline' ? '' : 'none';
        document.getElementById('raw-logs').style.display = tab === 'raw' ? '' : 'none';
      });
    });

    const evtSource = new EventSource('/api/pr/' + PRID + '/stream');
    evtSource.addEventListener('init', (e) => {
      const data = JSON.parse(e.data);
      if (data.analyzing) {
        setAnalyzingState(true);
        const logsEl = document.getElementById('raw-logs');
        if (logsEl && data.logs.length) {
          logsEl.textContent = data.logs.join('\\n');
          logsEl.scrollTop = logsEl.scrollHeight;
        }
        if (data.triage && data.triage.length) updateTriageUI(data.triage);
        if (Array.isArray(data.agent)) data.agent.forEach(appendAgentRow);
      }
    });
    evtSource.addEventListener('agent', (e) => {
      try { appendAgentRow(JSON.parse(e.data)); } catch (err) {}
    });
    evtSource.addEventListener('stage', (e) => {
      // Could surface a per-stage banner here later — for now, the dashboard handles it.
    });
    evtSource.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      setAnalyzingState(data.analyzing);
    });
    evtSource.addEventListener('log', (e) => {
      const msg = JSON.parse(e.data);
      const logsEl = document.getElementById('raw-logs');
      if (logsEl) {
        logsEl.textContent += (logsEl.textContent ? '\\n' : '') + msg;
        logsEl.scrollTop = logsEl.scrollHeight;
      }
    });
    evtSource.addEventListener('triage', (e) => {
      updateTriageUI(JSON.parse(e.data));
    });
    evtSource.addEventListener('done', async (e) => {
      const data = JSON.parse(e.data);
      if (data.ok) location.reload();
      else {
        await uiAlert('Analysis failed: ' + data.error, 'Error');
        setAnalyzingState(false);
      }
    });

    function setAnalyzingState(isAnalyzing) {
      const btn = document.getElementById('analyze-btn');
      const text = btn.querySelector('.btn-text');
      const loader = btn.querySelector('.btn-loader');
      btn.disabled = isAnalyzing;
      text.style.display = isAnalyzing ? 'none' : 'inline';
      loader.style.display = isAnalyzing ? 'inline' : 'none';
    }

    function updateTriageUI(items) {
      const btn = document.getElementById('triage-btn');
      const count = document.getElementById('triage-count');
      const tbody = document.getElementById('triage-tbody');
      if (btn) btn.style.display = '';
      if (count) count.textContent = items.length;
      if (tbody) {
        tbody.innerHTML = items.map(t => \`
          <tr>
            <td class="v-align-top" style="padding:12px 16px; width:1px;"><span class="Label Label--\${t.decision}">\${formatLabel(t.decision)}</span></td>
            <td style="padding:12px 16px;">
              <div class="text-bold" style="font-family: var(--mono); font-size: 11px; word-break: break-all;">\${escapeHtml(t.path || t.file)}</div>
              <div class="color-fg-muted mt-1">\${escapeHtml(t.reason)}</div>
            </td>
          </tr>\`).join('');
      }
    }

    async function loadDiff() {
      try {
        const r = await fetch('/api/pr/'+PRID+'/diff');
        if (!r.ok) throw new Error('Failed to load diff');
        const t = await r.text();
        const parsedDiff = Diff2Html.parse(t);
        const html = Diff2Html.html(parsedDiff, {
          drawFileList: false, 
          matching: 'lines', 
          outputFormat: 'line-by-line',
          smartSelection: true
        });
        document.getElementById('diff').innerHTML = html;
        buildSidebarTree(parsedDiff);
        injectComments();
        setupFileHeaders();
        setupManualCommenting();
      } catch (err) {
        document.getElementById('diff').innerHTML = '<div class="blankslate">Error loading diff: ' + err.message + '</div>';
      }
    }
    
    function buildSidebarTree(parsedDiff) {
      const commentsByFile = {};
      const severityRank = { blocker: 3, concern: 2, suggestion: 1, info: 0 };
      for (const d of DRAFTS) {
        if (d.action === 'deleted') continue;
        if (!commentsByFile[d.file]) commentsByFile[d.file] = { count: 0, topSeverity: 'info' };
        commentsByFile[d.file].count++;
        if ((severityRank[d.severity] ?? 0) > (severityRank[commentsByFile[d.file].topSeverity] ?? 0)) {
          commentsByFile[d.file].topSeverity = d.severity;
        }
      }

      const triageByFile = {};
      const triageRows = document.querySelectorAll('#triage-tbody tr');
      triageRows.forEach(row => {
        const fileNode = row.querySelector('.text-bold');
        if (!fileNode) return;
        const file = fileNode.textContent.trim();
        const label = row.querySelector('.Label');
        const decision = label && label.textContent.trim().toLowerCase() === 'skip' ? 'skip' : 'review';
        triageByFile[file] = decision;
      });

      const severityColor = { blocker: 'var(--accent-red)', concern: '#B7791F', suggestion: 'var(--accent-blue)', info: 'var(--fg-muted)' };
      const severityBg   = { blocker: 'var(--accent-red-dim)', concern: '#FFF5E5', suggestion: 'var(--accent-blue-dim)', info: '#F3F4F6' };

      const tree = {};
      parsedDiff.forEach(file => {
        const name = file.newName === '/dev/null' ? file.oldName : file.newName;
        const parts = name.split('/');
        let current = tree;
        parts.forEach((part, i) => {
          if (i === parts.length - 1) {
            current[part] = { _isFile: true, name: name, added: file.addedLines, deleted: file.deletedLines };
          } else {
            if (!current[part]) current[part] = {};
            current = current[part];
          }
        });
      });

      function renderNode(node, depth = 0) {
        let html = '';
        const keys = Object.keys(node).sort();

        for (let i = 0; i < keys.length; i++) {
          let key = keys[i];
          let item = node[key];

          if (item._isFile) {
            const isSkipped = triageByFile[item.name] === 'skip';
            const added = item.added > 0 ? \`<span style="color:var(--accent-green); font-size:10px; opacity:0.8;">+\${item.added}</span>\` : '';
            const deleted = item.deleted > 0 ? \`<span style="color:var(--accent-red); font-size:10px; opacity:0.8;">-\${item.deleted}</span>\` : '';

            let badge = '';
            const info = commentsByFile[item.name];
            if (info && info.count > 0) {
              const col = severityColor[info.topSeverity] ?? severityColor.info;
              const bg  = severityBg[info.topSeverity]   ?? severityBg.info;
              badge = \`<span onclick="scrollToComment('\${item.name}', event, this)" style="cursor: pointer; background:\${bg}; color:\${col}; padding: 1px 5px; border-radius: 10px; font-size: 10px; font-weight: 700; display: flex; align-items: center; gap: 2px; margin-right: 4px; transition: transform 0.1s;" title="\${info.count} comment\${info.count !== 1 ? 's' : ''}"><svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Z"/></svg>\${info.count}</span>\`;
            }

            html += \`<div class="Tree-item \${isSkipped ? 'is-skipped' : ''}" onclick="scrollToFile('\${item.name}', this)" style="padding-left: \${16 + (depth * 4)}px; opacity: \${isSkipped ? 0.5 : 1}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="Tree-icon" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span class="Tree-text" style="font-family:var(--mono); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; \${isSkipped ? 'text-decoration:line-through;' : ''}">\${key}</span>
              <div style="display:flex; align-items:center; gap:6px; margin-left:8px; flex-shrink:0;">\${badge}\${added}\${deleted}</div>
            </div>\`;
          } else {
            // Compact folders: if this folder has only one child and that child is also a folder, merge them
            let displayKey = key;
            let currentNode = item;
            let subKeys = Object.keys(currentNode);
            while (subKeys.length === 1 && !currentNode[subKeys[0]]._isFile) {
              displayKey += ' / ' + subKeys[0];
              currentNode = currentNode[subKeys[0]];
              subKeys = Object.keys(currentNode);
            }

            html += \`<div class="Tree-folder">
              <div class="Tree-folder-header" onclick="this.parentElement.classList.toggle('is-collapsed')" style="padding-left: \${16 + (depth * 4)}px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="Tree-icon" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                <span style="font-weight:600; color:var(--fg-muted); font-size:12px; white-space:nowrap;">\${displayKey}</span>
              </div>
              <div class="Tree-folder-children" style="margin-left:0; border-left:none;">\${renderNode(currentNode, depth + 1)}</div>
            </div>\`;
          }
        }
        return html;
      }
      document.getElementById('sidebar-content').innerHTML = renderNode(tree);
    }
    function scrollToFile(name, el) {
      document.querySelectorAll('.Tree-item').forEach(n => n.classList.remove('is-active'));
      if (el) el.classList.add('is-active');
      const wrappers = document.querySelectorAll('.d2h-file-wrapper');
      for (const w of wrappers) {
        if (w.querySelector('.d2h-file-name')?.textContent.trim() === name) {
          w.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
      }
    }

    function scrollToComment(name, e, el) {
      e.stopPropagation();
      document.querySelectorAll('.Tree-item').forEach(n => n.classList.remove('is-active'));
      if (el) el.closest('.Tree-item')?.classList.add('is-active');
      const wrappers = document.querySelectorAll('.d2h-file-wrapper');
      for (const w of wrappers) {
        if (w.querySelector('.d2h-file-name')?.textContent.trim() === name) {
          const firstComment = w.querySelector('.inline-comment-row');
          if (firstComment) {
            firstComment.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            w.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          break;
        }
      }
    }

    function setupFileHeaders() {
      document.querySelectorAll('.d2h-file-wrapper').forEach(wrapper => {
        const header = wrapper.querySelector('.d2h-file-header');
        if (!header) return;

        // ── Collapse toggle ──────────────────────────────────────────────
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'file-collapse-btn';
        toggleBtn.title = 'Collapse / expand file';
        toggleBtn.innerHTML = \`
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="collapse-icon">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        \`;

        const diffBody = wrapper.querySelector('.d2h-diff-tbody') 
          ?? wrapper.querySelector('tbody')
          ?? wrapper.querySelector('.d2h-wrapper');
        
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = toggleBtn.dataset.collapsed === 'true';
          const newState = !collapsed;
          toggleBtn.dataset.collapsed = newState.toString();
          
          if (diffBody) diffBody.closest('table, .d2h-wrapper').style.display = newState ? 'none' : '';
          wrapper.querySelectorAll('.inline-comment-row').forEach(r => r.style.display = newState ? 'none' : '');
          
          if (newState) wrapper.classList.add('is-collapsed');
          else wrapper.classList.remove('is-collapsed');
          
          toggleBtn.title = newState ? 'Expand file' : 'Collapse file';
          toggleBtn.querySelector('.collapse-icon').style.transform = newState ? 'rotate(-180deg)' : '';
        });

        // ── Inject into header ───────────────────────────────────────────
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.gap = '8px';

        const rightContainer = document.createElement('div');
        rightContainer.style.display = 'flex';
        rightContainer.style.alignItems = 'center';
        rightContainer.style.gap = '8px';
        rightContainer.style.marginLeft = 'auto';
        
        wrapper.querySelectorAll('.d2h-tag').forEach(tag => {
          if (tag.textContent === 'ADDED') tag.textContent = 'Added';
          if (tag.textContent === 'CHANGED') tag.textContent = 'Changed';
          if (tag.textContent === 'DELETED') tag.textContent = 'Deleted';
          if (tag.textContent === 'RENAMED') tag.textContent = 'Renamed';
          rightContainer.appendChild(tag);
        });

        rightContainer.appendChild(toggleBtn);
        header.appendChild(rightContainer);
      });
    }

    function toggleSummary() {
      const body = document.getElementById('summary-body');
      const chevron = document.getElementById('summary-chevron');
      if (!body) return;
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      if (chevron) chevron.style.transform = collapsed ? '' : 'rotate(-90deg)';
    }

    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('is-collapsed');
      document.body.classList.toggle('sidebar-collapsed');
    }
    
    function openDrawer(id) {
      document.getElementById('drawer-backdrop').classList.add('is-open');
      document.getElementById(id).classList.add('is-open');
    }
    
    function closeDrawer() {
      document.getElementById('drawer-backdrop').classList.remove('is-open');
      document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('is-open'));
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

    async function openSessionsDrawer() {
      openDrawer('sessions-drawer');
      const list = document.getElementById('sessions-list');
      const detail = document.getElementById('sessions-detail');
      list.innerHTML = '<div style="padding:18px; color:var(--fg-muted); font-size:13px;">Loading…</div>';
      try {
        const res = await fetch('/api/pr/' + PRID + '/sessions');
        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) {
          list.innerHTML = '<div style="padding:18px; color:var(--fg-muted); font-size:13px;">No sessions yet. Trigger an analyze to start one.</div>';
          return;
        }
        list.innerHTML = rows.map((r) => {
          const dur = r.ended_at && r.started_at ? Math.round((Date.parse(r.ended_at + 'Z') - Date.parse(r.started_at + 'Z')) / 1000) : null;
          const durStr = dur != null ? dur + 's' : '—';
          return '<div class="session-row" data-id="' + r.id + '" onclick="loadSession(' + r.id + ')">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<span style="font-weight:600;">#' + r.id + '</span>' +
              '<span class="pill ' + r.status + '">' + r.status + '</span>' +
            '</div>' +
            '<div class="meta">' + new Date(r.started_at + 'Z').toLocaleString() + ' · ' + durStr + ' · ' + r.event_count + ' events</div>' +
            '<div class="meta">' + (r.provider || '?') + (r.model ? ' / ' + r.model : '') + '</div>' +
          '</div>';
        }).join('');
        loadSession(rows[0].id);
      } catch (e) {
        list.innerHTML = '<div style="padding:18px; color:var(--danger); font-size:13px;">Failed to load: ' + (e && e.message || e) + '</div>';
      }
    }

    async function loadSession(id) {
      document.querySelectorAll('.session-row').forEach((r) => r.classList.toggle('is-active', Number(r.dataset.id) === id));
      const detail = document.getElementById('sessions-detail');
      detail.innerHTML = '<div style="color:var(--fg-muted); font-size:13px;">Loading events…</div>';
      try {
        const res = await fetch('/api/session/' + id + '/events');
        const data = await res.json();
        const events = data.events || [];
        if (events.length === 0) {
          detail.innerHTML = '<div style="color:var(--fg-muted); font-size:13px;">No events recorded for this session.</div>';
          return;
        }
        detail.innerHTML = events.map((e) => {
          const ts = new Date(e.ts + 'Z').toLocaleTimeString();
          let body = '';
          if (typeof e.payload === 'string') body = e.payload;
          else body = JSON.stringify(e.payload, null, 2);
          const stage = e.stage ? '<span class="ev-stage">' + e.stage + '</span>' : '';
          return '<div class="ev-row">' +
            '<span class="ev-kind">' + (e.kind || '') + '</span> ' +
            stage +
            '<span style="color:var(--fg-muted); font-size:10.5px;">' + ts + '</span>' +
            '<pre>' + escapeHtml(body) + '</pre>' +
          '</div>';
        }).join('');
      } catch (e) {
        detail.innerHTML = '<div style="color:var(--danger); font-size:13px;">Failed: ' + (e && e.message || e) + '</div>';
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }

    let allCollapsed = false;
    function toggleAllFiles() {
      allCollapsed = !allCollapsed;
      const btn = document.getElementById('collapse-all-btn');
      if(btn) btn.textContent = allCollapsed ? 'Expand All' : 'Collapse All';
      
      document.querySelectorAll('.d2h-file-wrapper').forEach(wrapper => {
        const toggleBtn = wrapper.querySelector('.file-collapse-btn');
        if (!toggleBtn) return;
        
        const diffBody = wrapper.querySelector('.d2h-diff-tbody') 
          ?? wrapper.querySelector('tbody')
          ?? wrapper.querySelector('.d2h-wrapper');
          
        if (diffBody) {
          diffBody.closest('table, .d2h-wrapper').style.display = allCollapsed ? 'none' : '';
        }
        wrapper.querySelectorAll('.inline-comment-row').forEach(r => r.style.display = allCollapsed ? 'none' : '');
        
        if (allCollapsed) wrapper.classList.add('is-collapsed');
        else wrapper.classList.remove('is-collapsed');
        
        toggleBtn.title = allCollapsed ? 'Expand file' : 'Collapse file';
        toggleBtn.querySelector('.collapse-icon').style.transform = allCollapsed ? 'rotate(-180deg)' : '';
        
        toggleBtn.dataset.collapsed = allCollapsed.toString();
      });
    }
    
    function escapeHtml(unsafe) {
      return (unsafe || '').toString()
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function startEdit(el) {
      const bodyContainer = el.closest('.review-comment-body');
      const mdView = bodyContainer.querySelector('.markdown-body');
      const textarea = bodyContainer.querySelector('.edit-textarea');
      mdView.style.display = 'none';
      textarea.style.display = 'block';
      textarea.focus();
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    }

    function toggleOriginal(btn) {
      const card = btn.closest('.review-comment');
      const mdView = card.querySelector('.markdown-body');
      if (mdView.dataset.mode === 'final') {
        mdView.dataset.mode = 'ai';
        mdView.innerHTML = marked.parse(btn.dataset.aiBody || '');
        mdView.style.background = 'rgba(255, 235, 200, 0.5)';
        mdView.style.cursor = 'default';
        btn.textContent = '↷ Show your edited version';
      } else {
        mdView.dataset.mode = 'final';
        mdView.innerHTML = marked.parse(btn.dataset.finalBody || '');
        mdView.style.background = '';
        mdView.style.cursor = 'text';
        btn.textContent = '↶ Show AI original';
      }
    }

    function injectComments() {
      DRAFTS.forEach(d => {
        if (d.action === 'deleted') return;
        
        const fileWrappers = document.querySelectorAll('.d2h-file-wrapper');
        let targetWrapper = null;
        for (const fw of fileWrappers) {
          const fileName = fw.querySelector('.d2h-file-name')?.textContent;
          if (fileName && fileName.trim() === d.file) {
            targetWrapper = fw;
            break;
          }
        }
        
        if (!targetWrapper) return;
        
        const rows = targetWrapper.querySelectorAll('tr');
        let targetRow = null;
        for (const row of rows) {
          const lineNumCell = row.querySelector('.d2h-code-linenumber');
          if (lineNumCell && lineNumCell.textContent.trim() === String(d.line)) {
            targetRow = row;
          }
        }
        
        if (targetRow) {
          const commentRow = document.createElement('tr');
          commentRow.className = 'inline-comment-row';
          const cell = document.createElement('td');
          cell.colSpan = 2;
          const wasEdited = d.ai_original_body && d.current_body && d.ai_original_body.trim() !== d.current_body.trim();
          const draftLabel = d.action === 'added'
            ? '<span class="text-small color-fg-muted ml-2">Human-added</span>'
            : wasEdited
              ? '<span class="text-small color-fg-muted ml-2">AI Draft <span style="color: var(--accent-blue);">· edited</span></span>'
              : '<span class="text-small color-fg-muted ml-2">AI Draft</span>';
          cell.innerHTML = \`
            <div class="review-comment" data-id="\${d.id}">
              <div class="review-comment-header">
                <div class="d-flex flex-items-center gap-2">
                  <span class="Label Label--\${d.severity}">\${formatLabel(d.severity)}</span>
                  \${draftLabel}
                </div>
                <div class="d-flex flex-items-center gap-2">
                  <select class="form-select form-select-sm" onchange="onEdit(\${d.id}, this, 'category')">
                    \${['correctness', 'security', 'data_integrity', 'api_contracts', 'maintainability'].map(c =>
                      \`<option value="\${c}" \${c === (d.category || 'correctness') ? 'selected' : ''}>\${formatLabel(c)}</option>\`
                    ).join('')}
                  </select>
                  <select class="form-select form-select-sm" onchange="onEdit(\${d.id}, this, 'severity')">
                    \${['blocker', 'concern', 'suggestion', 'info'].map(s =>
                      \`<option value="\${s}" \${s === d.severity ? 'selected' : ''}>\${formatLabel(s)}</option>\`
                    ).join('')}
                  </select>
                </div>
              </div>
              <div class="review-comment-body">
                <div class="markdown-body" data-mode="final" style="cursor: text; padding: 4px;" onclick="if(this.dataset.mode==='final') startEdit(this);">
                  \${marked.parse(d.current_body || '')}
                </div>
                <textarea class="form-control text-small edit-textarea" style="width:100%; display:none; overflow:hidden; resize:none; min-height:40px;" oninput="this.style.height='';this.style.height=this.scrollHeight+'px'" onblur="onEdit(\${d.id}, this, 'body')">\${escapeHtml(d.current_body)}</textarea>
              </div>
              <div class="review-comment-actions">
                <div class="d-flex flex-items-center gap-3">
                  <button class="btn-link color-fg-danger text-small" onclick="onDiscard(\${d.id}, this)">Discard</button>
                  \${wasEdited ? \`<button class="btn-link text-small toggle-original" data-ai-body="\${escapeHtml(d.ai_original_body)}" data-final-body="\${escapeHtml(d.current_body)}" onclick="toggleOriginal(this)" style="color: var(--accent-blue); text-decoration: none;">↶ Show AI original</button>\` : ''}
                </div>
                <span class="saved-status color-fg-success text-small" style="opacity:0; transition:opacity 0.2s;">Saved</span>
              </div>
            </div>
          \`;
          commentRow.appendChild(cell);
          targetRow.parentNode.insertBefore(commentRow, targetRow.nextSibling);
        }
      });
    }

    function setupManualCommenting() {
      const template = document.createElement('template');
      template.innerHTML = \`
        <tr class="manual-comment-row">
          <td colspan="2">
            <div class="review-comment">
              <div class="review-comment-header">
                <span class="text-bold text-small">Add Comment</span>
                <div class="d-flex flex-items-center gap-2">
                  <select class="form-select form-select-sm mc-category">
                    <option value="correctness">Correctness</option>
                    <option value="security">Security</option>
                    <option value="data_integrity">Data Integrity</option>
                    <option value="api_contracts">API Contracts</option>
                    <option value="maintainability">Maintainability</option>
                  </select>
                  <select class="form-select form-select-sm mc-severity">
                    <option value="suggestion">Suggestion</option>
                    <option value="concern">Concern</option>
                    <option value="blocker">Blocker</option>
                    <option value="info">Info</option>
                  </select>
                </div>
              </div>
              <div class="review-comment-body">
                <textarea class="form-control text-small mc-body" style="width:100%; min-height:40px; overflow:hidden; resize:none;" oninput="this.style.height='';this.style.height=this.scrollHeight+'px'" placeholder="Leave a comment..."></textarea>
              </div>
              <div class="review-comment-actions d-flex flex-justify-end gap-2">
                <button class="btn btn-sm btn-outline mc-cancel">Cancel</button>
                <button class="btn btn-sm btn-primary mc-save">Add Comment</button>
              </div>
            </div>
          </td>
        </tr>
      \`;

      document.querySelectorAll('.d2h-code-linenumber').forEach(cell => {
        cell.style.cursor = 'pointer';
        cell.title = 'Click to add a comment';
        
        cell.addEventListener('click', (e) => {
          const row = cell.closest('tr');
          const wrapper = cell.closest('.d2h-file-wrapper');
          const fileName = wrapper.querySelector('.d2h-file-name').textContent.trim();
          const lineNum = cell.textContent.trim();
          
          if (!lineNum) return;
          if (row.nextSibling && row.nextSibling.classList && row.nextSibling.classList.contains('manual-comment-row')) return;

          const formRow = template.content.cloneNode(true).querySelector('tr');
          row.parentNode.insertBefore(formRow, row.nextSibling);
          
          const insertedRow = row.nextSibling;
          insertedRow.querySelector('.mc-body').focus();
          
          insertedRow.querySelector('.mc-cancel').addEventListener('click', () => {
            insertedRow.remove();
          });
          
          insertedRow.querySelector('.mc-save').addEventListener('click', async () => {
            const severity = insertedRow.querySelector('.mc-severity').value;
            const category = insertedRow.querySelector('.mc-category').value;
            const body = insertedRow.querySelector('.mc-body').value.trim();
            if (!body) return;
            
            const btn = insertedRow.querySelector('.mc-save');
            btn.disabled = true;
            btn.textContent = 'Saving...';
            
            const r = await fetch('/api/pr/'+PRID+'/comment', {
              method:'POST', 
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify({file: fileName, line: lineNum, side:'new', severity, category, body})
            });
            if (r.ok) location.reload();
          });
        });
      });
    }

    async function analyzePR(id) {
      setAnalyzingState(true);
      try {
        const r = await fetch('/api/pr/'+id+'/analyze', {method:'POST'});
        const j = await r.json();
        if (!j.ok) {
          await uiAlert('Analysis failed: ' + j.error, 'Error');
          setAnalyzingState(false);
        }
      } catch (err) {
        await uiAlert('Network error: ' + err.message, 'Connection Error');
        setAnalyzingState(false);
      }
    }

    async function save(id, payload) {
      await fetch('/api/comment/'+id, {
        method:'POST', 
        headers:{'Content-Type':'application/json'}, 
        body: JSON.stringify(payload)
      });
    }

    async function onEdit(id, el, field) {
      const card = el.closest('.review-comment');
      const status = card.querySelector('.saved-status');
      const textarea = card.querySelector('textarea.edit-textarea') || card.querySelector('textarea');
      
      const payload = {
        current_body: textarea.value,
        severity: card.querySelectorAll('select')[1].value, // second select is severity
        category: card.querySelectorAll('select')[0].value, // first select is category
        action: 'edited'
      };
      
      await save(id, payload);
      
      if (field === 'severity') {
        const label = card.querySelector('.Label');
        label.className = 'Label Label--' + payload.severity;
        label.textContent = payload.severity;
      }

      if (field === 'body' && el.classList.contains('edit-textarea')) {
        const bodyContainer = el.closest('.review-comment-body');
        const mdView = bodyContainer.querySelector('.markdown-body');
        mdView.innerHTML = marked.parse(payload.current_body || '');
        el.style.display = 'none';
        mdView.style.display = 'block';
      }
      
      status.style.opacity = '1';
      setTimeout(() => status.style.opacity = '0', 1500);
    }

    async function onDiscard(id, el) {
      const card = el.closest('.review-comment');
      // Inline reason picker, replaces the action bar contents until a choice is made.
      const actions = card.querySelector('.review-comment-actions');
      const original = actions.innerHTML;
      actions.innerHTML = \`
        <div class="d-flex flex-items-center gap-2 flex-wrap" style="width:100%;">
          <span class="text-small color-fg-muted">Why discard?</span>
          <button class="btn btn-sm btn-outline" data-reason="noise">noise</button>
          <button class="btn btn-sm btn-outline" data-reason="wrong">wrong</button>
          <button class="btn btn-sm btn-outline" data-reason="out_of_scope">out of scope</button>
          <button class="btn btn-sm btn-outline" data-reason="style_nit">style nit</button>
          <button class="btn btn-sm btn-outline" data-reason="other">other...</button>
          <button class="btn-link text-small color-fg-muted" data-reason="__cancel">cancel</button>
        </div>
      \`;
      actions.querySelectorAll('button[data-reason]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const reason = btn.getAttribute('data-reason');
          if (reason === '__cancel') { actions.innerHTML = original; return; }
          let finalReason = reason;
          if (reason === 'other') {
            const txt = prompt('Reason for discarding (free text):');
            if (txt === null) { actions.innerHTML = original; return; }
            finalReason = 'other:' + (txt || '').slice(0, 200);
          }
          await save(id, {action: 'deleted', reject_reason: finalReason});
          const row = card.closest('tr');
          row.style.opacity = '0.3';
          row.style.pointerEvents = 'none';
        });
      });
    }

    async function submitAll(prId) {
      if (!await uiConfirm('Post all kept/edited/added comments to the forge?', 'Submit Review')) return;
      const r = await fetch('/api/pr/'+prId+'/submit', {method:'POST'});
      const j = await r.json();
      let msg = 'Posted ' + j.posted + ' comments.';
      if (j.errors && j.errors.length) msg += '\\n\\nErrors:\\n' + j.errors.join('\\n');
      await uiAlert(msg, 'Review Submitted');
      location.reload();
    }
    
    loadDiff();

    let _idxKey = null;

    function closeIndexModal() {
      document.getElementById('index-modal-backdrop').classList.remove('is-open');
      _idxKey = null;
    }

    function submitManualPath() {
      const el = document.getElementById('manual-path');
      if (el && el.value.trim()) bindAndIndex(_idxKey, el.value.trim());
    }

    async function openIndexModal(prKey, repoName) {
      _idxKey = prKey;
      const body = document.getElementById('index-modal-body');
      const backdrop = document.getElementById('index-modal-backdrop');
      body.innerHTML = '<div style="padding:24px;color:var(--fg-muted);font-size:13px;">Searching for <strong>' + repoName + '</strong>…</div>';
      backdrop.classList.add('is-open');

      let candidates;
      try {
        const r = await fetch('/api/projects/' + prKey + '/candidates');
        candidates = await r.json();
      } catch(e) {
        body.innerHTML = '<div style="padding:24px;color:var(--fg-muted);">Error: ' + e.message + '</div>';
        return;
      }

      if (candidates.length === 0) {
        body.innerHTML = '<div style="padding:20px 24px;"><p style="margin:0 0 12px;font-size:13px;color:var(--fg-muted);">No matches found. Enter the path manually:</p><input id="manual-path" type="text" placeholder="/Users/you/projects/' + repoName + '" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:12px;box-sizing:border-box;"><div style="margin-top:12px;text-align:right;"><button class="btn btn-sm btn-primary" onclick="submitManualPath()">Link &amp; Index</button></div></div>';
        return;
      }

      body.innerHTML = '<div style="padding:16px 24px 8px;font-size:13px;color:var(--fg-muted);">Select the local folder for <strong>' + repoName + '</strong>:</div><ul id="candidates-list" style="margin:0;padding:0;max-height:320px;overflow-y:auto;"></ul>';
      const ul = document.getElementById('candidates-list');
      candidates.forEach(function(p) {
        const li = document.createElement('li');
        li.style.listStyle = 'none';
        const btn = document.createElement('button');
        btn.textContent = p;
        btn.style.cssText = 'width:100%;text-align:left;padding:10px 16px;border:none;background:none;cursor:pointer;font-family:var(--mono);font-size:12px;border-bottom:1px solid var(--border);display:block;color:var(--fg-default);';
        btn.addEventListener('mouseover', function() { btn.style.background = 'var(--border)'; });
        btn.addEventListener('mouseout', function() { btn.style.background = 'none'; });
        btn.addEventListener('click', function() { bindAndIndex(_idxKey, p); });
        li.appendChild(btn);
        ul.appendChild(li);
      });
    }

    // Bind a local path then kick off indexing. The modal closes immediately;
    // live progress shows up in the header badge driven by /api/stream SSE.
    async function bindAndIndex(prKey, localPath) {
      if (!localPath || !localPath.trim()) return;
      const body = document.getElementById('index-modal-body');
      body.innerHTML = '<div style="padding:24px;font-size:13px;color:var(--fg-muted);">Linking path…</div>';
      try {
        await fetch('/api/projects/' + prKey + '/path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ local_path: localPath })
        });
      } catch (e) {
        body.innerHTML = '<div style="padding:24px;color:var(--accent-red,#cf222e);">Failed to link path: ' + e.message + '</div>';
        return;
      }
      const r = await fetch('/api/projects/' + prKey + '/index', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        body.innerHTML = '<div style="padding:24px;color:var(--accent-red,#cf222e);">Index failed: ' + j.error + '</div>';
        return;
      }
      closeIndexModal();
    }

    // The header "Index"/"Re-index" button. If a local path is already bound
    // we just kick off indexing and let the SSE-driven badge show progress.
    // Otherwise fall back to the candidate-discovery modal (still useful for
    // first-time setup) which itself ends in bindAndIndex.
    async function indexBtnClick(prKey, repoName, hasPath) {
      if (!hasPath) { openIndexModal(prKey, repoName); return; }
      const badge = document.querySelector('.idx-badge[data-idx-key="' + prKey + '"]');
      if (badge) badge.innerHTML = '<span class="idx-spin"></span> Starting…';
      try {
        const r = await fetch('/api/projects/' + prKey + '/index', { method: 'POST' });
        const j = await r.json();
        if (!j.ok) {
          if (badge) badge.innerHTML = '<span style="color:var(--accent-red,#cf222e);">' + (j.error || 'failed') + '</span>';
        }
      } catch (e) {
        if (badge) badge.innerHTML = '<span style="color:var(--accent-red,#cf222e);">' + e.message + '</span>';
      }
    }

    function _idxEsc(s) { return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function applyIndexProgress(d) {
      if (!d || !d.key) return;
      const ek = encodeURIComponent(d.key);
      const badge = document.querySelector('.idx-badge[data-idx-key="' + ek + '"]');
      if (!badge) return;
      const phaseLabel = d.phase === 'walk' ? 'Scanning' : d.phase === 'defs' ? 'Indexing' : d.phase === 'calls' ? 'Linking calls' : 'Indexing';
      const ratio = d.filesTotal ? Math.min(100, Math.round((d.files / d.filesTotal) * 100)) : null;
      const counter = d.filesTotal ? d.files + '/' + d.filesTotal : 'preparing';
      badge.innerHTML = '<span class="idx-spin"></span> ' + phaseLabel + ' · ' + counter +
        (ratio != null ? ' · ' + ratio + '%' : '') +
        (d.symbols ? ' · ' + d.symbols + ' symbols' : '');
    }

    async function applyIndexDone(d) {
      if (!d || !d.key) return;
      const ek = encodeURIComponent(d.key);
      const badge = document.querySelector('.idx-badge[data-idx-key="' + ek + '"]');
      if (!badge) return;
      if (!d.ok) {
        badge.innerHTML = '<span style="color:var(--accent-red,#cf222e);">Index failed: ' + _idxEsc(d.error || '') + '</span>';
        return;
      }
      badge.innerHTML = '<span style="color:var(--accent-green,#1f883d);">✓ Indexed</span> · ' + (d.symbols || 0) + ' symbols';
      const btnText = document.getElementById('index-btn-text');
      if (btnText && d.symbols != null) btnText.textContent = 'Re-index (' + d.symbols + ' symbols)';
    }

    // Subscribe to dashboard SSE for index events targeting this PR's repo.
    try {
      const _idxStream = new EventSource('/api/stream');
      _idxStream.addEventListener('init', (e) => {
        const data = JSON.parse(e.data);
        (data.indexes || []).forEach(applyIndexProgress);
      });
      _idxStream.addEventListener('index_progress', (e) => applyIndexProgress(JSON.parse(e.data)));
      _idxStream.addEventListener('index_done', (e) => applyIndexDone(JSON.parse(e.data)));
    } catch (err) { /* ignored */ }
  </script>
</body>
</html>`;
}

function renderDocs(): string {
  let md = '';
  try { md = fs.readFileSync(DOCS_PATH, 'utf8'); }
  catch { md = '# Docs\n\n`DOCS.md` not found at ' + DOCS_PATH; }
  const json = JSON.stringify(md);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Lens — Documentation</title>
  <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
  ${BASE_CSS}
  <style>
    .docs { padding: 64px 0 120px; line-height: 1.6; }
    .docs h1 { font-size: 40px; font-weight: 800; border-bottom: 1px solid var(--border); padding-bottom: 24px; margin-bottom: 32px; letter-spacing: -0.05em; }
    .docs h2 { font-size: 24px; font-weight: 700; margin-top: 48px; border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 24px; letter-spacing: -0.03em; scroll-margin-top: 80px; }
    .docs h3 { font-size: 18px; font-weight: 600; margin-top: 32px; margin-bottom: 16px; scroll-margin-top: 80px; }
    .docs p { margin-bottom: 16px; font-size: 15px; color: #333; }
    .docs ul, .docs ol { margin-bottom: 24px; padding-left: 24px; font-size: 15px; color: #333; }
    .docs li { margin-bottom: 8px; }
    .docs code { background: rgba(0,0,0,0.04); padding: 4px 6px; border-radius: 4px; font-family: var(--mono); font-size: 13px; color: var(--accent-red); }
    .docs pre { background: var(--primary-black); color: var(--primary-white); padding: 24px; border-radius: var(--radius-lg); overflow: auto; margin: 32px 0; box-shadow: var(--shadow-sm); }
    .docs pre code { background: transparent; padding: 0; color: inherit; font-size: 13px; border: none; }
    .docs table { width: 100%; margin: 32px 0; border-collapse: collapse; background: var(--primary-white); box-shadow: var(--shadow-sm); border-radius: var(--radius-lg); overflow: hidden; }
    .docs th { background: rgba(250,250,250,0.8); border-bottom: 1px solid var(--border); padding: 12px 16px; text-align: left; font-weight: 600; font-size: 13px; }
    .docs td { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 14px; }
    .docs tr:last-child td { border-bottom: none; }
    .docs blockquote { border-left: 4px solid var(--primary-black); background: rgba(0,0,0,0.02); padding: 16px 24px; color: var(--fg-muted); margin: 32px 0; font-style: italic; border-radius: 0 var(--radius) var(--radius) 0; }
    .docs blockquote p { margin: 0; }
    .docs img { max-width: 100%; border-radius: var(--radius-lg); border: 1px solid var(--border); box-shadow: var(--shadow-sm); margin: 32px 0; }
    .docs a { color: var(--accent-blue); text-decoration: none; font-weight: 500; }
    .docs a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <header class="Header">
    <div class="Header-item">
      <a href="/" class="Header-link d-flex flex-items-center" style="padding: 0;">
        <div style="color: var(--primary-black); display: flex;">${LOGO_SVG}</div>
      </a>
    </div>
    <div class="Header-item Header-item--full"></div>
    <div class="Header-item">
      <a href="/docs" class="Header-link" style="color: var(--accent-blue);">Docs</a>
    </div>
  </header>

  <main class="container-lg p-responsive">
    <article class="docs" id="docs">loading…</article>
  </main>
  <script>
    try {
      const renderer = new marked.Renderer();
      const slug = (s) => String(s == null ? '' : s).toLowerCase()
        .replace(/[^\\w\\s-]/g, '')
        .replace(/\\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
      renderer.heading = function (text, level, raw) {
        // marked v12 passes (text, level, raw); v13+ passes a single token object.
        if (text && typeof text === 'object') {
          const tok = text;
          const inner = (tok.text != null) ? tok.text
            : (this.parser ? this.parser.parseInline(tok.tokens || []) : '');
          const lv = tok.depth || 1;
          const id = slug(tok.raw || inner);
          return '<h' + lv + ' id="' + id + '">' + inner + '</h' + lv + '>\\n';
        }
        const id = slug(raw || text);
        return '<h' + level + ' id="' + id + '">' + text + '</h' + level + '>\\n';
      };
      document.getElementById('docs').innerHTML = marked.parse(${json}, { renderer });
    } catch (err) {
      console.error('docs render failed, falling back to default:', err);
      document.getElementById('docs').innerHTML = marked.parse(${json});
    }
    
    // Handle initial hash jump after rendering
    if (window.location.hash) {
      setTimeout(() => {
        const id = decodeURIComponent(window.location.hash.substring(1));
        const el = document.getElementById(id);
        if (el) el.scrollIntoView();
      }, 100);
    }
  </script>
</body>
</html>`;
}


const BASE_CSS = `<style>
  @import url('https://cdn.jsdelivr.net/npm/geist@latest/dist/fonts/geist-sans/style.css');
  @import url('https://cdn.jsdelivr.net/npm/geist@latest/dist/fonts/geist-mono/style.css');

  :root {
    --bg: #FAFAFA;
    --fg: #111111;
    --fg-muted: #666666;
    --border: #EAEAEA;
    --border-hover: #CCCCCC;
    --primary-black: #000000;
    --primary-white: #FFFFFF;
    --accent-blue: #0055FF;
    --accent-blue-dim: rgba(0, 85, 255, 0.1);
    --accent-red: #E00000;
    --accent-red-dim: rgba(224, 0, 0, 0.1);
    --accent-green: #00A36C;
    --accent-green-dim: rgba(0, 163, 108, 0.1);
    --shadow-sm: 0 4px 14px rgba(0,0,0,0.04);
    --shadow-md: 0 8px 30px rgba(0,0,0,0.08);
    --radius: 12px;
    --radius-lg: 16px;
    --mono: 'Geist Mono', 'JetBrains Mono', ui-monospace, monospace;
  }

  * { box-sizing: border-box; }
  body { 
    font-family: 'Geist Sans', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--fg);
    margin: 0;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  /* Typography */
  h1, h2, h3 { color: var(--primary-black); margin: 0; letter-spacing: -0.04em; }
  .text-bold { font-weight: 600 !important; }
  .text-small { font-size: 12px !important; }
  .f4 { font-size: 18px !important; font-weight: 700 !important; letter-spacing: -0.05em; }
  .h2 { font-size: 32px !important; font-weight: 800 !important; }
  .color-fg-muted { color: var(--fg-muted) !important; }
  .color-fg-danger { color: var(--accent-red) !important; }
  .color-fg-success { color: var(--accent-green) !important; }
  .color-fg-default { color: var(--fg) !important; }

  /* Spacing & Flex */
  .mt-1 { margin-top: 4px !important; } .mt-2 { margin-top: 8px !important; }
  .mt-4 { margin-top: 32px !important; } .mb-3 { margin-bottom: 16px !important; }
  .mb-4 { margin-bottom: 32px !important; }
  .mr-2 { margin-right: 8px !important; } .ml-2 { margin-left: 8px !important; }
  .p-responsive { padding-left: 24px; padding-right: 24px; }
  .gap-2 { gap: 8px !important; }
  .d-flex { display: flex; }
  .flex-justify-between { justify-content: space-between; }
  .flex-justify-end { justify-content: flex-end; }
  .flex-items-center { align-items: center; }
  .flex-items-start { align-items: flex-start; }
  .float-right { float: right; }

  /* Containers */
  .container-lg { max-width: 1080px; margin-left: auto; margin-right: auto; }

  /* App Header & Review Bar */
  .Header { 
    display: flex; 
    align-items: center; 
    padding: 0 24px; 
    height: 64px;
    background-color: rgba(255, 255, 255, 0.85); 
    backdrop-filter: saturate(180%) blur(16px); 
    -webkit-backdrop-filter: saturate(180%) blur(16px);
    border-bottom: 1px solid var(--border); 
    position: sticky; 
    top: 0; 
    z-index: 200; 
    border-bottom-left-radius: var(--radius);
    border-bottom-right-radius: var(--radius);
  }
  .Header-item { display: flex; align-items: center; }
  .Header-item--full { flex: 1; min-width: 0; padding: 0 24px; }
  .Header-link { color: var(--fg); text-decoration: none; font-weight: 700; font-size: 16px; letter-spacing: -0.02em; }
  
  .header-pr-info { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .header-pr-title { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
  .header-pr-number { color: var(--fg-muted); font-weight: 400; }

  /* Forms */
  .Layout { display: flex; gap: 40px; }
  .Layout-main { flex: 1 1 0%; min-width: 0; }
  .Layout-sidebar { width: 320px; flex-shrink: 0; display: flex; flex-direction: column; gap: 24px; }

  /* Buttons */
  .btn { 
    display: inline-flex; 
    align-items: center; 
    justify-content: center; 
    padding: 0 16px; 
    height: 36px;
    font-size: 13px; 
    font-weight: 600; 
    cursor: pointer; 
    border-radius: var(--radius); 
    transition: all 0.2s ease; 
    text-decoration: none; 
    border: 1px solid var(--border); 
    background: var(--primary-white); 
    color: var(--fg); 
    box-shadow: var(--shadow-sm);
    line-height: 1;
    white-space: nowrap;
  }
  .btn:hover { border-color: var(--primary-black); transform: translateY(-1px); box-shadow: var(--shadow-md); }
  .btn-sm { height: 32px; padding: 0 12px; font-size: 12px; }
  .btn-primary { background: var(--primary-black); color: var(--primary-white); border-color: var(--primary-black); }
  .btn-primary:hover { background: #333; border-color: #333; color: var(--primary-white); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; box-shadow: var(--shadow-sm) !important; }
  .btn-link { display: inline-block; padding: 0; background: transparent; border: 0; color: var(--accent-blue); cursor: pointer; text-decoration: none; font-weight: 500; box-shadow: none; }
  .btn-link:hover { text-decoration: underline; transform: none; box-shadow: none; border-color: transparent; }

  /* Forms */
  .form-control, .form-select { width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid var(--border); border-radius: var(--radius); outline: none; transition: border-color 0.2s, box-shadow 0.2s; font-family: inherit; }
  .form-control:focus, .form-select:focus { border-color: var(--primary-black); box-shadow: 0 0 0 3px rgba(0,0,0,0.05); }

  /* Labels / Tags */
  .State { 
    display: inline-flex; 
    align-items: center; 
    padding: 3px 12px; 
    font-size: 10px; 
    font-weight: 700; 
    text-transform: uppercase; 
    letter-spacing: 0.05em; 
    border-radius: 20px;
    border: 1px solid transparent;
  }
  .State--DRAFT_READY { background: #FFF5E5; color: #B7791F; border-color: rgba(183, 121, 31, 0.1); }
  .State--SUBMITTED { background: var(--accent-green-dim); color: var(--accent-green); border-color: rgba(0, 163, 108, 0.1); }
  .State--ANALYZING { background: var(--accent-blue-dim); color: var(--accent-blue); border-color: rgba(0, 85, 255, 0.1); }
  .State--NEW { background: #F3F4F6; color: var(--fg-muted); border-color: rgba(0, 0, 0, 0.05); }

  /* Forge state pill — same shape/typography as .State so they sit cleanly
     together. Color palette signals the GitHub/Bitbucket lifecycle state. */
  .ForgeState {
    display: inline-flex; align-items: center;
    padding: 3px 12px;
    font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em;
    border-radius: 20px; border: 1px solid transparent;
  }
  .ForgeState--OPEN   { background: #dafbe1; color: #1a7f37; border-color: rgba(26,127,55,0.18); }
  .ForgeState--DRAFT  { background: #eaeef2; color: #57606a; border-color: rgba(87,96,106,0.22); }
  .ForgeState--MERGED { background: #f1ebff; color: #6639ba; border-color: rgba(94,59,182,0.22); }
  .ForgeState--CLOSED { background: #ffebe9; color: #a40e26; border-color: rgba(164,14,38,0.22); }

  /* Wrap the two pills + stuck badge + reset button on one line, with a
     consistent gap; never stack vertically just because the cell is narrow. */
  .state-stack {
    display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;
    line-height: 1;
  }
  
  .Label { display: inline-flex; padding: 2px 8px; font-size: 11px; font-weight: 600; text-transform: uppercase; border-radius: 4px; }
  .Label--blocker { background: var(--accent-red-dim); color: var(--accent-red); }
  .Label--concern { background: #FFF5E5; color: #B7791F; }
  .Label--suggestion { background: var(--accent-blue-dim); color: var(--accent-blue); }
  .Label--category { background: #F3F4F6; color: #656d76; font-size: 10px; font-weight: 500; }
  .Label--info { background: #F3F4F6; color: var(--fg-muted); }

  /* Cards (Box) */
  .Box { background: var(--primary-white); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-sm); transition: box-shadow 0.2s ease; }
  .Box:hover { box-shadow: var(--shadow-md); }
  .Box-header { padding: 16px 20px; background: rgba(250,250,250,0.5); border-bottom: 1px solid var(--border); }
  .Box-title { font-size: 15px; font-weight: 500; }
  .Box-body { padding: 20px; border-bottom: 1px solid var(--border); }
  .Box-body:last-child { border-bottom: none; }
  
  .Counter { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; font-size: 12px; font-weight: 600; background: var(--primary-black); color: var(--primary-white); border-radius: 12px; }

  /* Dashboard Tables */
  .dashboard-table { width: 100%; border-collapse: collapse; }
  .dashboard-table td { padding: 16px 20px; border-bottom: 1px solid var(--border); font-size: 14px; transition: background 0.1s; }
  .dashboard-table tr:hover td { background: rgba(0,0,0,0.01); }
  .dashboard-table tr:last-child td { border-bottom: none; }
  .dashboard-table a { color: var(--primary-black); text-decoration: none; font-weight: 500; transition: color 0.2s; }
  .dashboard-table a:hover { color: var(--accent-blue); }
  
  .blankslate { padding: 64px 32px; text-align: center; background: var(--primary-white); border: 1px dashed var(--border-hover); border-radius: var(--radius-lg); }
  .blankslate h3 { font-size: 20px; margin-bottom: 8px; }

  /* Accordions / Logs */
  .details-reset > summary { list-style: none; cursor: pointer; outline: none; }
  .details-reset > summary::-webkit-details-marker { display: none; }
  .terminal-logs { font-family: var(--mono); font-size: 12px; padding: 16px; background: #0A0A0A; color: #EAEAEA; border-radius: var(--radius); overflow: auto; max-height: 400px; line-height: 1.5; margin: 16px 0 0 0; }
  
  .triage-table { width: 100%; border-collapse: collapse; }
  .triage-table td { padding: 12px 0; border-bottom: 1px solid var(--border); }
  .triage-table tr:last-child td { border-bottom: none; }

  /* App Layout */
  .App { display: flex; flex-direction: column; height: 100vh; overflow: hidden; background: var(--bg); }
  .App-header { flex: 0 0 auto; z-index: 10; border-bottom: 1px solid var(--border); }
  .App-body { display: flex; flex: 1; overflow: hidden; }
  
  /* Sidebar */
  .Sidebar { width: 300px; flex: 0 0 auto; background: var(--bg); border-right: 1px solid var(--border); display: flex; flex-direction: column; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); overflow: hidden; }
  .Sidebar.is-collapsed { width: 48px; }
  .Sidebar-header { padding: 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; flex: 0 0 auto; background: rgba(250,250,250,0.5); font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; }
  .Sidebar.is-collapsed .sidebar-title { opacity: 0; visibility: hidden; }
  .Sidebar-content { flex: 1; overflow-y: auto; padding: 12px 0; font-size: 13px; transition: opacity 0.2s; }
  .Sidebar.is-collapsed .Sidebar-content { opacity: 0; visibility: hidden; }
  .sidebar-title { transition: opacity 0.2s; }
  .sidebar-toggle-btn { flex-shrink: 0; }
  
  /* File Tree */
  .Tree-item { display: flex; align-items: center; padding: 6px 16px 6px 16px; cursor: pointer; color: var(--fg-default); user-select: none; gap: 8px; text-decoration: none; border-left: 2px solid transparent; }
  .Tree-item:hover { background: rgba(0,0,0,0.03); }
  .Tree-item.is-active { background: rgba(0,0,0,0.06); font-weight: 500; border-left-color: var(--accent-blue); }
  .Tree-item.is-skipped { color: var(--fg-muted); }
  .Tree-item.is-skipped .Tree-text { text-decoration: line-through; opacity: 0.6; }
  .Tree-folder { cursor: pointer; user-select: none; }
  .Tree-folder-header { display: flex; align-items: center; padding: 6px 16px 6px 16px; gap: 8px; color: var(--fg-muted); }
  .Tree-folder-header:hover { background: rgba(0,0,0,0.03); color: var(--fg-default); }
  .Tree-folder-children { display: flex; flex-direction: column; border-left: 1px solid var(--border); margin-left: 21px; }
  .Tree-folder.is-collapsed .Tree-folder-children { display: none; }
  .Tree-icon { width: 14px; height: 14px; opacity: 0.7; flex-shrink: 0; }
  
  /* Main View */
  .MainView { flex: 1; overflow-y: auto; background: var(--bg); display: flex; flex-direction: column; position: relative; scroll-behavior: smooth; }
  .MainView-content { padding: 32px 48px; max-width: 1400px; margin: 0 auto; width: 100%; }

  /* Custom Modal */
  .modal-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 2000; opacity: 0; visibility: hidden; transition: opacity 0.2s; display: flex; align-items: center; justify-content: center; }
  .modal-backdrop.is-open { opacity: 1; visibility: visible; }
  .modal { background: var(--primary-white); border-radius: var(--radius-lg); box-shadow: var(--shadow-md); width: 420px; max-width: 90vw; overflow: hidden; transform: scale(0.95); transition: transform 0.2s; }
  .modal-backdrop.is-open .modal { transform: scale(1); }
  .modal-header { padding: 16px 20px; border-bottom: 1px solid var(--border); font-weight: 700; font-size: 16px; background: rgba(250,250,250,0.5); letter-spacing: -0.02em; }
  .modal-body { padding: 20px 24px; font-size: 14px; color: var(--fg-muted); line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .modal-footer { padding: 16px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 12px; background: rgba(250,250,250,0.5); }

  /* Color-Blind Accessible Diff Colors */
  .d2h-ins { background-color: #e0f2fe !important; }
  .d2h-ins .d2h-code-line-ctn { background-color: #e0f2fe !important; }
  .d2h-ins .d2h-code-line-prefix, .d2h-ins .d2h-code-linenumber { background-color: #bae6fd !important; color: #0284c7 !important; border-color: #bae6fd !important; }
  .d2h-ins .d2h-code-line-prefix { color: #0284c7 !important; font-weight: 700 !important; }
  .d2h-ins ins { background-color: #7dd3fc !important; border-radius: 2px; }

  .d2h-del { background-color: #ffedd5 !important; }
  .d2h-del .d2h-code-line-ctn { background-color: #ffedd5 !important; }
  .d2h-del .d2h-code-line-prefix, .d2h-del .d2h-code-linenumber { background-color: #fed7aa !important; color: #ea580c !important; border-color: #fed7aa !important; }
  .d2h-del .d2h-code-line-prefix { color: #ea580c !important; font-weight: 700 !important; }
  .d2h-del del { background-color: #fdba74 !important; border-radius: 2px; }

  /* Diff Comments Styling */
  .d2h-file-wrapper { border: 1px solid var(--border) !important; border-radius: var(--radius-lg) !important; margin-bottom: 32px !important; overflow: hidden; box-shadow: var(--shadow-sm); transition: margin-bottom 0.2s; }
  .d2h-file-wrapper.is-collapsed { margin-bottom: 12px !important; }
  .d2h-file-header .d2h-tag { border-radius: 10px !important; padding: 1px 6px !important; font-size: 9px !important; border-width: 1px !important; margin-left: 0 !important; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; height: 18px !important; line-height: 1 !important; }
  .d2h-file-header { background: rgba(250,250,250,0.5) !important; border-bottom: 1px solid var(--border) !important; padding: 12px 20px !important; }
  .d2h-code-linenumber { cursor: pointer; transition: background 0.1s; position: relative; }
  .d2h-code-linenumber:hover { background-color: var(--border) !important; }
  .d2h-code-linenumber::after { content: '+'; position: absolute; left: 8px; opacity: 0; font-weight: 800; color: var(--primary-white); background: var(--accent-blue); border-radius: 4px; width: 16px; height: 16px; line-height: 16px; text-align: center; z-index: 10; margin-top: 2px; transform: scale(0.9); transition: all 0.2s; }
  .d2h-code-linenumber:hover::after { opacity: 1; transform: scale(1); }
  
  .inline-comment-row td, .manual-comment-row td { padding: 0 !important; background: transparent !important; border-bottom: 1px solid var(--border) !important; position: relative; }
  .review-comment { margin: 12px 24px 16px 64px; background: var(--primary-white); border: 1px solid var(--border); border-radius: var(--radius); position: relative; box-shadow: var(--shadow-sm); overflow: hidden; min-width: 200px; max-width: 900px; }
  
  .review-comment-header { padding: 8px 16px; background: rgba(250,250,250,0.3); border-bottom: 1px solid var(--border); color: var(--fg-muted); display: flex; align-items: center; justify-content: space-between; }
  .review-comment-body { padding: 12px 16px; overflow-wrap: break-word; word-break: break-word; }
  .review-comment-actions { padding: 8px 16px; background: transparent; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }

  .markdown-body { font-size: 13px; line-height: 1.6; color: var(--fg-default); overflow-wrap: break-word; word-break: break-word; }
  .markdown-body p { margin-top: 0; margin-bottom: 12px; }
  .markdown-body p:last-child { margin-bottom: 0; }
  .markdown-body code { font-family: var(--mono); padding: 0.2em 0.4em; border-radius: 4px; font-size: 85%; border: 1px solid var(--border); background: rgba(0,0,0,0.03); }
  .markdown-body pre { background: transparent; border: 1px solid var(--border); padding: 12px; border-radius: 6px; overflow: auto; margin-bottom: 10px; }
  .markdown-body pre code { background: none; padding: 0; border: none; }
  .markdown-body ul, .markdown-body ol { margin-top: 0; margin-bottom: 10px; padding-left: 2em; }

  /* File collapse toggle */
  .file-collapse-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--primary-white); cursor: pointer; flex-shrink: 0; transition: background 0.15s, border-color 0.15s; }
  .file-collapse-btn:hover { background: var(--border); border-color: #ccc; }
  .file-collapse-btn .collapse-icon { transition: transform 0.2s ease, opacity 0.2s ease; }

  /* Comment count badge on file header */
  .file-comment-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; cursor: default; margin-left: auto; flex-shrink: 0; }

  /* Drawers */
  .side-drawer { position: fixed; top: 0; right: -100vw; width: 600px; height: 100vh; background: var(--bg); box-shadow: -4px 0 24px rgba(0,0,0,0.1); z-index: 1000; transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; border-left: 1px solid var(--border); }
  .side-drawer.is-open { right: 0; }
  .side-drawer-header { padding: 16px 24px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: rgba(250,250,250,0.5); }
  .side-drawer-body { overflow-y: auto; flex: 1; }
  .drawer-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.3); z-index: 999; opacity: 0; visibility: hidden; transition: opacity 0.3s; }
  .drawer-backdrop.is-open { opacity: 1; visibility: visible; }
</style>`;

function escape(s: string): string {
  return (s ?? '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
