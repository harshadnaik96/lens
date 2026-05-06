# 🗄️ SQL / Migrations Review — Lens Skill Pack

## Quality bar
- Only comment if a senior backend engineer's first reaction would be "good catch," not "yeah I know."
- Don't comment on: formatting, indentation, aliasing style, anything a SQL linter handles.

## [correctness]
- `UPDATE` or `DELETE` without a `WHERE` clause — affects every row in the table.
- `NOT IN (subquery)` when the subquery can return `NULL` — always evaluates to false/empty; use `NOT EXISTS` instead.
- `COUNT(column)` instead of `COUNT(*)` when NULLs should be counted.
- `HAVING` used without `GROUP BY` — legal but almost always a logic error.
- Implicit type coercion in `WHERE` predicates disabling index use (e.g. `WHERE int_col = '42'`).
- `DISTINCT` applied to mask a missing or broken join condition.
- `LEFT JOIN` result filtered in `WHERE` on the right-side table — silently converts to `INNER JOIN`.
- Division without a `NULLIF` zero guard — runtime error on divide-by-zero.
- Aggregation over a subquery that returns duplicates where `DISTINCT` was intended.

## [security]
- String interpolation of user-controlled input into raw SQL — SQL injection.
- Stored procedure or function executing dynamic SQL (`EXEC`, `sp_executesql`, `EXECUTE`) with unsanitized input.
- `GRANT` statements that are overly broad (`ALL PRIVILEGES`, `TO PUBLIC`, or to an application role that shouldn't have DDL access).
- Sensitive columns (passwords, tokens, SSNs, card numbers) added without encryption or masking.
- New table or column containing PII without a data-classification comment.

## [data_integrity]
- Migration that drops a column or table without a prior deprecation/backfill phase — breaks running old code.
- `NOT NULL` column added without a `DEFAULT` — fails on non-empty tables in most databases.
- `ALTER TABLE … ADD COLUMN` with a `DEFAULT` on a large table in Postgres pre-11 — full table rewrite; use a backfill migration instead.
- Index dropped or renamed without checking whether application queries depend on it.
- Foreign key added without `NOT VALID` + `VALIDATE CONSTRAINT` pattern — locks table on large datasets.
- Multi-step migration (add column → backfill → set NOT NULL) collapsed into a single transaction — backfill may time out or lock.
- `ON DELETE CASCADE` added to a relationship where cascade deletes were not explicitly intended.
- Unique constraint removed without understanding what relied on it for deduplication.
- Migration that is not idempotent (no `IF NOT EXISTS` / `IF EXISTS` guards) — breaks re-runs after partial failure.
- Sequence or auto-increment reset without checking current max value — risks primary key collision.

## [api_contracts]
- Column renamed in a migration while application code still references the old name.
- Enum type value removed or renamed — breaks existing rows storing the old value.
- View or materialized view definition changed in a way that breaks callers relying on its column list.
- Stored procedure signature changed (parameter added/removed/renamed) without updating all callers.

## [maintainability]
- Missing index on foreign key columns — causes sequential scans on joins in most databases.
- Composite index column order does not match query filter/sort patterns (most selective column should lead).
- `SELECT *` in a view or stored procedure — breaks silently when columns are added/removed.
- Migration file not prefixed with a timestamp or sequential number — ordering becomes ambiguous.
- Large data migrations (backfills) not batched — risks long-running transactions and lock contention.
