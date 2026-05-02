# `Lens` v0 build plan

A local CLI + thin browser UI that uses your existing agentic CLI (Codex / Claude Code / Gemini) to review Bitbucket/GitHub PRs and post draft comments for human approval.

## 1. Architecture (one binary, three surfaces)

```
┌─────────────────────────────────────────────────────────┐
│                    Lens (single binary)                  │
├─────────────────────────────────────────────────────────┤
│  CLI surface          HTTP surface         Embedded UI  │
│  (analyze/review/    (localhost:7777)     (index.html)  │
│   submit/list)             ↑                    ↑       │
└──────┬──────────────────────┴──────────┬──────────┴─────┘
       │                                 │
       ▼                                 ▼
┌──────────────┐              ┌──────────────────────┐
│  Core engine │              │  Provider adapters   │
│  - PR fetch  │ ◄──────────► │  - codex             │
│  - Context   │              │  - claude            │
│  - Skills    │              │  - gemini            │
│  - Eval log  │              │                      │
└──────┬───────┘              └──────────┬───────────┘
       │                                 │
       ▼                                 ▼
┌──────────────┐              ┌──────────────────────┐
│  SQLite      │              │  Subprocess + JSON   │
│  drafts.db   │              │  (each CLI's -p mode)│
└──────────────┘              └──────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│  Bitbucket / GitHub REST clients     │
│  (draft/pending review comments)     │
└──────────────────────────────────────┘
```

**Tech pick:** Node (TypeScript) for v0 — easier to embed HTML, native JSON, fastest iteration. Rewrite to Go later if single-binary distribution matters.

## 2. The provider adapter contract (the important part)

Every CLI agent (Codex, Claude Code, Gemini) is wrapped in the same interface. This is the only abstraction that matters in v0.

```ts
interface Provider {
  name: 'codex' | 'claude' | 'gemini';
  isAvailable(): Promise<boolean>;        // detect binary on PATH
  review(input: ReviewInput): Promise<ReviewOutput>;
}

interface ReviewInput {
  diff: string;                  // unified diff
  changedFiles: FileContext[];   // path + full content for small files
  prTitle: string;
  prDescription: string;
  skills: string;                // contents of .Lens/skills.md from repo
  prompt: string;                // our curated review prompt
}

interface ReviewOutput {
  summary: string;
  comments: Array<{
    file: string;
    line: number;
    side: 'old' | 'new';
    severity: 'info' | 'suggestion' | 'concern' | 'blocker';
    body: string;
    confidence: number;          // 0-1, used to filter low-conf
  }>;
  rawResponse: string;           // store for eval/debugging
}
```

### How each provider hooks in

All four CLIs support non-interactive "print" mode and accept a prompt + stdin/file. The adapter is mostly: build a prompt, shell out, parse JSON.

**Claude Code adapter**
```bash
claude -p "<prompt>" --output-format json
```
- `--output-format json` gives structured wrapper around the assistant message
- Prompt instructs the model to return our schema as a JSON code block; parse that out

**Codex CLI adapter (OpenAI)**
```bash
codex exec "<prompt>" --json
```
- Non-interactive exec; output to stdout as JSON events
- Parse final assistant message, extract JSON block

**Gemini CLI adapter**
```bash
gemini -p "<prompt>" --output-format json
```
- Non-interactive prompt mode; same JSON-block-extraction pattern

**Common parsing helper:** every adapter ends with the same `extractJsonBlock(rawText, schema)` that finds ```json ... ``` in the response, validates against zod schema, retries once with a "your previous response was invalid JSON, fix it" prompt.

**Detection / config:** `Lens config provider claude` sets default. `Lens review --provider gemini` overrides per-call. Auto-detect on first run by probing `which claude / codex / gemini` and picking the first available.

## 3. Repo layout

