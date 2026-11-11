-- Lotus server worker control and append-only execution journal.
-- Apply only to an isolated Neon staging branch after reviewing this migration.

CREATE TABLE IF NOT EXISTS public.ddpe_bot_control (
  owner_id text PRIMARY KEY CHECK (owner_id = 'primary'),
  worker_epoch integer NOT NULL DEFAULT 0 CHECK (worker_epoch >= 0),
  worker_instance_id text,
  worker_lease_expires_at timestamptz,
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
  last_processed_tick_epoch bigint NOT NULL DEFAULT 0,
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
  worker_instance_id text,
  event_type text NOT NULL CHECK (event_type IN (
    'WORKER_STARTED', 'WORKER_STOP_REQUESTED', 'HEARTBEAT',
    'DECISION', 'ORDER_RESERVED', 'PROPOSAL_RECEIVED',
    'BUY_AUTHORIZED', 'BUY_SENT', 'BUY_CONFIRMED', 'BUY_UNKNOWN',
    'CONTRACT_SETTLED', 'ORDER_RELEASED', 'RECONCILED', 'RECONCILIATION_REQUESTED', 'CORRECTION',
    'RISK_STOP', 'WORKER_ERROR', 'PLUMBING_CAP_REACHED'
  )),
  order_uid text,
  deriv_contract_id bigint,
  mode text NOT NULL CHECK (mode IN ('DEMO', 'PLUMBING_TEST')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ddpe_daily_risk
  ADD COLUMN IF NOT EXISTS worker_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE public.ddpe_bot_control
  ADD COLUMN IF NOT EXISTS worker_instance_id text,
  ADD COLUMN IF NOT EXISTS worker_lease_expires_at timestamptz;
ALTER TABLE public.ddpe_bot_events
  ADD COLUMN IF NOT EXISTS worker_instance_id text;

CREATE INDEX IF NOT EXISTS ddpe_bot_events_owner_created_idx
  ON public.ddpe_bot_events (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ddpe_bot_events_order_idx
  ON public.ddpe_bot_events (order_uid, created_at);


CREATE TABLE IF NOT EXISTS public.ddpe_bot_settlements (
  contract_id bigint PRIMARY KEY,
  order_uid text NOT NULL UNIQUE,
  worker_epoch integer NOT NULL,
  worker_instance_id text,
  profit numeric(18,8) NOT NULL,
  contract_status text NOT NULL CHECK (contract_status IN ('won', 'lost', 'sold', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ddpe_bot_settlements ADD COLUMN IF NOT EXISTS worker_instance_id text;

DROP FUNCTION IF EXISTS public.ddpe_apply_bot_settlement(text, integer, text, bigint, numeric, text);

CREATE OR REPLACE FUNCTION public.ddpe_apply_bot_settlement(
  p_owner_id text,
  p_worker_epoch integer,
  p_instance_id text,
  p_order_uid text,
  p_contract_id bigint,
  p_profit numeric,
  p_contract_status text
) RETURNS boolean LANGUAGE plpgsql AS $body$
DECLARE
  v_mode text;
  v_loss_limit numeric(18,8);
  v_inserted integer;
BEGIN
  SELECT mode, daily_loss_limit INTO v_mode, v_loss_limit
  FROM public.ddpe_bot_control
  WHERE owner_id = p_owner_id AND worker_epoch = p_worker_epoch
    AND worker_instance_id = p_instance_id AND worker_lease_expires_at > NOW()
    AND in_flight_order_uid = p_order_uid AND buy_unknown = false
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale worker epoch or order slot mismatch'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.ddpe_bot_settlements
    (contract_id, order_uid, worker_epoch, worker_instance_id, profit, contract_status)
  VALUES (p_contract_id, p_order_uid, p_worker_epoch, p_instance_id, p_profit, p_contract_status)
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO public.ddpe_daily_risk
    (owner_id, trading_day, realized_net_pl, loss_limit, locked, lock_reason, worker_epoch, updated_at)
  VALUES (p_owner_id, CURRENT_DATE, p_profit, v_loss_limit,
    (p_profit <= -v_loss_limit),
    CASE WHEN p_profit <= -v_loss_limit THEN 'daily_loss_limit' ELSE NULL END,
    p_worker_epoch, NOW())
  ON CONFLICT (owner_id, trading_day) DO UPDATE SET
    realized_net_pl = public.ddpe_daily_risk.realized_net_pl + EXCLUDED.realized_net_pl,
    loss_limit = EXCLUDED.loss_limit,
    locked = (public.ddpe_daily_risk.realized_net_pl + EXCLUDED.realized_net_pl) <= -EXCLUDED.loss_limit,
    lock_reason = CASE
      WHEN (public.ddpe_daily_risk.realized_net_pl + EXCLUDED.realized_net_pl) <= -EXCLUDED.loss_limit
      THEN 'daily_loss_limit' ELSE NULL END,
    worker_epoch = EXCLUDED.worker_epoch,
    updated_at = NOW();

  INSERT INTO public.ddpe_bot_events
    (event_uid, owner_id, worker_epoch, worker_instance_id, event_type, order_uid, deriv_contract_id, mode, payload)
  VALUES (md5(clock_timestamp()::text || random()::text), p_owner_id, p_worker_epoch, p_instance_id,
    'CONTRACT_SETTLED', p_order_uid, p_contract_id, v_mode,
    jsonb_build_object('profit', p_profit, 'status', p_contract_status));

  UPDATE public.ddpe_bot_control
  SET consecutive_losses = CASE WHEN p_profit < 0 THEN consecutive_losses + 1 ELSE 0 END,
      in_flight_order_uid = NULL, updated_at = NOW()
  WHERE owner_id = p_owner_id AND worker_epoch = p_worker_epoch
    AND worker_instance_id = p_instance_id AND worker_lease_expires_at > NOW()
    AND in_flight_order_uid = p_order_uid AND buy_unknown = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'worker epoch changed while applying settlement'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.ddpe_bot_events
    (event_uid, owner_id, worker_epoch, worker_instance_id, event_type, order_uid, deriv_contract_id, mode, payload)
  VALUES (md5(clock_timestamp()::text || random()::text), p_owner_id, p_worker_epoch, p_instance_id,
    'ORDER_RELEASED', p_order_uid, p_contract_id, v_mode,
    '{"reason":"settled"}'::jsonb);

  RETURN true;
END;
$body$;


CREATE OR REPLACE FUNCTION public.ddpe_bot_settlements_guard_insert()
RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE current_epoch integer; current_instance text; current_lease timestamptz;
BEGIN
  SELECT worker_epoch, worker_instance_id, worker_lease_expires_at
    INTO current_epoch, current_instance, current_lease
  FROM public.ddpe_bot_control WHERE owner_id = 'primary' FOR SHARE;
  IF current_epoch IS NULL OR NEW.worker_epoch <> current_epoch
    OR NEW.worker_instance_id IS DISTINCT FROM current_instance
    OR current_lease IS NULL OR current_lease <= NOW() THEN
    RAISE EXCEPTION 'stale worker epoch for settlement' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$body$;

CREATE OR REPLACE FUNCTION public.ddpe_bot_settlements_append_only()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'ddpe_bot_settlements is append-only'
    USING ERRCODE = '55000';
END;
$body$;

DROP TRIGGER IF EXISTS ddpe_bot_settlements_epoch_guard ON public.ddpe_bot_settlements;
CREATE TRIGGER ddpe_bot_settlements_epoch_guard
BEFORE INSERT ON public.ddpe_bot_settlements
FOR EACH ROW EXECUTE FUNCTION public.ddpe_bot_settlements_guard_insert();

DROP TRIGGER IF EXISTS ddpe_bot_settlements_no_mutation ON public.ddpe_bot_settlements;
CREATE TRIGGER ddpe_bot_settlements_no_mutation
BEFORE UPDATE OR DELETE ON public.ddpe_bot_settlements
FOR EACH ROW EXECUTE FUNCTION public.ddpe_bot_settlements_append_only();

CREATE OR REPLACE FUNCTION public.ddpe_bot_events_guard_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch integer; current_instance text; current_lease timestamptz;
BEGIN
  SELECT worker_epoch, worker_instance_id, worker_lease_expires_at
    INTO current_epoch, current_instance, current_lease
  FROM public.ddpe_bot_control WHERE owner_id = NEW.owner_id FOR SHARE;

  IF current_epoch IS NULL OR NEW.worker_epoch <> current_epoch
    OR (NEW.worker_instance_id IS NOT NULL AND
      (NEW.worker_instance_id IS DISTINCT FROM current_instance OR current_lease IS NULL OR current_lease <= NOW())) THEN
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
