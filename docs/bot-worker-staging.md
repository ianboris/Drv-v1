# Lotus server worker — staging only

## Status and hard boundary

This worker is deliberately restricted to `BOT_ENVIRONMENT=staging` and
`BOT_MODE=plumbing_test`. It refuses to start otherwise. Real-account
endpoints are not constructed. Do not deploy this process to production.

The process requires Node.js 22, `DATABASE_URL`,
`DERIV_TOKEN_ENCRYPTION_KEY`, and a staging Neon database. It uses Node 22's
built-in WebSocket implementation; no extra WebSocket package is required.

## Environment

Set these only on the staging worker host:

- `BOT_ENVIRONMENT=staging`
- `BOT_MODE=plumbing_test`
- `DATABASE_URL` — staging Neon branch connection string
- `DERIV_TOKEN_ENCRYPTION_KEY` — same encryption key used by the OAuth backend
- `LOTUS_WORKER_SYMBOL` — an explicitly chosen Deriv symbol code

The selected account ID and encrypted OAuth token are read from the existing
`ddpe_deriv_connections` table. The worker re-fetches the account list and
rejects anything not identified as demo/virtual.

## Control API

Authenticated app session:

- `POST /api/bot/start` with `{ "account_id": "...", "symbol": "R_10" }`
- `POST /api/bot/stop`
- `GET /api/bot/status`
- `POST /api/bot/reconcile` — requests reconciliation; it does not retry a buy.

The worker itself is a separate persistent process:
`node worker/bot-worker.mjs`.

Starting increments `worker_epoch`. Stop sets the durable stop flag but does
not fence the current process, because it may still need to finish monitoring
an accepted contract. A later start increments the epoch and is refused while
an order or unknown buy remains unresolved.

## Order and safety semantics

- Reserve the order UID with one conditional UPDATE before requesting proposal.
- Re-run the same conditional UPDATE before buy; it succeeds only for the same
  reservation, current epoch, and non-stopped control row.
- A buy timeout or missing contract ID persists `buy_unknown=true` and halts.
  It remains blocked across process restarts.
- Reconciliation is operator-triggered. The worker must use Deriv statement
  (`{statement:1, action_type:"buy", date_from, date_to, description:1,
  limit:999}`) and profit table
  (`{profit_table:1, contract_type:["DIGITDIFF"], date_from, date_to,
  description:1, limit:500, sort:"DESC"}`) to find the purchase/contract.
  Statement response rows are at `statement.transactions[]` and include
  `contract_id`, `transaction_id`, `amount`, `transaction_time`,
  `action_type`, and optional `shortcode/longcode`. Profit-table rows are
  at `profit_table.transactions[]` and include `contract_id`,
  `transaction_id`, `buy_price`, `payout`, `sell_price`, `sell_time`.
- Neither request accepts a proposal ID filter. If no contract ID is known,
  correlate only a unique statement buy row in a narrow time window using
  amount and full contract description; if zero or multiple candidates exist,
  leave the halt and slot in place for human investigation. Never infer that
  no purchase occurred from an incomplete/empty page.
- A successful reconciliation appends `RECONCILED` with the Deriv transaction
  and contract identifiers, then releases the slot only if the Deriv contract
  is settled. An open contract remains reserved and must be monitored to
  settlement. Corrections append `CORRECTION`; no journal row is edited.
- The database trigger rejects stale-epoch event inserts and all UPDATE/DELETE
  attempts on the event journal.

## Important implementation limitation in this PR

The worker contains the demo-only bootstrap, risk gates, proposal/buy request
path, and fail-closed unknown-buy handling. Contract settlement recovery and
the human reconciliation operation are not yet enabled for unattended use.
Until those paths are completed and the staging test sequence passes, do not
run the process against Deriv. This PR is a reviewable implementation
foundation, not evidence of live or unattended operation.