```
Lens/
├── package.json
├── bin/Lens                          # CLI entrypoint
├── src/
│   ├── cli/
│   │   ├── analyze.ts               # `Lens analyze <url>`
│   │   ├── review.ts                # `Lens review <url>` → opens browser
│   │   ├── submit.ts                # `Lens submit <url>`
│   │   ├── list.ts                  # `Lens list`
│   │   └── config.ts                # `Lens config provider <name>`
│   ├── core/
│   │   ├── pr-fetcher.ts            # Bitbucket/GitHub diff fetch
│   │   ├── context-builder.ts       # diff + changed files + skills
│   │   ├── skills-loader.ts         # reads .Lens/skills.md from repo
│   │   ├── prompt.ts                # the curated review prompt template
│   │   ├── store.ts                 # sqlite (better-sqlite3)
│   │   └── eval-log.ts              # log ai_original vs final
│   ├── providers/
│   │   ├── index.ts                 # registry + auto-detect
│   │   ├── base.ts                  # Provider interface, JSON extraction
│   │   ├── claude.ts
│   │   ├── codex.ts
│   │   ├── gemini.ts
│   ├── server/
│   │   ├── http.ts                  # localhost:7777 server
│   │   ├── routes.ts                # GET /api/draft/:id, PATCH /api/comment/:id, POST /api/submit/:id
│   │   └── static/
│   │       ├── index.html           # the one HTML file
│   │       └── (CDN imports for diff2html, alpine.js)
│   └── platforms/
│       ├── bitbucket.ts             # fetch PR, post draft comments, publish review
│       └── github.ts                # same, GitHub flavor (v0.1 if time)
├── prompts/
│   ├── system.md                    # base reviewer prompt
│   └── output-schema.md             # JSON schema instructions
└── README.md
```

## 4. Build phases

### Phase 0 — skeleton (half day)
- Node/TS project scaffold, `bin/Lens` entrypoint with commander
- `Lens --version`, `Lens config provider <name>`
- SQLite schema: `prs`, `drafts`, `comments`, `eval_log`
- Dummy Bitbucket fetch (hardcoded PR for testing)

### Phase 1 — one provider end-to-end (1 day)
- Implement `claude.ts` adapter (or whichever you trust most)
- Build the review prompt + output schema
- `Lens analyze <bitbucket-url>` → fetch diff → call claude → store draft → print "draft ready: Lens review <url>"
- No UI yet — just verify the JSON output is good

### Phase 2 — local server + diff UI (1 day)
- HTTP server, embed `index.html`
- `Lens review <url>` opens browser
- Render diff with diff2html, overlay comments at correct lines
- Edit/delete/add comment via PATCH endpoint
- "Submit" button calls submit endpoint

### Phase 3 — Bitbucket draft posting (half day)
- `Lens submit <url>` reads approved comments, POSTs as pending review comments, publishes review
- Eval log writes ai_original_body + final_submitted_body for each

### Phase 4 — second provider + polish (1 day)
- Add Codex or Gemini adapter to prove the abstraction holds
- `--provider` flag
- `Lens list` shows all drafts in sqlite
- README

**Total: ~4 days of focused work, comfortably a long weekend + an evening.**

## 5. Decisions to make before Saturday

1. **Language**: Node/TS or Go? (Recommend Node/TS for v0)
2. **Primary provider for Phase 1**: Claude Code, Codex, or Gemini? Pick whichever you trust most today.
3. **Bitbucket Cloud or Data Center?** Different APIs. (Mintoak likely DC — confirm.)
4. **Skills file location**: `.Lens/skills.md` in repo, or `~/.Lens/skills/<repo-name>.md` locally? In-repo is better long-term; local is faster for solo v0.
5. **Auth**: Bitbucket app password in `~/.Lens/config.json` or env var? Env var is simpler, config file is friendlier.

## 6. What's explicitly NOT in v0

- No PR list view in browser (only CLI `Lens list`)
- No webhooks (manual `Lens analyze <url>`)
- No skills editor UI (edit the `.md` file)
- No multi-user, no auth, no SSO
- No Jira integration
- No re-analyze with hint
- No streaming progress in UI (terminal shows it)
- No suggested-changes / patch comments (text comments only)

## 8. Harness & model steering (the value layer — R&D)

