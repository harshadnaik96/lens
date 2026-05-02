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

---

## 1. Installation & Prerequisites

### Requirements
- **Node.js 20+**
- **At least one provider CLI** authenticated and on your `PATH`:

| Provider | Binary | Install | Recommended for |
| :--- | :--- | :--- | :--- |
| Claude Code | `claude` | [claude.com/code](https://claude.com/code) | best overall reasoning |
| Gemini CLI | `gemini` | Google's `gemini` CLI | large context, fast |

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
Bitbucket uses **app passwords**, not OAuth tokens.

1. Go to <https://bitbucket.org/account/settings/app-passwords/>.
2. Click **Create app password**.
3. **Label**: `lens`
4. **Permissions** — tick at minimum:
   - **Account** → Read
   - **Workspace membership** → Read
   - **Repositories** → Read
   - **Pull requests** → Read **and Write** (Write is needed to post review)
5. Click **Create**, copy the password (shown **only once**).
6. Note your Bitbucket **username** (not your email — find it at <https://bitbucket.org/account/settings/>).
7. Both go into `~/.lens/config.json` under `bitbucket.username` and `bitbucket.appPassword` (see §2.4).

> [!WARNING]
> App passwords are shown exactly once. If you lose it, revoke and create a new one — they cannot be retrieved.

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
    "token": "",                          // empty = use gh CLI / $GITHUB_TOKEN
    "scope": "reviewer"                   // see scopes table below
  },
  "provider": { "default": "claude" },
  "reviewer": { "name": "Harshad Naik" }
}
```

**Example — Bitbucket Cloud + Gemini:**
```jsonc
{
  "forge": "bitbucket",
  "bitbucket": {
    "username": "harshadnaik",
    "appPassword": "ATBBxxxxxxxxxxxxxxxx",
    "scope": "author"
  },
  "provider": { "default": "gemini" },
  "reviewer": { "name": "Harshad Naik" }
}
```

**Example — Bitbucket Server + Codex:**
```jsonc
{
  "forge": "bitbucket",
  "bitbucket": {
    "baseUrl": "https://bitbucket.mycorp.com",
    "username": "hnaik",
    "appPassword": "BBDC-xxxxxxxxxxxxx",
    "scope": "reviewer"
  },
  "provider": { "default": "codex" },
  "reviewer": { "name": "Harshad Naik" }
}
```

#### Discovery scopes

| Scope | Meaning |
| :--- | :--- |
| `reviewer` | PRs that have requested **your** review (across every repo you can see). |
| `author` | PRs **you opened**. |
| `org:NAME` (GitHub) | All open PRs in an org. |
| `repo:owner/name` (GitHub) | One specific repo. |

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

---

## 4. Commands Reference

| Command | What it does |
| :--- | :--- |
| `lens list` | Sync open PRs into the local DB. |
| `lens analyze <id>` | Run Triage → Review → Critic. |
| `lens analyze <id> --re` | Re-run AI review, **keep** your manual edits and rejections. |
| `lens analyze <id> --effort high` | Use the strongest models available (Opus / Pro). |
| `lens analyze <id> --no-critic` | Skip the self-critique pass (cheaper, noisier). |
| `lens analyze <id> --no-triage` | Review every file, even lockfiles (rarely useful). |
| `lens serve` | Launch the curation UI on `http://localhost:7777`. |
| `lens serve --port 8080` | Use a different port. |
| `lens usage` | Per-provider summary (calls, tokens, cost). |
| `lens usage --by-pr` | Per-PR token + cost breakdown. |
| `lens usage --by-stage` | Per-stage (triage / review / critic) breakdown. |
| `lens diff` | Print AI-original vs final body for every comment. |
| `lens diff --pr <id>` | Limit the diff view to one PR. |
| `lens diff --only-edited` | Hide untouched comments — show only what you edited or rejected. |
| `lens export-eval` | Dump the full eval log as JSONL. |
| `lens export-eval --out file.jsonl` | Write to a file. |

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

| Level | Triage | Review | Critic | Use when |
| :--- | :--- | :--- | :--- | :--- |
| `low` | Haiku | Haiku | Haiku | quick once-over, throwaway PRs |
| `medium` *(default)* | Haiku | Sonnet | Haiku | day-to-day reviews |
| `high` | Sonnet | Opus | Sonnet | gnarly PRs, critical paths |

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
The diff between `ai_original_body` (what the model said) and `current_body` (what you submitted) is the most valuable thing Lens captures — it's a record of how you turn AI suggestions into *your* voice.

```bash
lens diff --only-edited     # see exactly what you reframed
lens export-eval -o my-style.jsonl
```

That JSONL is structured for downstream use: future fine-tuning, few-shot prompting, or just a ledger of decisions you can grep through.

---

## 9. Resource Usage

Lens is intentionally small. Concrete numbers from typical use:

| Scenario | RAM | CPU | Network |
| :--- | :--- | :--- | :--- |
| `lens serve` idle (browser tab closed) | 60–80 MB | ~0% | none |
| `lens serve` with the UI open | 80–100 MB | <1% | localhost only |
| `lens analyze` running | 120–200 MB peak | variable (intensive while the provider CLI is active) | diff fetch + provider's LLM calls |
| Doing nothing (no commands running) | **0 MB** | **0%** | **none** |

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

| Symptom | Resolution |
| :--- | :--- |
| `provider X not found` | Make sure the CLI is on `PATH` and authenticated. |
| `GitHub token not found` | Run `gh auth login`, or set `$GITHUB_TOKEN`, or put a token in `config.json`. |
| `UI shows no analysis for this PR` | Run `lens analyze <id>` first — `lens serve` only renders what's already in SQLite. |
| `port 7777 in use` | `lens serve --port 8080` |
| Comments off by a line | The PR diff changed since analysis — `lens analyze <id> --re`. |
| Lens feels slow | Try `--effort low` for first-pass, `--no-critic` to skip the second model pass. |
| Want to start fresh | `rm ~/.lens/lens.db` — Lens will recreate it on next run. |

---

**See also**: [CAPABILITIES.md](./CAPABILITIES.md) for provider-specific notes and quirks.
