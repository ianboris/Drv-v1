-- DDPE data-integrity migration 002
-- Preserve multiple market ticks and paper choices that share the same second.
-- Safe to apply after 001; backfills stable IDs for rows already stored.

ALTER TABLE ddpe_ticks
  ADD COLUMN IF NOT EXISTS tick_uid TEXT;

UPDATE ddpe_ticks
SET tick_uid = 'legacy:' || id::TEXT
WHERE tick_uid IS NULL;

ALTER TABLE ddpe_ticks
  ALTER COLUMN tick_uid SET NOT NULL;

ALTER TABLE ddpe_ticks
  DROP CONSTRAINT IF EXISTS ddpe_ticks_owner_id_symbol_tick_epoch_key;

CREATE UNIQUE INDEX IF NOT EXISTS ddpe_ticks_owner_symbol_uid_key
  ON ddpe_ticks (owner_id, symbol, tick_uid);

CREATE INDEX IF NOT EXISTS ddpe_ticks_owner_symbol_epoch_id_idx
  ON ddpe_ticks (owner_id, symbol, tick_epoch DESC, id DESC);


ALTER TABLE ddpe_prediction_choices
  ADD COLUMN IF NOT EXISTS choice_uid TEXT;

UPDATE ddpe_prediction_choices
SET choice_uid = 'legacy:' || id::TEXT
WHERE choice_uid IS NULL;

ALTER TABLE ddpe_prediction_choices
  ALTER COLUMN choice_uid SET NOT NULL;

ALTER TABLE ddpe_prediction_choices
  DROP CONSTRAINT IF EXISTS ddpe_prediction_choices_owner_id_symbol_predicted_at_epoch_key;

CREATE UNIQUE INDEX IF NOT EXISTS ddpe_choices_owner_uid_key
  ON ddpe_prediction_choices (owner_id, choice_uid);

CREATE INDEX IF NOT EXISTS ddpe_choices_owner_symbol_settled_id_idx
  ON ddpe_prediction_choices (owner_id, symbol, settled_at_epoch DESC, id DESC)
  WHERE is_correct IS NOT NULL;

-- A one-tick paper outcome can settle in the same Unix second as its prediction.
DO $$
DECLARE
  check_name TEXT;
BEGIN
  FOR check_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'ddpe_prediction_choices'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%settled_at_epoch > predicted_at_epoch%'
  LOOP
    EXECUTE format('ALTER TABLE ddpe_prediction_choices DROP CONSTRAINT %I', check_name);
  END LOOP;
END $$;

ALTER TABLE ddpe_prediction_choices
  ADD CONSTRAINT ddpe_choices_settlement_order_check
  CHECK (
    (settled_at_epoch IS NULL AND outcome_digit IS NULL AND is_correct IS NULL)
    OR
    (settled_at_epoch IS NOT NULL AND outcome_digit IS NOT NULL AND is_correct IS NOT NULL
      AND settled_at_epoch >= predicted_at_epoch)
  );