The CLI/UI/Bitbucket plumbing is commodity. The harness and skill packs are where the value lives. The developer never sees this — they install `Lens`, point at a PR, and get useful output. Behind that:

### 8.1 Pipeline stages

```
1. Triage          → which files matter, in what order, what to skip
2. Context build   → diff + smart file context + skill packs + repo skills
3. Plan-then-review → 2-pass: candidate comments → self-critique → final
4. Validate+repair → JSON schema check, one retry if malformed
5. Filter          → drop low-confidence, dedupe, cap count
6. Calibrate       → re-score severity against repo norms
```

### 8.2 Triage (cheap call, big payoff)

Before any deep review, fast call asking the model to rank files 1-5 by review risk and SKIP lockfiles, generated code, snapshots, vendored deps, pure formatting. Then deep-review only the top-N risk files (default 10). This keeps big PRs from blowing the context window or producing a wall of noise.

### 8.3 Context build

For each file we'll review:
- The hunk itself
- Full file content if <500 lines, else hunk + symbol map (functions/classes via tree-sitter)
- 1-hop importers (who calls this) and importees (what this calls), tree-sitter not embeddings for v0
- Repo's `.Lens/skills.md` if present
- Matching language skill pack (see 8.7)

Cap total context at ~80% of model window to leave room for output.

### 8.4 Plan-then-review (the single biggest quality lever)

Instead of "review this diff," two prompts:

**Pass A — candidate generation:**
> "List every issue you might raise. Be liberal. For each: file, line, what's wrong, why it matters, your confidence (0-1)."

**Pass B — self-critique:**
> "Here are your candidate comments. Re-read each. For each, answer: (a) Is this actually true given the surrounding code? (b) Is this worth a senior's attention or noise? (c) Would removing this comment cause a bug to ship? Keep only comments where (a)=yes AND ((b)=yes OR (c)=yes)."

Two-pass review is the single technique that most reduces noise. Difference between an agent that comments on everything and one a senior actually trusts.

### 8.5 Validate, filter, calibrate

- **Validate**: every output checked against Zod/JSON schema. On failure, one retry with original output appended and "fix the JSON." Two failures → log, return summary-only, don't crash.
- **Filter**: drop confidence < 0.6 (configurable), dedupe by `(file, line, normalized_body)`, cap at 15 comments per PR (highest severity wins), drop comments on lines not actually in the diff (model hallucinated location).
- **Calibrate severity**: force the rubric — `blocker` (ships a bug, breaks invariant, security), `concern` (probably wrong, needs author response), `suggestion` (improvement, declinable), `info` (FYI). Rule: ≤2 blockers per PR unless genuinely catastrophic. If model returns 5 blockers, force re-rank.

### 8.6 Per-provider steering (transparent to user)

Same harness, slight prompt-shape differences per backend:

| Provider | Steering tweak |
|---|---|
| Claude | XML tags (`<diff>`, `<file_context>`, `<skills>`). Trained on this format, follows structure better. |
| Codex (GPT) | JSON schema in request when CLI supports it; fallback to "Output exactly this JSON shape" with example. |
| Gemini | Explicit "Respond with ONLY a JSON code block, no preamble." Gemini is chattier by default. |

~30 lines of provider-specific prompt formatting per adapter. Same pipeline, same schema.

### 8.7 Out-of-the-box skill packs

Ship in the binary as markdown under `prompts/skills/`. Harness picks the right one(s) based on file extensions in the diff and appends to the system prompt. Repo's own `.Lens/skills.md` *adds to* (doesn't replace) the language pack. Framework auto-detection: scan sentinel files (`package.json` deps for React, `pom.xml` for Spring) and load matching sub-section. Cached per repo.

```ts
function pickSkillPacks(changedFiles: string[]): string[] {
  const exts = new Set(changedFiles.map(f => path.extname(f)));
  const packs: string[] = ['general.md'];
  if (exts.has('.ts') || exts.has('.tsx')) packs.push('ts.md', 'js.md');
  else if (exts.has('.js') || exts.has('.jsx')) packs.push('js.md');
  if (exts.has('.go')) packs.push('go.md');
  if (exts.has('.java')) packs.push('java.md');
  return packs;
}
```

