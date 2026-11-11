-- Lotus server worker control and append-only execution journal.
-- Apply only to an isolated Neon staging branch after reviewing this migration.

CREATE TABLE IF NOT EXISTS public.ddpe_bot_control (
  owner_id text PRIMARY KEY CHECK (owner_id = 'primary'),
  worker_epoch integer NOT NULL DEFAULT 0 CHECK (worker_epoch >= 0),
  desired_running boolean NOT NULL DEFAULT false,
  stop_requested boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'PLUMBING_TEST'
    CHECK (mode IN ('DEMO', 'PLUMBING_TEST')),
  demo_account_id text,
  symbol text,
  in_flight_order_uid text,
  buy_unknown boolean NOT NULL DEFAULT false,
  buy_unknown_order_uid text,
  reconciliation_requested boolean NOT NULL DEFAULT false,
  worker_heartbeat_at timestamptz,
  daily_loss_limit numeric(18,8) NOT NULL DEFAULT 2 CHECK (daily_loss_limit > 0),
  max_stake_pct numeric(8,6) NOT NULL DEFAULT 0.01 CHECK (max_stake_pct > 0 AND max_stake_pct <= 0.05),
  consecutive_loss_limit integer NOT NULL DEFAULT 3 CHECK (consecutive_loss_limit BETWEEN 1 AND 20),
  consecutive_losses integer NOT NULL DEFAULT 0 CHECK (consecutive_losses >= 0),
  plumbing_remaining integer NOT NULL DEFAULT 10 CHECK (plumbing_remaining BETWEEN 0 AND 10),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((buy_unknown = false AND buy_unknown_order_uid IS NULL)
      OR (buy_unknown = true AND buy_unknown_order_uid IS NOT NULL))
);

INSERT INTO public.ddpe_bot_control (owner_id)
VALUES ('primary')
ON CONFLICT (owner_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.ddpe_bot_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uid text NOT NULL UNIQUE,
  owner_id text NOT NULL DEFAULT 'primary' CHECK (owner_id = 'primary'),
  worker_epoch integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN (
    'WORKER_STARTED', 'WORKER_STOP_REQUESTED', 'HEARTBEAT',
    'DECISION', 'ORDER_RESERVED', 'PROPOSAL_RECEIVED',
    'BUY_AUTHORIZED', 'BUY_SENT', 'BUY_CONFIRMED', 'BUY_UNKNOWN',
    'CONTRACT_SETTLED', 'ORDER_RELEASED', 'RECONCILED', 'CORRECTION',
    'RISK_STOP', 'WORKER_ERROR', 'PLUMBING_CAP_REACHED'
  )),
  order_uid text,
  deriv_contract_id bigint,
  mode text NOT NULL CHECK (mode IN ('DEMO', 'PLUMBING_TEST')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ddpe_bot_events_owner_created_idx
  ON public.ddpe_bot_events (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ddpe_bot_events_order_idx
  ON public.ddpe_bot_events (order_uid, created_at);

CREATE OR REPLACE FUNCTION public.ddpe_bot_events_guard_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch integer;
BEGIN
  SELECT worker_epoch INTO current_epoch
  FROM public.ddpe_bot_control
  WHERE owner_id = NEW.owner_id
  FOR SHARE;

  IF current_epoch IS NULL OR NEW.worker_epoch <> current_epoch THEN
    RAISE EXCEPTION 'stale worker epoch: event %, current %', NEW.worker_epoch, current_epoch
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ddpe_bot_events_epoch_guard ON public.ddpe_bot_events;
CREATE TRIGGER ddpe_bot_events_epoch_guard
BEFORE INSERT ON public.ddpe_bot_events
FOR EACH ROW EXECUTE FUNCTION public.ddpe_bot_events_guard_insert();

CREATE OR REPLACE FUNCTION public.ddpe_bot_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ddpe_bot_events is append-only; append a CORRECTION event instead'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ddpe_bot_events_no_mutation ON public.ddpe_bot_events;
CREATE TRIGGER ddpe_bot_events_no_mutation
BEFORE UPDATE OR DELETE ON public.ddpe_bot_events
FOR EACH ROW EXECUTE FUNCTION public.ddpe_bot_events_append_only();

-- This table deliberately contains no Deriv credentials. The worker decrypts
-- the existing OAuth token only in its own process and never returns it to UI.
