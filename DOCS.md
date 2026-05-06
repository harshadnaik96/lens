# 📖 Lens — User Guide

**Lens** is your local-first PR review companion. It bridges the gap between raw AI suggestions and high-quality human reviews — without your code ever leaving your laptop.

---

## 📑 Table of Contents

1. [📥 Installation & Prerequisites](#1-installation--prerequisites)
2. [🚀 Getting Started (step-by-step)](#2-getting-started-step-by-step)
   - [2.1 Install a provider CLI](#21-install-a-provider-cli)
     - [Claude Code](#claude-code)
     - [Gemini CLI](#gemini-cli)
     - [Codex CLI](#codex-cli)
   - [2.2 Generate a forge token](#22-generate-a-forge-token)
     - [GitHub](#github)
     - [Bitbucket Cloud](#bitbucket-cloud)
   - [2.3 Run `lens init`](#23-run-lens-init)
   - [2.4 Edit `~/.lens/config.json`](#24-edit-lensconfigjson)
   - [2.5 Verify setup](#25-verify-setup)
3. [🔄 Daily Workflow](#3-daily-workflow)
4. [⌨️ Commands Reference](#4-commands-reference)
5. [🧠 How a Review Runs](#5-how-a-review-runs)
6. [🧩 Skill Packs](#6-skill-packs)
7. [🛠️ Re-analyze Without Losing Edits](#7-re-analyze-without-losing-your-edits)
8. [📊 Tokens, Cost & The Style Corpus](#8-tokens-cost--the-style-corpus)
9. [💻 Resource Usage](#9-resource-usage)
10. [❓ Troubleshooting](#10-troubleshooting)
11. [🪝 Pre-push Hook](#11-pre-push-hook)
12. [📋 Reviewer Briefing](#12-reviewer-briefing)
13. [🧬 Institutional Memory](#13-institutional-memory)
14. [🔭 Codebase-Aware Review](#14-codebase-aware-review)

---

## 1. Installation & Prerequisites

### Requirements

- **Node.js 20+**
- **At least one provider CLI** authenticated and on your `PATH`:

| Provider    | Binary   | Install                                    | Recommended for        |
| :---------- | :------- | :----------------------------------------- | :--------------------- |
| Claude Code | `claude` | [claude.com/code](https://claude.com/code) | best overall reasoning |
| Gemini CLI  | `gemini` | Google's `gemini` CLI                      | large context, fast    |

### Install Lens

**Easiest path — one command:**

```bash
git clone <this repo>
cd do-more-agent
./bootstrap.sh
```

That installs deps, builds, links the `lens` command globally, and drops you into the interactive setup. Skip ahead to §2.5 if you take this path.

**Step-by-step** (if you want to control each phase):

```bash
git clone <this repo>
cd do-more-agent
npm install
npm run build
npm link            # exposes the `lens` command globally
lens setup          # interactive wizard (§2.3 onwards)
```

> An npm-published install (`npm i -g lens`) is coming. The `git clone` flow is the current path.

---

## 2. Getting Started (step-by-step)

Five steps, ~10 minutes from a fresh laptop to your first review. Do them in order.

### 2.1 Install a provider CLI

Lens does **not** call LLM APIs directly — it shells out to the AI CLI you've already authenticated. Pick **one** to start; you can add more later and switch with `--provider`.

#### Claude Code

The recommended default. Best reasoning for code review.

```bash
# macOS / Linux
curl -fsSL https://claude.com/install.sh | sh

# or via npm
npm i -g @anthropic-ai/claude-code

# authenticate (opens browser)
claude login

# verify
claude --version
```

Docs: <https://docs.claude.com/en/docs/claude-code>

#### Gemini CLI

Google's open-source CLI. Large context window, fast.

```bash
npm i -g @google/gemini-cli

# authenticate
gemini auth        # follow the browser flow

# verify
gemini --version
```

Docs: <https://github.com/google-gemini/gemini-cli>

#### Codex CLI

OpenAI's terminal coding agent (uses your ChatGPT or API account).

```bash
npm i -g @openai/codex

# authenticate
codex login

# verify
codex --version
```

Docs: <https://github.com/openai/codex>

> [!NOTE]
> Codex is wired through the same provider abstraction as Claude/Gemini — `lens setup` will detect it on PATH and offer it as a default. To switch to it any time: set `"provider": { "default": "codex" }` in `~/.lens/config.json`, or pass `lens analyze <id> --provider codex`.

> [!TIP]
> You can verify any provider is wired correctly by running it standalone first (e.g. `claude "say hi"`). If that works in your shell, Lens will be able to spawn it.

---

### 2.2 Generate a forge token

Lens needs read access to PRs (and write access if you want it to post your curated review).

#### GitHub

You have three options — pick one.

**Option A — `gh` CLI (easiest, recommended):**

```bash
brew install gh         # or: https://cli.github.com
gh auth login           # follow prompts: GitHub.com → HTTPS → browser
gh auth status          # confirm "Logged in"
```

Lens auto-detects `gh` credentials. Nothing else to configure.

**Option B — Fine-grained Personal Access Token:**

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. **Token name**: `lens`
3. **Repository access**: All repositories (or pick specific ones).
4. **Permissions** → Repository permissions:
   - **Contents**: Read-only
   - **Pull requests**: Read **and write** (write is needed to post the review)
   - **Metadata**: Read-only (auto-selected)
5. Click **Generate token** and copy it.
6. Either export it: `export GITHUB_TOKEN=ghp_xxx` (add to `~/.zshrc` or `~/.bashrc`)
   …or paste it into `~/.lens/config.json` under `github.token` (see §2.4).

**Option C — Classic PAT** (works but less granular): <https://github.com/settings/tokens> → "Generate new token (classic)" → scopes: `repo`. Same usage as Option B.

#### Bitbucket Cloud

> **Note:** Bitbucket deprecated app passwords in September 2025. Lens now uses **Atlassian API tokens** authenticated with your email address.

**Step 1 — Create an API token**

1. Go to <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Click **Create API token**.
3. Give it a label, e.g. `lens`.
4. Under **Bitbucket scopes**, tick at minimum:
   - **Repositories** → Read _(needed to list repos when using `scope: reviewer`)_
   - **Pull requests** → Read **and** Write _(Write is needed to post review comments)_
5. Click **Create** and copy the token — it starts with `ATATT` and is shown **only once**.

**Step 2 — Find your Atlassian email and Bitbucket username**

- **Email**: the address you log into Atlassian with (e.g. `you@company.com`). Find it at <https://id.atlassian.com/manage-profile>.
- **Username**: your short Bitbucket handle (not your email). Find it at <https://bitbucket.org/account/settings/> under _Username_.
- **Workspace**: the workspace slug shown in your Bitbucket repo URLs, e.g. `bitbucket.org/{workspace}/...`.

**Step 3 — Find your user UUID** _(only needed for `scope: reviewer`)_

Your UUID is the unique identifier Bitbucket uses internally. You can find it by visiting your Bitbucket profile — it appears in the URL as `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}` (with curly braces). Include the braces in your config.

**Step 4 — Add to config**

Put the token, email, username, workspace, and UUID into `~/.lens/config.json` (see §2.4 for the full config example).

> **Tip:** The API token is shown only once. Copy it immediately and store it somewhere safe before closing the dialog.

#### Bitbucket Server / Data Center (self-hosted)

Use a **Personal Access Token** from your profile → **Manage account** → **Personal access tokens** with `PROJECT_READ` and `REPO_WRITE` scopes. Configuration is the same as Bitbucket Cloud but with a `baseUrl` field — see the example in §2.4.

---

### 2.3 Run `lens init`

```bash
lens init
```

This:

- Creates `~/.lens/` (your config + database directory).
- Writes a starter `~/.lens/config.json`.
- Initializes an empty SQLite DB at `~/.lens/lens.db`.

Nothing else happens — no daemons, no network calls.

---

### 2.4 Edit `~/.lens/config.json`

Open the file in your editor:

```bash
$EDITOR ~/.lens/config.json     # or: code ~/.lens/config.json
```

Fill in the relevant section based on §2.1 and §2.2 choices.

**Example — GitHub + Claude:**

```jsonc
{
  "forge": "github",
  "github": {
    "token": "", // empty = use gh CLI / $GITHUB_TOKEN
    "scope": "reviewer", // see scopes table below
  },
  "provider": { "default": "claude" },
  "reviewer": { "name": "Harshad Naik" },
}
```

**Example — Bitbucket Cloud + Gemini:**

```jsonc
{
  "forge": "bitbucket",
  "bitbucket": {
    "username": "harshadnaik", // your Bitbucket short handle
    "email": "you@company.com", // your Atlassian login email
    "apiToken": "ATATT3x...", // token from id.atlassian.com
    "workspace": "myworkspace", // workspace slug from repo URLs
    "userUuid": "{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}", // from your Bitbucket profile URL
    "scope": "reviewer", // "author" | "reviewer" | "repo:ws/name"
  },
  "provider": { "default": "gemini" },
  "reviewer": { "name": "Harshad Naik" },
}
```

**Example — Bitbucket Server + Codex:**

```jsonc
{
  "forge": "bitbucket",
  "bitbucket": {
    "baseUrl": "https://bitbucket.mycorp.com",
    "username": "hnaik",
    "appPassword": "BBDC-xxxxxxxxxxxxx", // Data Center still uses PATs
    "scope": "reviewer",
  },
  "provider": { "default": "codex" },
  "reviewer": { "name": "Harshad Naik" },
}
```

#### Discovery scopes

| Scope                      | Meaning                                                                  |
| :------------------------- | :----------------------------------------------------------------------- |
| `reviewer`                 | PRs that have requested **your** review (across every repo you can see). |
| `author`                   | PRs **you opened**.                                                      |
| `org:NAME` (GitHub)        | All open PRs in an org.                                                  |
| `repo:owner/name` (GitHub) | One specific repo.                                                       |

> [!IMPORTANT]
> `reviewer` is global — it works across every repo your token can see. You don't need to pre-list repos. This is the main reason Lens stays "zero-integration" — there's nothing to wire up per-repo.

---

### 2.5 Verify setup

Three quick checks:

```bash
# 1. Lens itself
lens --version

# 2. Forge auth — should print a few open PR IDs
lens list

# 3. Provider — analyze any PR you have open
lens analyze gh:owner:repo:42        # GitHub
lens analyze bb:workspace:repo:42    # Bitbucket
```

If `lens list` returns 0 PRs but you know there are some open, double-check your `scope` and that the token/CLI actually has access to those repos. If `lens analyze` errors with `provider X not found`, your provider CLI isn't on `PATH` — start a new shell or check `which claude` / `which gemini`.

You're done. Open the UI:

```bash
lens serve
# → http://localhost:7777
```

---

## 3. Daily Workflow

```bash
lens list                               # 1. see what's waiting
lens analyze gh:acme:api:42             # 2. let AI draft
lens serve                              # 3. curate in browser
                                        # 4. accept/edit/reject in UI
                                        # 5. click "Submit Review" — done
```

Most users keep `lens serve` running in a terminal pane next to their editor and reach for it whenever a PR review notification comes in.

**Power-user workflow** (with all features enabled):

```bash
# one-time per repo: install hook + build index
lens hook install
lens index

# one-time per team: mine PR history for team patterns
lens learn

# before opening a PR: hook runs automatically on git push
# (reviews your diff, prompts on blockers)

# when reviewing someone else's PR:
lens brief gh:acme:api:42               # post a briefing so reviewers know where to focus
lens analyze gh:acme:api:42 --brief     # brief + full review in one shot
lens serve                              # curate, then submit
```

---

## 4. Commands Reference

### Core

| Command                             | What it does                                                     |
| :---------------------------------- | :--------------------------------------------------------------- |
| `lens list`                         | Sync open PRs into the local DB.                                 |
| `lens analyze <id>`                 | Run Triage → Review → Critic.                                    |
| `lens analyze <id> --re`            | Re-run AI review, **keep** your manual edits and rejections.     |
| `lens analyze <id> --effort high`   | Use the strongest models available (Opus / Pro).                 |
| `lens analyze <id> --no-critic`     | Skip the self-critique pass (cheaper, noisier).                  |
| `lens analyze <id> --no-triage`     | Review every file, even lockfiles (rarely useful).               |
| `lens analyze <id> --brief`         | Post a reviewer briefing to the forge before inline comments.    |
| `lens serve`                        | Launch the curation UI on `http://localhost:7777`.               |
| `lens serve --port 8080`            | Use a different port.                                            |
| `lens usage`                        | Per-provider summary (calls, tokens, cost).                      |
| `lens usage --by-pr`                | Per-PR token + cost breakdown.                                   |
| `lens usage --by-stage`             | Per-stage (triage / review / critic) breakdown.                  |
| `lens diff`                         | Print AI-original vs final body for every comment.               |
| `lens diff --pr <id>`               | Limit the diff view to one PR.                                   |
| `lens diff --only-edited`           | Hide untouched comments — show only what you edited or rejected. |
| `lens export-eval`                  | Dump the full eval log as JSONL.                                 |
| `lens export-eval --out file.jsonl` | Write to a file.                                                 |

### Pre-push Hook

| Command                    | What it does                                            |
| :------------------------- | :------------------------------------------------------ |
| `lens hook install`        | Install a git pre-push hook in the current repo.        |
| `lens hook install --force`| Overwrite an existing hook.                             |
| `lens hook uninstall`      | Remove the lens pre-push hook.                          |
| `lens hook run`            | (Internal) called by git — not for direct use.          |

### Reviewer Briefing

| Command                          | What it does                                                 |
| :------------------------------- | :----------------------------------------------------------- |
| `lens brief <id>`                | Generate and post a reviewer briefing for a PR.             |
| `lens brief <id> --no-post`      | Print the briefing locally without posting to the forge.    |
| `lens brief <id> -p gemini`      | Use a specific provider for briefing generation.            |
| `lens brief <id> -e low`         | Use effort=low models (faster, cheaper).                    |

### Institutional Memory

| Command                          | What it does                                                      |
| :------------------------------- | :---------------------------------------------------------------- |
| `lens learn`                     | Mine merged PRs and write `.lens/skills.md` with team patterns.  |
| `lens learn --max-prs 100`       | Mine more PRs (default: 50).                                     |
| `lens learn --no-ai`             | Use frequency analysis instead of LLM clustering.               |
| `lens learn --dry-run`           | Preview what would be written without writing.                   |
| `lens accuracy`                  | Show AI comment acceptance rates by category and severity.       |
| `lens accuracy --category security` | Filter to one lens category.                                  |

### Codebase Index

| Command                    | What it does                                                       |
| :------------------------- | :----------------------------------------------------------------- |
| `lens index`               | Build or refresh the symbol index for the current repo.           |
| `lens index --force`       | Re-index even if the index is fresh.                              |
| `lens index --root <path>` | Index a specific repo root instead of auto-detecting from `cwd`. |

---

## 5. How a Review Runs

```text
1. TRIAGE   — heuristic + model filter; lockfiles & generated code skipped
2. CONTEXT  — extract symbols & imports for deep-triaged files
3. REVIEW   — provider drafts comments through specialized "lenses"
4. CRITIC   — second pass prunes low-confidence noise
5. PERSIST  — drafts written to SQLite; nothing posted yet
```

### Effort levels

`--effort` is the simplest dial — it picks model tiers under the hood.

| Level                | Triage | Review | Critic | Use when                       |
| :------------------- | :----- | :----- | :----- | :----------------------------- |
| `low`                | Haiku  | Haiku  | Haiku  | quick once-over, throwaway PRs |
| `medium` _(default)_ | Haiku  | Sonnet | Haiku  | day-to-day reviews             |
| `high`               | Sonnet | Opus   | Sonnet | gnarly PRs, critical paths     |

You can also override individual stages in `config.json` if the presets aren't quite right.

### The "lenses"

Each review pass runs through several lenses, in order:

- **correctness** — bugs, off-by-ones, null handling
- **security** — injection, auth bypass, secret leakage
- **data_integrity** — race conditions, missing transactions, schema drift
- **api_contracts** — breaking changes, missing versioning
- **maintainability** — readability, dead code, TODOs

---

## 6. Skill Packs

Lens uses **Skill Packs** to layer language- and team-specific knowledge into the prompt.

- **Built-in**: `skills/*.md` — TypeScript, JavaScript, Go, Java, Python, SQL, etc. Auto-loaded based on file extensions in the diff.
- **Repo-level override**: drop a `.lens/skills.md` at the root of any repo to inject team rules ("we use `Result<T, E>` not exceptions", "all SQL must go through the repository layer", etc.).

The repo-level file is the canonical place to teach Lens about your team's style. It travels with the code, is reviewed in PRs, and survives reinstalls.

---

## 7. Re-analyze Without Losing Your Edits

If a PR is force-pushed or you want to refresh the AI's take after fixing something:

```bash
lens analyze <id> --re
```

This re-runs Triage → Review → Critic but **preserves**:

- comments you edited (kept as your edited body)
- comments you rejected (stay rejected, with their reason)
- comments you added manually (untouched)

New AI suggestions land alongside the curated set.

---

## 8. Tokens, Cost & The Style Corpus

### Per-stage cost visibility

Lens logs every provider call with `stage`, `model`, `tokens_in`, `tokens_out`, `ms_elapsed`, and an estimated `cost_usd` (using a static price table). Click the cost badge in the AI Summary footer in the UI to see a per-stage breakdown for that PR — useful for spotting which lens is dominating spend.

### The style corpus

The diff between `ai_original_body` (what the model said) and `current_body` (what you submitted) is the most valuable thing Lens captures — it's a record of how you turn AI suggestions into _your_ voice.

```bash
lens diff --only-edited     # see exactly what you reframed
lens export-eval -o my-style.jsonl
```

That JSONL is structured for downstream use: future fine-tuning, few-shot prompting, or just a ledger of decisions you can grep through.

---

## 9. Resource Usage

Lens is intentionally small. Concrete numbers from typical use:

| Scenario                               | RAM             | CPU                                                   | Network                           |
| :------------------------------------- | :-------------- | :---------------------------------------------------- | :-------------------------------- |
| `lens serve` idle (browser tab closed) | 60–80 MB        | ~0%                                                   | none                              |
| `lens serve` with the UI open          | 80–100 MB       | <1%                                                   | localhost only                    |
| `lens analyze` running                 | 120–200 MB peak | variable (intensive while the provider CLI is active) | diff fetch + provider's LLM calls |
| Doing nothing (no commands running)    | **0 MB**        | **0%**                                                | **none**                          |

### Is `lens serve` always running?

No — it's a foreground process you start with `lens serve` and stop with `Ctrl+C`. There is no auto-start, no daemon, no launchd/systemd unit, no menu-bar app. If you want it always-available, run it in a `tmux`/`screen` pane or a persistent terminal tab; otherwise spin it up only when you're reviewing.

When it **is** running, it's just a Node HTTP server bound to `localhost` reading from a SQLite file — comparable footprint to having a single browser tab idle.

### Disk

- Code + deps after `npm install`: ~80 MB in `node_modules` + ~5 MB compiled `dist/`
- `~/.lens/lens.db`: ~50–500 KB per analyzed PR; grows linearly with PRs analyzed. Vacuum or delete the file at any time — Lens will recreate it.

### Provider cost

Lens itself doesn't charge anything. Token cost is whatever your provider charges; check `lens usage` for the running tally.

---

## 10. Troubleshooting

> [!WARNING]
> If comments appear on the wrong lines after submission, the diff probably changed (force-push, rebase). Run `lens analyze <id> --re` to resync.

| Symptom                            | Resolution                                                                          |
| :--------------------------------- | :---------------------------------------------------------------------------------- |
| `provider X not found`             | Make sure the CLI is on `PATH` and authenticated.                                   |
| `GitHub token not found`           | Run `gh auth login`, or set `$GITHUB_TOKEN`, or put a token in `config.json`.       |
| `UI shows no analysis for this PR` | Run `lens analyze <id>` first — `lens serve` only renders what's already in SQLite. |
| `port 7777 in use`                 | `lens serve --port 8080`                                                            |
| Comments off by a line             | The PR diff changed since analysis — `lens analyze <id> --re`.                      |
| Lens feels slow                    | Try `--effort low` for first-pass, `--no-critic` to skip the second model pass.     |
| Want to start fresh                | `rm ~/.lens/lens.db` — Lens will recreate it on next run.                           |

---

**See also**: [CAPABILITIES.md](./CAPABILITIES.md) for provider-specific notes and quirks.

---

## 11. Pre-push Hook

The pre-push hook turns lens from a reactive tool (run after pushing) into a proactive one — it reviews your changes **before** anyone else sees them.

### Install

```bash
cd your-repo
lens hook install
```

This writes a `.git/hooks/pre-push` script. From this point on, every `git push` triggers a quick AI review of the diff between `HEAD` and `origin/<base-branch>`.

### What happens on push

```
🔍 lens: reviewing your changes before push...

lens found: 1 blocker(s), 2 concern(s)

🚫 Blockers:
  src/auth/session.ts:87 — Token stored in localStorage exposes it to XSS...

Proceed with push anyway? [y/N]
```

- **No issues** → push proceeds silently.
- **Only concerns** → push proceeds with a warning printed.
- **Blockers found** → lens prints each blocker with file and line, then prompts `[y/N]`. Type `y` to push anyway, `N` (or Enter) to cancel and fix first.
- **Tool timeout or failure** → push proceeds. The hook never blocks you due to its own errors.

### Configuration

Add a `hook` section to `~/.lens/config.json` to tune the behaviour:

```jsonc
{
  "hook": {
    "effort": "low",        // "low"|"medium"|"high" — default: "low" (fast)
    "skipCritic": true,     // skip the second-pass critic (default: true, keeps it fast)
    "timeoutSec": 30,       // abort and allow push after N seconds (default: 30)
    "baseBranch": "main"    // override auto-detected base branch
  }
}
```

The hook uses `effort: low` by default — Haiku-class models, no critic — so it typically finishes in 10–20 seconds. Use `effort: medium` if you want Sonnet-quality review on every push (slower but higher signal).

### Uninstall

```bash
lens hook uninstall
```

---

## 12. Reviewer Briefing

`lens brief` generates a structured orientation for human reviewers — not inline code comments, but a high-level guide posted as a top-level PR comment.

### Usage

```bash
# post a briefing to the forge (GitHub/Bitbucket)
lens brief gh:acme:api:42

# print locally without posting
lens brief gh:acme:api:42 --no-post

# post briefing AND run full review in one command
lens analyze gh:acme:api:42 --brief
```

### What gets posted

```markdown
## 🔍 Reviewer Briefing — Add payment retry logic

**Risk:** 🔴 HIGH | **Estimated review time:** ~18 min

### What changed
- RetryService wraps PaymentGateway with exponential backoff (3 attempts)
- Failed payments flow to a dead-letter queue after exhausting retries
- New config keys: RETRY_MAX_ATTEMPTS, RETRY_BACKOFF_MS

### Focus here
- **src/retry.ts** — Lock acquisition order may deadlock under concurrent retries
- **src/queue/dead_letter.ts** — No TTL on queued items; unbounded growth risk

### Safe to skim
- migrations/ — additive column only, backward compatible
- tests/ — standard mocks, no new test patterns introduced
```

### How risk is determined

| Level  | Criteria                                                                          |
| :----- | :-------------------------------------------------------------------------------- |
| HIGH   | Security-sensitive paths, auth, DB migrations, public API changes, core logic     |
| MEDIUM | Moderate logic changes, internal API changes, non-trivial refactors               |
| LOW    | Config tweaks, docs, minor additions, test-only changes, dependency bumps         |

Estimated review time is calculated from total changed lines ÷ 50, capped at 90 minutes.

---

## 13. Institutional Memory

Over time, lens can learn what *your team* considers worth flagging — not generic AI advice, but patterns extracted from your own merged PR history.

### `lens learn` — mine PR history

```bash
# mine last 50 merged PRs (default) and write .lens/skills.md
lens learn

# mine more history
lens learn --max-prs 100

# preview without writing
lens learn --dry-run

# skip LLM clustering, use frequency analysis only (no provider needed)
lens learn --no-ai
```

**What it does:**

1. Fetches merged PRs from your forge (GitHub or Bitbucket).
2. Collects all review comments left on those PRs.
3. Groups comments by file extension and clusters recurring patterns — either via LLM (default) or frequency analysis.
4. Writes `.lens/skills.md` in your current directory with the extracted team rules.

**Output example:**

```markdown
<!-- lens:generated:start -->
# Team Review Patterns
<!-- auto-generated by lens learn on 2026-05-06 -->

## [correctness]
### ts files
- Check for: missing await
- Check for: null check before accessing nested properties
- Check for: error boundary missing

### go files
- Check for: mutex unlock defer
- Check for: context cancellation
<!-- lens:generated:end -->
```

The generated block is wrapped in sentinel comments. Any content you add outside those comments is preserved on subsequent `lens learn` runs.

### Commit `.lens/skills.md` to your repo

Once generated, check it in. Every teammate who uses lens on that repo automatically gets the team's accumulated knowledge injected into every review — without any extra setup.

```bash
git add .lens/skills.md
git commit -m "chore: add lens team skill pack"
```

### `lens accuracy` — measure AI signal quality

```bash
lens accuracy
```

Shows acceptance rates for every lens category based on your curation history (comments you kept vs. edited vs. rejected):

```
Category            Severity      Total     Accepted    Rate
──────────────────────────────────────────────────────────
correctness         blocker          12           11    91%  ██████████ 91%
correctness         concern          34           27    79%  ████████░░ 79%
──────────────────────────────────────────────────────────
security            blocker           4            4   100%  ██████████ 100%
security            concern          18           12    66%  ██████░░░░ 66%
──────────────────────────────────────────────────────────
maintainability     suggestion       41           11    26%  ██░░░░░░░░ 26%
```

Use this to decide which lenses to trust and which to tune. A maintainability acceptance rate under 30% is a signal to tighten the maintainability skill pack or raise its threshold.

Filter to a specific lens:

```bash
lens accuracy --category security
lens accuracy --severity blocker
```

---

## 14. Codebase-Aware Review

Standard diff-based review only sees what changed. Lens can also index your entire codebase to understand *what depends on what* — so when you change a widely-used function, the review flags it.

### Build the index

```bash
# run once per repo (takes < 10s for most codebases)
lens index
```

The index scans your repo for exported symbol definitions and call sites, storing everything in `~/.lens/lens.db`. It covers TypeScript, JavaScript, Go, Python, Java, and Dart.

```
Indexing /Users/you/code/my-api...
✓ Indexed 1,243 files → 8,421 symbols, 34,872 call sites (4,102ms)

Top referenced symbols:
  parseUserToken                 89 call sites
  DatabaseClient                 67 call sites
  validateRequest                51 call sites
```

### What you get in reviews

Once indexed, every `lens analyze` run automatically queries the index for the symbols changed in the PR and injects a blast radius block into the prompt:

```
## Blast Radius (symbol call-site analysis)

Changed exported symbols and their call-site counts:
- `parseUserToken`: 89 call sites 🔴 HIGH IMPACT
- `SessionStore`: 12 call sites 🟡

Files outside this PR that depend on changed symbols (6):
- src/middleware/auth.ts
- src/routes/admin.ts
- src/workers/token_refresh.ts
- …and 3 more
```

This gives the reviewer context that is impossible to get from the diff alone — especially for shared utilities and core services.

### Keep the index fresh

The index is valid for 5 minutes by default. Re-run before reviewing large PRs touching shared code:

```bash
lens index --force
```

You can also add `lens index` to your git post-merge or post-checkout hook to keep it updated automatically.

### Configuration

```jsonc
{
  "index": {
    "languages": ["ts", "js", "go", "py", "java", "dart"],
    "excludeDirs": ["node_modules", "vendor", "dist", "build", ".next", ".git"]
  }
}
```
