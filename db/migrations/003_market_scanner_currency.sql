-- DDPE market-scanner account-currency migration 003
-- Run after migrations 001 and 002. This enables account-currency-specific
-- proposal quotes; a blank value means profitability cannot be calculated.

ALTER TABLE ddpe_settings
  ADD COLUMN IF NOT EXISTS account_currency TEXT;

ALTER TABLE ddpe_settings
  DROP CONSTRAINT IF EXISTS ddpe_settings_account_currency_check;

ALTER TABLE ddpe_settings
  ADD CONSTRAINT ddpe_settings_account_currency_check
  CHECK (account_currency IS NULL OR account_currency ~ '^[A-Z0-9]{2,20}$');
