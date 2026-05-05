import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../db.js';
import type { Config } from '../config.js';
import { getForge } from '../forge/index.js';
import { idToRef } from '../forge/types.js';
import { analyzePR, listPRs } from './pr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = path.resolve(__dirname, '../../DOCS.md');

interface AnalysisState {
  logs: string[];
  triage: any[];
}
const activeAnalyses = new Map<string, AnalysisState>();
const sseClients = new Map<string, Set<http.ServerResponse>>();

function broadcast(prId: string, event: string, data: any) {
  const clients = sseClients.get(prId);
  if (clients) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }
}

export async function serve(cfg: Config, port: number) {
  const db = getDb();
  const bb = getForge(cfg);
  const diffCache = new Map<string, string>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderIndex(db));
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
        res.write(`event: init\ndata: ${JSON.stringify({ analyzing: !!state, logs: state?.logs || [], triage: state?.triage || [] })}\n\n`);

        req.on('close', () => {
          const clients = sseClients.get(prId);
          if (clients) {
            clients.delete(res);
            if (clients.size === 0) sseClients.delete(prId);
          }
        });
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
        const footer = cfg.reviewer.botFooter.replace('{name}', cfg.reviewer.name);
        let posted = 0;
        const errors: string[] = [];
        for (const d of drafts) {
          const body = `${d.current_body}\n\n_${footer}_`;
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

      const analyzeMatch = pathname.match(/^\/api\/pr\/([\w:.\-]+)\/analyze$/);
      if (analyzeMatch && req.method === 'POST') {
        const prId = analyzeMatch[1];
        if (activeAnalyses.has(prId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Already analyzing' }));
          return;
        }

        activeAnalyses.set(prId, { logs: [], triage: [] });
        broadcast(prId, 'status', { analyzing: true });

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'started' }));

        analyzePR(cfg, prId, {
          reAnalyze: true,
          onLog: (msg) => {
            const state = activeAnalyses.get(prId);
            if (state) state.logs.push(msg);
            broadcast(prId, 'log', msg);
          },
          onTriage: (items) => {
            const state = activeAnalyses.get(prId);
            if (state) state.triage = items;
            broadcast(prId, 'triage', items);
          }
        }).then(() => {
          activeAnalyses.delete(prId);
          broadcast(prId, 'done', { ok: true });
        }).catch((e: any) => {
          activeAnalyses.delete(prId);
          broadcast(prId, 'done', { ok: false, error: e.message });
        });
        return;
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err.message ?? err));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Lens UI: http://localhost:${port}`);
  });
}