#### `general.md` (always loaded)

- **Comment quality bar**: only post a comment if a senior's first reaction would be "good catch," not "yeah I know."
- **Don't comment on**: missing tests (unless PR claims to add them), commit messages, PR description quality, formatting, anything a linter/formatter handles.
- **Security defaults**: SQL string concatenation, unvalidated user input flowing to file/shell/network, secrets in code, weak crypto, missing auth checks on new endpoints.
- **Migration safety**: schema changes that aren't backward compatible with running old code (add column nullable → backfill → flip required is the safe sequence).
- **Public API changes**: breaking changes to exported functions/types in shared modules without an obvious version bump.

#### `js.md` / `ts.md`

- **Async footguns**: missing `await` on returned promise, `await` inside `.forEach` (use `for...of` or `Promise.all`), unhandled rejections in non-async event handlers.
- **Promise.all vs sequential**: independent awaits in a loop should be parallelized.
- **React hooks**: missing/incorrect dependency arrays, conditional hook calls, stale closures over state, missing `key` on list items, derived state in `useState`.
- **State mutation**: directly mutating props, state, or function arguments instead of returning new values.
- **Equality bugs**: `==` instead of `===`, `NaN === NaN`, comparing objects by reference when value comparison was intended.
- **Date/timezone**: `new Date(string)` without explicit timezone, server/client timezone mismatch.
- **TS-only**: `any` escape hatches that hide real type errors, `as` assertions that bypass narrowing, non-null assertions (`!`) on values that can actually be null, unnecessarily widened return types.
- **TS-only**: prefer union types over enums unless interop needed; prefer `unknown` over `any`.
- **Bundle**: deep imports that affect tree-shaking, default-importing huge libs (`import _ from 'lodash'`).
- **Don't comment on**: prettier/eslint-fixable issues, naming style, missing JSDoc, line length.

#### `go.md`

- **Goroutine lifecycle**: starting a goroutine without a clear path to termination (no `context`, no done channel, no `sync.WaitGroup`).
- **Error handling**: returning raw `err` when `fmt.Errorf("...: %w", err)` would preserve context; ignoring errors with `_`; checking error after using the value.
- **Defer in loops**: resource leaks from `defer` inside `for` — should be in helper function or explicit close.
- **Mutex copy**: struct with `sync.Mutex` field used as value receiver or copied — silent bug.
- **Nil safety**: writing to nil map, nil pointer derefs after type assertion without `, ok`, returning nil interface that compares non-nil (typed nil bug).
- **Context propagation**: function takes context but doesn't pass it to downstream calls (DB, HTTP, RPC).
- **Channel direction**: signatures should use `<-chan` / `chan<-` to constrain usage.
- **Slice aliasing**: returning a slice that aliases internal state; `append` reusing underlying array unexpectedly.
- **Don't comment on**: `gofmt`-fixable issues, package naming, godoc comment formatting.

#### `java.md`

