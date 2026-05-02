# 🌐 General Review — Lens Skill Pack checklist

## Quality bar
- Only comment if a senior's first reaction would be "good catch," not "yeah I know."
- Don't comment on: missing tests (unless PR claims to add them), commit messages, PR description quality, formatting, anything a linter/formatter handles.

## [correctness]
- Missing error handling on I/O, network, and DB calls.
- Off-by-one errors in loops, slices, and range operations.
- Silently swallowed exceptions (catch blocks with no log/rethrow).
- Unbounded loops or recursion without a base case.
- Boolean logic errors (De Morgan's law mistakes, inverted conditions).
- Null/undefined dereference on values from external sources (API, DB, user input).
- Return value ignored when it signals success/failure.
- Comparison of incompatible types (floating point equality, object reference vs value).
- Dead code paths that should be reachable, or reachable paths that should be dead.

## [security]
- SQL/command string concatenation with user-controlled input.
- Unvalidated user input flowing to file system, shell, or network operations.
- Hardcoded secrets, tokens, API keys, or environment-specific URLs in code.
- Weak or deprecated crypto (MD5, SHA1 for security purposes, Math.random for tokens).
- Missing auth/authz checks on new endpoints or routes.
- PII or sensitive data written to logs (emails, passwords, tokens, SSNs).
- Unvalidated redirects or forwards.
- Missing rate limiting on authentication or sensitive endpoints.

## [data_integrity]
- N+1 queries (loop of individual fetches instead of batch).
- Schema changes not backward compatible with running old code (safe sequence: add column nullable → backfill → flip required).
- Shared mutable state modified without synchronization.
- Cache operations without considering invalidation.
- Missing transaction boundaries around multi-step DB operations that must be atomic.
- Unbounded result sets (missing LIMIT on queries that could return millions of rows).

## [api_contracts]
- Breaking changes to exported functions/types in shared modules without version bump.
- Changed function signatures, removed exports, renamed public APIs.
- Inconsistent error response shapes across endpoints.
- Widened input types or narrowed output types that break consumers.

## [maintainability]
- TODO/FIXME/XXX introduced in the diff without a tracking issue.
- Functions with cyclomatic complexity clearly beyond team norm.
- Dead code introduced in this PR.
- Duplicated logic that should be extracted into a shared function.
