-- DDPE data-integrity migration 002
-- Preserve distinct market ticks and paper choices that share the same Unix second.
-- Apply after 001_ddpe_core.sql using the SQL editor's normal Run action.
-- Do not submit this file through EXPLAIN / Explain Analyze.

ALTER TABLE public.ddpe_ticks
  ADD COLUMN IF NOT EXISTS tick_uid TEXT;

UPDATE public.ddpe_ticks
SET tick_uid = 'legacy:' || id::TEXT
WHERE tick_uid IS NULL;

ALTER TABLE public.ddpe_ticks
  ALTER COLUMN tick_uid SET NOT NULL;

ALTER TABLE public.ddpe_ticks
  DROP CONSTRAINT IF EXISTS ddpe_ticks_owner_id_symbol_tick_epoch_key;

CREATE UNIQUE INDEX IF NOT EXISTS ddpe_ticks_owner_symbol_uid_key
  ON public.ddpe_ticks (owner_id, symbol, tick_uid);

CREATE INDEX IF NOT EXISTS ddpe_ticks_owner_symbol_epoch_id_idx
  ON public.ddpe_ticks (owner_id, symbol, tick_epoch DESC, id DESC);

ALTER TABLE public.ddpe_prediction_choices
  ADD COLUMN IF NOT EXISTS choice_uid TEXT;

UPDATE public.ddpe_prediction_choices
SET choice_uid = 'legacy:' || id::TEXT
WHERE choice_uid IS NULL;

ALTER TABLE public.ddpe_prediction_choices
  ALTER COLUMN choice_uid SET NOT NULL;

ALTER TABLE public.ddpe_prediction_choices
  DROP CONSTRAINT IF EXISTS ddpe_prediction_choices_owner_id_symbol_predicted_at_epoch_key;

CREATE UNIQUE INDEX IF NOT EXISTS ddpe_choices_owner_uid_key
  ON public.ddpe_prediction_choices (owner_id, choice_uid);

CREATE INDEX IF NOT EXISTS ddpe_choices_owner_symbol_settled_id_idx
  ON public.ddpe_prediction_choices (owner_id, symbol, settled_at_epoch DESC, id DESC)
  WHERE is_correct IS NOT NULL;

-- A one-tick paper outcome may settle in the same Unix second as its prediction.
DO $$
DECLARE
  check_name TEXT;
BEGIN
  FOR check_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.ddpe_prediction_choices'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%settled_at_epoch > predicted_at_epoch%'
  LOOP
    EXECUTE format('ALTER TABLE public.ddpe_prediction_choices DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

ALTER TABLE public.ddpe_prediction_choices
  DROP CONSTRAINT IF EXISTS ddpe_choices_settlement_order_check;

ALTER TABLE public.ddpe_prediction_choices
  ADD CONSTRAINT ddpe_choices_settlement_order_check
  CHECK (
    (settled_at_epoch IS NULL AND outcome_digit IS NULL AND is_correct IS NULL)
    OR
    (settled_at_epoch IS NOT NULL AND outcome_digit IS NOT NULL AND is_correct IS NOT NULL
      AND settled_at_epoch >= predicted_at_epoch)
  );

CREATE TABLE IF NOT EXISTS public.ddpe_login_limits (
  attempt_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
