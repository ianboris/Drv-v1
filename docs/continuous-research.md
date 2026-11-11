# Lotus continuous digit research

## Scope
This is a separate, unauthenticated public-market-data daemon. It is independent of the demo execution worker and continues while the browser is closed. It subscribes only to Deriv synthetic-index symbols and explicitly excludes names containing Boom or Crash. It does not place trades.

## Storage format and limits
- Daily archive: `/var/lib/lotus/research/ticks-YYYY-MM-DD.jsonl.gz`
- Each record is one JSON object with symbol, epoch, quote, pip precision, digit, provider tick ID, and source.
- Appends are complete gzip members; concatenated gzip members form one valid gzip stream and can be read by standard gzip tools.
- Raw ticks are written in batches (500 or five seconds), not one DB insert per tick.
- Neon stores per-day/per-symbol tick counts and ten digit counts, plus worker health. It does not store every raw tick.
- In-memory queue is capped at 25,000 ticks; batches are drained to disk and compact aggregates. The worker subscribes to at most 10 symbols by default (`LOTUS_RESEARCH_MAX_SYMBOLS`, hard-capped at 20) to avoid exhausting Deriv subscription capacity. It pauses collection if free disk space falls below 2 GiB.
- Local archive retention defaults to 90 days (minimum 7). This is a bounded local disk policy, not off-site backup. Before enabling deletion, configure and verify an OCI Object Storage backup if archives must be retained longer.

## Install on OCI
1. Review and apply `migrations/20261113_lotus_research_archive.sql` to the intended Neon branch. This migration is not applied automatically.
2. Deploy the branch to `/opt/lotus`; create `/var/lib/lotus/research` owned by the unprivileged `lotus` user.
3. Ensure `/etc/lotus/worker.env` contains the correct `DATABASE_URL`. No Deriv OAuth token or encryption key is needed by this public research service.
4. Install the unit: `sudo cp worker/lotus-research.service /etc/systemd/system/`, then `sudo systemctl daemon-reload`.
5. Start: `sudo systemctl enable --now lotus-research`.
6. Verify: `sudo systemctl status lotus-research`, `sudo journalctl -u lotus-research -f`, and inspect daily files with `gzip -t /var/lib/lotus/research/ticks-$(date -u +%F).jsonl.gz` and `gzip -cd ... | head`.

## Important limitations to resolve before production use
- Deriv may return several ticks within the same second. The old `ddpe_ticks` table has a unique constraint on (owner_id, symbol, tick_epoch), so it is not safe for all raw ticks. This collector avoids that table and archives provider tick IDs instead.
- Confirm that the current Deriv `active_symbols` payload uses `market=synthetic_index` for every intended symbol in the account/API region. If it differs, adjust the allowlist based on an observed payload rather than broadening to all markets.
- The worker's daily aggregates are updated after the compressed batch is appended. A crash between those operations can cause a small aggregate undercount after restart; raw archive is the source of truth and reconciliation tooling is a follow-up requirement.
- Backfill is limited to 1,000 recent ticks per market per reconnect. It is not yet a complete historical gap-repair system.
- Local retention deletes archives older than 90 days. Configure verified remote backup before increasing retention or treating archives as durable long-term records.
