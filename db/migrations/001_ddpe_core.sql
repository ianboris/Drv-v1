-- DDPE core persistence schema (PostgreSQL / Neon)
-- Apply once to the intended Neon database. No credentials belong in this file.
-- owner_id is an application-level scope key; replace it with a verified auth subject
-- before exposing write endpoints to the public internet.

CREATE TABLE IF NOT EXISTS ddpe_settings (
  owner_id TEXT PRIMARY KEY,
  stake NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (stake > 0),
  daily_loss_limit NUMERIC(18, 8) NOT NULL DEFAULT 2 CHECK (daily_loss_limit > 0),
  analysis_window INTEGER NOT NULL DEFAULT 100 CHECK (analysis_window BETWEEN 50 AND 5000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ddpe_ticks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  tick_epoch BIGINT NOT NULL,
  quote NUMERIC(28, 12) NOT NULL,
  pip_size SMALLINT NOT NULL CHECK (pip_size BETWEEN 0 AND 10),
  last_digit SMALLINT NOT NULL CHECK (last_digit BETWEEN 0 AND 9),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, symbol, tick_epoch)
);

CREATE INDEX IF NOT EXISTS ddpe_ticks_owner_symbol_epoch_idx
  ON ddpe_ticks (owner_id, symbol, tick_epoch DESC);

CREATE TABLE IF NOT EXISTS ddpe_prediction_choices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  barrier_digit SMALLINT NOT NULL CHECK (barrier_digit BETWEEN 0 AND 9),
  predicted_at_epoch BIGINT NOT NULL,
  settled_at_epoch BIGINT,
  outcome_digit SMALLINT CHECK (outcome_digit BETWEEN 0 AND 9),
  is_correct BOOLEAN,
  analysis_window INTEGER NOT NULL CHECK (analysis_window BETWEEN 50 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, symbol, predicted_at_epoch),
  CHECK (
    (settled_at_epoch IS NULL AND outcome_digit IS NULL AND is_correct IS NULL)
    OR
    (settled_at_epoch IS NOT NULL AND outcome_digit IS NOT NULL AND is_correct IS NOT NULL
      AND settled_at_epoch > predicted_at_epoch)
  )
);

CREATE INDEX IF NOT EXISTS ddpe_choices_owner_symbol_settled_idx
  ON ddpe_prediction_choices (owner_id, symbol, settled_at_epoch DESC)
  WHERE is_correct IS NOT NULL;

CREATE TABLE IF NOT EXISTS ddpe_trades (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id TEXT NOT NULL,
  deriv_contract_id BIGINT UNIQUE,
  symbol TEXT NOT NULL,
  contract_type TEXT NOT NULL CHECK (contract_type = 'DIGITDIFF'),
  barrier_digit SMALLINT NOT NULL CHECK (barrier_digit BETWEEN 0 AND 9),
  stake NUMERIC(18, 8) NOT NULL CHECK (stake > 0),
  buy_price NUMERIC(18, 8),
  payout NUMERIC(18, 8),
  net_profit NUMERIC(18, 8),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'OPEN', 'WON', 'LOST', 'CANCELLED', 'ERROR')),
  purchased_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ddpe_trades_owner_settled_idx
  ON ddpe_trades (owner_id, settled_at DESC);

CREATE TABLE IF NOT EXISTS ddpe_daily_risk (
  owner_id TEXT NOT NULL,
  trading_day DATE NOT NULL,
  realized_net_pl NUMERIC(18, 8) NOT NULL DEFAULT 0,
  loss_limit NUMERIC(18, 8) NOT NULL CHECK (loss_limit > 0),
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  lock_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, trading_day)
);

-- The execution service must update daily P/L transactionally after each settlement.
-- It must reject a buy if locked = TRUE or realized_net_pl <= -loss_limit.
-- A browser-side value is never an authoritative risk-control source.
