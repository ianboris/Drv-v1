# DDPE database migrations

Apply the SQL files in this directory to the intended Neon PostgreSQL database in numeric order:

1. `001_ddpe_core.sql`
2. `002_tick_and_choice_identity.sql`
3. `003_market_scanner_currency.sql`

## Important: use Run, not Explain

In the Neon SQL Editor, open each complete migration file and execute it with the normal **Run** action. Do not choose **Explain** or **Explain Analyze**, and do not prepend an `EXPLAIN (...)` statement.

These migrations contain schema-changing PostgreSQL commands such as `ALTER TABLE`, `CREATE INDEX`, and `CREATE TABLE`. PostgreSQL's `EXPLAIN` command does not execute schema changes, so wrapping an `ALTER TABLE` in `EXPLAIN` produces a syntax error at `ALTER`. Options such as `PREFETCH` and `FILECACHE` are not standard PostgreSQL EXPLAIN options either.

Run one migration at a time. Confirm that it completes before moving to the next file. If a migration fails partway through, inspect the actual database schema before retrying; do not assume every statement was rolled back.

## Deriv pip_size

Do not add a migration converting `pip_size` to NUMERIC. Deriv's ticks-history response schema describes `pip_size` as the number of decimal places used to display returned amounts. The existing `SMALLINT` column and 0–10 check in migration 001 are consistent with that representation. The frontend should use it as a decimal-place count, not transform it with `-log10`.

References:
- https://github.com/deriv-com/deriv-api-schemas/blob/master/schemas/ticks_history_response.schema.json
- https://developers.deriv.com/comparison/active-symbols/