- **Equals/hashCode contract**: overriding one without the other; mutable fields in `hashCode`.
- **Resource handling**: `try-with-resources` missed on `Closeable` (streams, connections, statements).
- **Mutability leaks**: returning internal `List`/`Map`/`Date` directly from getters; constructor stores mutable collection without defensive copy.
- **Optional misuse**: `Optional` as field type (intended for return types), `.get()` without `.isPresent()` or `.orElse()`.
- **Stream side effects**: side effects inside `map`/`filter`/`forEach`; `peek` for non-debug.
- **Concurrent collections**: `HashMap` where `ConcurrentHashMap` is needed; modifying collection during iteration.
- **Spring (when detected)**: `@Transactional` on private or self-invoked methods (won't proxy); lazy entity access outside session; field `@Autowired` instead of constructor injection; missing `@Transactional(readOnly=true)` on read-only methods.
- **Null contracts**: returning `null` for collections (should return empty); missing `@Nullable`/`@NonNull` on public APIs in projects using them.
- **Exception handling**: catching `Exception`/`Throwable` broadly; silently swallowing.
- **Don't comment on**: import order, brace style, JavaDoc presence (unless on library public API).

### 8.8 Token / rate-limit handling

- Estimate tokens before each call; if oversized, drop excess files into triage-only mode.
- On rate-limit error: exponential backoff with jitter, max 3 retries, then surface "your provider rate-limited; try again or switch with `--provider`."
- Per-provider concurrency limit (1 for free Gemini, 3 for Claude Code, etc.) — config'd, not hardcoded.

### 8.9 R&D status

This whole section is the part that needs experimentation. Ship v0 with the simplest version (single-pass, basic skill packs, no triage) and add stages 1, 4, 5, 6 as you measure where the noise comes from. The eval log from Phase 3 is what tells you which stage is paying off.

## 9. Resource footprint, background mode, usage display

### 9.1 Resource consumption

**At rest: zero.** CLI doesn't run unless invoked. No daemon, no background process. SQLite file sits on disk (~MBs).

**During `Lens analyze`** (typical 200-line PR):
- ~50-100MB RAM in our process (Node + better-sqlite3 + tree-sitter + HTTP overhead)
- Underlying CLI (`claude` / `codex` / `gemini`) is the heavy hitter — 200-500MB while running, 30-90 seconds per PR
- Network: fetch diff from Bitbucket (~KBs), then the underlying CLI streams its API calls
- Disk: optional shallow clone of repo for context (~50-300MB, deleted after or cached in `~/.Lens/cache/`)

**During `Lens review` (HTTP server):**
- ~30MB idle, server runs only while browser tab is open
- One `Lens review` invocation = one tab = one PR. Closes on `Ctrl+C` or Submit.

Bottom line: indistinguishable from running `git` and `claude` back-to-back.

### 9.2 Background service: explicitly not in v0

Tempting because pre-analyzing PRs would mean instant drafts. Costs are real:
- Burns subscription quota on PRs you weren't going to review
- Daemon management (launchd / systemd / Windows service) is real ops we don't want to own
- Webhooks need a public endpoint or polling — first breaks "local-only," second is wasteful
- Solo user doesn't have queue depth that justifies pre-fetching

**Middle ground for v0.5**: `Lens watch` — long-running foreground command that polls Bitbucket every N minutes for PRs assigned to you and notifies (terminal bell + macOS notification) on new ones. Not a daemon, just a CLI that doesn't exit. Zero ops burden, opt-in, visible.

`Lens watch --auto-analyze` is a separate flag, defaults off. Turning it on is an explicit "yes, spend my quota proactively."

### 9.3 Usage display

`Lens usage` reads from sqlite eval log, prints:

```
Provider   PRs (24h)   PRs (7d)   ~tokens (24h)   Last error
─────────────────────────────────────────────────────────────
claude     8           42         186K            -
gemini     3           11         62K             rate-limit 2h ago
codex      0           0          0               -
```

Plus a heuristic banner in `Lens analyze` output when nearing observed rate-limit thresholds: *"You've run 12 analyses on Gemini in the last hour; free tier may rate-limit soon."*

**What we don't show**: predicted "PRs remaining today." Providers don't expose quota reliably; faking precision is worse than no number. Show the data, let the user judge.

### 9.4 v0 additions (~half day total)

- `Lens usage` command
- Token estimation logged per call in `eval_log` (use CLI-reported counts when available, estimate otherwise)

Defer to v0.5+: `Lens watch`, auto-analyze, true background mode, quota prediction.

## 7. Hard rules to keep scope honest

- The HTML page only loads when you run `Lens review <url>`, and only ever shows that one PR. No navigation, no list views, no multi-PR state in the browser.
- Single `index.html`, ~300 lines including styles, CDN imports only, no build step.
- Every provider goes through the same `Provider` interface. No special-casing in core code.
- Eval log writes happen on every submit — no "we'll add it later." That dataset is the whole point of v0.
- Two-week usage trial before considering any v0.1 feature. If you stop using it after a week, the answer isn't "build more," it's "the premise was wrong."
