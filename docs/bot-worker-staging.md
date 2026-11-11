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

Apply `migrations/20261111_lotus_deriv_demo_oauth.sql` to the staging branch
before OAuth login. The selected account ID and encrypted OAuth token are read
from the existing `ddpe_deriv_connections` table. The symbol is supplied in the
start request body, not from an environment variable. The worker re-fetches the account list and
rejects anything not identified as demo/virtual.

## Control API

Authenticated app session:

- `POST /api/bot/start` with `{ "account_id": "...", "symbol": "R_10" }`
- `POST /api/bot/stop`
- `GET /api/bot/status`
- `POST /api/bot/reconcile` — requests reconciliation; it does not retry a buy.
- `POST /api/bot/reconcile/confirm-no-purchase` with `{ "confirm_no_purchase": true, "reason": "..." }` — operator-only release after independently reviewing Deriv's statement. It is enabled only when the latest statement reconciliation returned zero matches, at least 60 seconds have elapsed since BUY_SENT, the no-match event is at least 10 seconds old, and the worker lease has expired. The confirmation is appended as a RECONCILED event.

The worker itself is a separate persistent process:
`node worker/bot-worker.mjs`.

Starting increments `worker_epoch` and clears the previous process lease. The
worker then atomically claims a 20-second renewable lease with a unique process
instance ID. Only that instance can write control state or worker journal rows
for the epoch; a second process cannot acquire the active lease. Expired leases
can be taken over after a crash, and the database rejects writes from the
previous instance even if it resumes later.

Stop sets the durable stop flag but does not fence the current process, because
it may still need to finish monitoring an accepted contract. A later start
increments the epoch and is refused while an order or unknown buy remains
unresolved. The 10-authorized-buy-attempt plumbing cap and consecutive-loss count are
preserved across worker restarts; restarting cannot reset either limit.

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

## Verification boundary

The worker polls Deriv tick history once per control cycle and deduplicates by
latest tick epoch. Proposal requests use Deriv's required `underlying_symbol`
field. The worker does not buy a unary proposal ID: the current Deriv schema
states that unary proposal IDs are informational, so the buy uses
`buy: "1"` with the same explicit contract parameters and the proposal ask
price as the maximum purchase price. This is restricted to one-tick DIGITDIFF
plumbing contracts. It monitors confirmed contracts through settlement, including
after a process restart, and exposes an operator-triggered reconciliation path
for an unknown buy. A unique statement match is required; ambiguous or absent
matches leave the durable halt and order slot intact.

This implementation has not yet been run against Deriv or Oracle. Do not run
it against Deriv until the unit tests and staging migration/trigger tests pass.
The 10-order cap, server-side risk checks, and event journal are intended for
plumbing validation only; they are not evidence of strategy profitability or
production readiness.