const LOGO_SVG = `<svg width="80" height="32" viewBox="0 0 100 40" xmlns="http://www.w3.org/2000/svg">
  <text x="0" y="28" fill="#0969da" style="font: bold 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; letter-spacing: -0.5px;">Lens</text>
</svg>`;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function renderIndex(db: ReturnType<typeof getDb>): string {
  const rows = db
    .prepare(`SELECT id, workspace, repo, number, title, author, state, source_branch, dest_branch, url
              FROM pr ORDER BY workspace, repo, updated_at DESC`)
    .all() as Array<any>;
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = `${r.workspace}/${r.repo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const sections = [...groups.entries()].map(([repo, list]) => {
    const items = list.map((r) => `<tr data-search="${escape((r.title ?? '') + ' ' + (r.author ?? '') + ' ' + (r.source_branch ?? '') + ' ' + (r.dest_branch ?? '') + ' ' + (r.number ?? r.id)).toLowerCase()}">
      <td style="width: 80px; font-family: var(--mono); color: var(--fg-muted); font-size: 12px;">#${r.number ?? r.id}</td>
      <td><a href="/pr/${r.id}" style="font-weight: 500;">${escape(r.title ?? '')}</a></td>
      <td style="font-size: 13px; color: var(--fg-muted);">${escape(r.author ?? '')}</td>
      <td style="font-size: 13px; color: var(--fg-muted);">${escape(r.source_branch ?? '')} <span style="opacity: 0.3">→</span> ${escape(r.dest_branch ?? '')}</td>
      <td><span class="State State--${r.state}">${formatLabel(r.state)}</span></td>
      <td style="text-align: right;">${r.url ? `<a href="${r.url}" target="_blank" class="btn-link text-small">Open ↗</a>` : ''}</td>
    </tr>`).join('');
    return `<div class="Box mb-4 shadow-sm" data-repo-group="${escape(repo)}">
      <div class="Box-header">
        <h3 class="Box-title" style="font-weight: 500;">${escape(repo)} <span class="Counter ml-2">${list.length}</span></h3>
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

  <main class="container-lg p-responsive mt-4">
    <div class="d-flex flex-justify-between flex-items-center mb-3">
      <h1 class="h2" style="font-weight: 700;">Pull Requests</h1>
      <div class="d-flex flex-items-center" style="gap: 8px;">
        <input id="pr-search" type="search" placeholder="Search PRs…" autocomplete="off"
          style="padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; width: 220px; outline: none; background: var(--canvas); color: var(--fg);"
          oninput="filterPRs(this.value)">
        <button class="btn btn-sm btn-primary" onclick="syncPRs(this)">Sync PRs</button>
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

  <script>
    function filterPRs(query) {
      const q = query.trim().toLowerCase();
      document.querySelectorAll('[data-repo-group]').forEach(group => {
        let visibleRows = 0;
        group.querySelectorAll('tr[data-search]').forEach(row => {
          const match = !q || row.dataset.search.includes(q);
          row.style.display = match ? '' : 'none';
          if (match) visibleRows++;
        });
        group.style.display = visibleRows === 0 ? 'none' : '';
      });
    }

    function uiAlert(message, title = 'Notification') {
      return new Promise((resolve) => {
        const backdrop = document.getElementById('custom-modal-backdrop');
        const titleEl = document.getElementById('modal-title');
        const bodyEl = document.getElementById('modal-body');
        const okBtn = document.getElementById('modal-ok');
        const cancelBtn = document.getElementById('modal-cancel');

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
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Syncing...';
      try {
        const r = await fetch('/api/prs/sync', { method: 'POST' });
        const j = await r.json();
        if (j.ok) {
          location.reload();
        } else {
          await uiAlert('Sync failed: ' + j.error, 'Error');
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch (err) {
        await uiAlert('Network error: ' + err.message, 'Error');
        btn.disabled = false;
        btn.textContent = originalText;
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
      <button class="btn-link text-small" onclick="closeDrawer()" style="color:var(--fg-muted); text-decoration:none;">Close</button>
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
        <span class="State State--${pr.state}">${formatLabel(pr.state)}</span>
        <div class="header-pr-title">
          ${escape(pr.title ?? '')}
          <span class="header-pr-number">#${pr.number ?? prId}</span>
        </div>
      </div>
    </div>

    <div class="Header-item" style="gap: 8px;">
      ${pr.url ? `<a href="${pr.url}" target="_blank" class="btn btn-sm">View ↗</a>` : ''}
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
        <div class="Box mb-4" style="background: rgba(250,250,250,0.3);">          <div class="Box-header d-flex flex-items-center gap-2" style="background:transparent; border-bottom:none; padding-bottom:4px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            <h3 class="Box-title" style="font-size:16px;">AI Review Summary</h3>
          </div>
          <div class="Box-body text-small color-fg-muted" id="review-summary" style="white-space: pre-wrap; padding-top:0; padding-bottom:20px; line-height: 1.5;">${escape(analysis?.summary ?? 'No analysis yet.')}</div>
          
          <div class="Box-footer" style="background:transparent; border-top: 1px dashed var(--border); padding: 12px 20px; display:flex; gap:12px; align-items:center;">
            <button class="btn btn-sm btn-outline text-small d-flex flex-items-center gap-2" onclick="openDrawer('logs-drawer')">
              Thinking Logs
            </button>

            <button id="triage-btn" class="btn btn-sm btn-outline text-small d-flex flex-items-center gap-2" onclick="openDrawer('triage-drawer')" style="${triage.length ? '' : 'display:none;'}">
              Triage Analysis (<span id="triage-count">${triage.length}</span> files)
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
      <button class="btn-link text-small" onclick="closeDrawer()" style="color:var(--fg-muted); text-decoration:none;">Close</button>
    </div>
    <div class="side-drawer-body p-0">
      <pre class="terminal-logs" style="margin:0; height:100%; border-radius:0; border:none; max-height:none;">${escape(analysis?.logs ?? '')}</pre>
    </div>
  </div>

  <div class="side-drawer" id="triage-drawer">
    <div class="side-drawer-header">
      <h3 class="h4 m-0">Triage Analysis</h3>
      <button class="btn-link text-small" onclick="closeDrawer()" style="color:var(--fg-muted); text-decoration:none;">Close</button>
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
    const evtSource = new EventSource('/api/pr/' + PRID + '/stream');
    evtSource.addEventListener('init', (e) => {
      const data = JSON.parse(e.data);
      if (data.analyzing) {
        setAnalyzingState(true);
        const logsEl = document.querySelector('.terminal-logs');
        if (logsEl && data.logs.length) {
          logsEl.textContent = data.logs.join('\\n');
          logsEl.scrollTop = logsEl.scrollHeight;
        }
        if (data.triage && data.triage.length) updateTriageUI(data.triage);
      }
    });
    evtSource.addEventListener('status', (e) => {
      const data = JSON.parse(e.data);
      setAnalyzingState(data.analyzing);
    });
    evtSource.addEventListener('log', (e) => {
      const msg = JSON.parse(e.data);
      const logsEl = document.querySelector('.terminal-logs');
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
  .side-drawer { position: fixed; top: 0; right: -600px; width: 600px; height: 100vh; background: var(--bg); box-shadow: -4px 0 24px rgba(0,0,0,0.1); z-index: 1000; transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1); display: flex; flex-direction: column; border-left: 1px solid var(--border); }
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
