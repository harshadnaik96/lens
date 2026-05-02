# Capability Progression

Log of what `Lens` can do, in build order. Newest at top.

## 2026-05-02 — Phase 9: Multi-lens elite review harness
- **Multi-lens sweep prompt** (`src/prompt.ts`): replaces the generic "review this diff" prompt with a structured 5-lens system. The model sweeps the diff through Correctness → Security → Data Integrity & Concurrency → API & Contracts → Maintainability, each with specific "Find" and "IGNORE" instructions. All in a single LLM call — zero cost increase.
- **Lens relevance detector** (`src/lens_detect.ts`): heuristic scanner that examines the diff text and extracted symbol context to determine which lenses are relevant. Inactive lenses are stripped from the prompt to reduce token usage. Pattern banks for security (auth, crypto, SQL, etc.), data integrity (transactions, mutexes, migrations), API contracts (exports, routes, controllers), and maintainability (change volume threshold).
- **Category-tagged comments**: `CommentSchema` in `types.ts` gained a `category` field (`correctness | security | data_integrity | api_contracts | maintainability`). Every comment is tagged with the lens that produced it. Persisted in `comment_draft` table (`category TEXT` column) for eval analysis.
- **Enriched skill packs**: all 5 skill packs (`general.md`, `ts.md`, `js.md`, `go.md`, `java.md`) expanded from ~8-12 bullet points to ~20-30, organized by `## [lens]` sections. Pulls in the rich checklists from PLAN.md §8.7 that were never previously wired in.
- **Lens-aware skill loader** (`src/skills.ts`): `loadSkills` accepts optional `LensRelevance` and strips `## [lens]` sections whose lens is inactive, keeping prompt lean.
- **Upgraded critic** (`src/critic.ts`): category-aware deduplication (cross-lens dedup with priority order: security > correctness > data_integrity > api_contracts > maintainability), maintainability severity capping (suggestion/info only), 15-comment budget enforcement with priority-preserving trimming, confidence threshold raised to 0.5.
- **UI category badges**: diff viewer shows a category label alongside each comment's severity badge. New `.Label--category` CSS.
- **Eval export**: `Lens export-eval` output now includes `category` field per comment for measuring which lens produces the highest acceptance rate.

## 2026-05-02 — Phase 8: Gemini provider + provider documentation
- **`GeminiProvider`** (`src/providers/gemini.ts`): shells out to `gemini -p <prompt> [--model <id>]`. Parses JSON from fenced or raw output. Supports `--model` injection for per-stage model selection.
- **Provider name union extended**: `'claude' | 'gemini'` in `Provider` interface, config schema, and `getProvider` switch.
- **Config**: added `provider.geminiBin` (default `'gemini'`) and `gemini` as a valid `provider.default` value.
- **`buildPrompt`** provider type widened to include `'gemini'`; Gemini uses plain-markdown framing (no `<task>` XML).
- **DOCS.md §5c** — new "Providers in detail" section covering install, auth, call interface, model IDs, and example config for each of Claude, Gemini.

## 2026-05-02 — Phase 7: discovery-mode multi-repo (no more single-repo config)
- **`PRRef = { forge, owner, repo, number }`** — the canonical PR identity. Stored in DB as composite string `gh:owner:repo:number` / `bb:ws:repo:number`. Same string is the URL path and the CLI arg.
- **Forge methods are now stateless about repo**: `getDiff(ref)`, `postInlineComment(ref, …)`. Forge constructors hold creds + scope only.
- **GitHub discovery via `/search/issues`** — scopes: `reviewer` (PRs requesting your review), `author`, `org:NAME`, `user:NAME`, `repo:owner/name`. One API call covers every repo you can see.
- **Bitbucket discovery via `/pullrequests/{username}`** — scopes: `author`, `repo:ws/name`. (`reviewer` not supported — no per-user endpoint in Bitbucket Cloud.)
- **`pr` table grew columns**: `forge`, `number`, `url` (defensive `ALTER TABLE` so existing dbs upgrade in place). PR id is now the composite string; legacy numeric ids no longer round-trip.
- **UI**: index page groups PRs by `workspace/repo` with a "↗" link to the forge web UI; PR header shows `owner/repo #N`.

## 2026-05-02 — Phase 6: per-stage model selection + `--effort` presets
- **`Provider.review(input, opts?)`** gained an optional `{ model }` arg. `ClaudeProvider` injects `--model X` into its `claude -p` invocation when set; if absent, falls back to whatever the `claude` CLI is configured to use.
- **Per-stage models in config**: `provider.models { triage?, review?, critic? }` (all optional). Lets you pin a cheap model for triage while keeping a stronger one for the actual review.
- **`--effort low|medium|high`** flag on `Lens analyze` overrides config with presets:
  - `low`: haiku across all 3 stages
  - `medium`: haiku triage, sonnet review+critic (sensible default)
  - `high`: sonnet triage, opus review+critic
- Resolution order: `--effort` → `config.provider.models` → unset (CLI default).
- Plumbed through `triage()` and `critique()` so each call sites picks its own model.

