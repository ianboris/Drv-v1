-- DDPE market-scanner account-currency migration 003
-- Apply after 001_ddpe_core.sql and 002_tick_and_choice_identity.sql.
-- Apply using the SQL editor's normal Run action, not EXPLAIN.

ALTER TABLE public.ddpe_settings
  ADD COLUMN IF NOT EXISTS account_currency TEXT;

ALTER TABLE public.ddpe_settings
  DROP CONSTRAINT IF EXISTS ddpe_settings_account_currency_check;

ALTER TABLE public.ddpe_settings
  ADD CONSTRAINT ddpe_settings_account_currency_check
  CHECK (account_currency IS NULL OR account_currency ~ '^[A-Z0-9]{2,20}$');

CREATE INDEX IF NOT EXISTS ddpe_choices_owner_symbol_barrier_settled_idx
  ON public.ddpe_prediction_choices (owner_id, symbol, barrier_digit, settled_at_epoch DESC)
  WHERE is_correct IS NOT NULL;