## 2026-05-02 — Phase 5: GitHub support via Forge abstraction
- **`Forge` interface** (`src/forge/types.ts`) with `listOpenPRs / getDiff / postInlineComment`. `BitbucketForge` (moved from `src/bitbucket.ts`) and `GitHubForge` both implement it; `getForge(cfg)` dispatches on `config.forge`.
- **GitHub client**: `GET /repos/{owner}/{repo}/pulls` for listing, `GET /pulls/{n}` with `Accept: application/vnd.github.v3.diff` for the diff (and caches `head.sha` from the JSON variant), `POST /pulls/{n}/comments` with `{commit_id, path, line, side: LEFT|RIGHT}` for inline comments.
- **Token resolution**: `cfg.github.token` → `$GITHUB_TOKEN`/`$GH_TOKEN` → `gh auth token` (shells out to the GitHub CLI). Fails loud with a fix-it message if none work.
- Config schema gained `forge: 'bitbucket' | 'github'` and a `github { scope, token?, baseUrl }` section. `loadConfig` validates that the matching credential block exists. (Phase 7 later dropped `owner`/`repo` in favour of `scope`.)
- Call sites (`commands/pr.ts`, `commands/serve.ts`) refactored to depend on `Forge` only — Bitbucket was the first instance, GitHub is the second; future forges (GitLab, etc.) drop in the same way.

## 2026-05-02 — Phase 4: eval log export
- New CLI: `Lens export-eval [-o file] [--pr <id>]`. Dumps one JSONL row per `comment_draft` joined with `analysis` and `pr`.
- Each row carries `ai_body`, `final_body`, `action`, and a derived `label` (`accepted|edited|rejected|human_added`) — the supervision signal you need to later fine-tune the reviewer or grade providers.
- Counts (`accepted=N edited=N rejected=N human_added=N`) printed to stderr so the dump on stdout stays clean.

## 2026-05-02 — Phase 3: per-file symbol/import context
- **Lightweight context extractor** (`src/context.ts`): regex-based per-language extraction of imports + top-level symbols (functions, classes, types, exports). Supports ts/tsx, js, go, java, py, rb, rs, kt. Reads the post-change content reconstructed from the diff body — no extra HTTP fetch.
- Only deep-triaged files contribute context (shallow files are scanned-only; skipped files are excluded).
- Context block injected into the reviewer prompt under `## File context` so the model knows what each file imports and exposes when judging diff hunks in isolation.
- Designed as a swap-in surface — can be upgraded to tree-sitter later without changing the prompt or call sites.

## 2026-05-01 — Phase 2: triage pre-pass
- **Per-file diff splitter** (`src/diff_split.ts`): parses unified diff into `{path, added, removed, isBinary, isRename, isDelete, body}` per file.
- **Heuristic triage** (`src/triage.ts`): instant `skip` for lockfiles, binaries, generated/vendored paths, minified assets; `shallow` for tiny changes / docs / pure deletions; `deep` for very large changes. No model call needed for these.
- **Model triage** for everything else: one cheap provider call ranks remaining files into `skip|shallow|deep` with a short reason. Failure-tolerant — falls back to `deep` if model output is malformed.
- **Selective deep review**: only `shallow`+`deep` files' diffs are sent to the main reviewer. The reviewer prompt is told which files were deep vs shallow vs skipped, so it focuses comments accordingly.
- New table `triage_decision` persisted per analysis (`file, decision, reason, source, added, removed`).
- CLI: `--no-triage` flag to disable. Counts logged: `→ deep:N  shallow:N  skip:N`.
- UI: triage table collapsed in side panel (color-coded: deep=red, shallow=blue, skip=struck-through).

## 2026-05-01 — Phase 1: 2-pass review + diff viewer
- **Plan-then-review 2-pass**: provider first emits a candidate review, then a self-critique pass filters/calibrates comments before they hit the DB. Reduces noise and miscalibrated severity.
- **Inline diff viewer**: PR page renders the unified diff with `diff2html` (CDN). Draft comments anchor to file+line and show in a side panel.
- **Per-comment severity edit**: reviewer can change severity in-place before submit.
- **Re-analyze (non-destructive)**: `Lens analyze <id> --re` keeps human-edited/added comments, regenerates only AI-original ones whose `action='kept'`.

## 2026-05-01 — Phase 0: scaffold
- TS + commander CLI (`Lens init|list|analyze|serve|usage`).
- Config at `~/.Lens/config.json` (zod-validated), sqlite at `~/.Lens/Lens.db`.
- Schema: `pr`, `analysis`, `comment_draft`, `state_event`, `usage_log`.
- Bitbucket Cloud client: list open PRs, fetch diff, post inline comment (app-password basic auth).
- Provider adapter: `Provider` interface + `ClaudeProvider` (`claude -p --output-format json`). Both extract JSON from fenced or raw output and validate via zod.
- Prompt builder with severity rubric and per-provider steering (Claude gets `<task>` framing).
- Skill packs: `skills/{general,js,ts,go,java}.md`, auto-selected by changed-file extensions; repo can extend via `.Lens/skills.md`.
- Local UI on `http://localhost:7777`: PR list, per-PR draft cards, edit/discard, batched submit with `[Reviewed by <Senior> via Lens]` footer.
- State machine wired: NEW → ANALYZING → DRAFT_READY → SUBMITTED, transitions logged.
- Usage tracking: every provider call writes to `usage_log`; `Lens usage` shows PRs/24h, PRs/7d, errors, avg latency.
