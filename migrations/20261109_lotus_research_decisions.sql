ALTER TABLE public.ddpe_settings
  ADD COLUMN IF NOT EXISTS take_profit_limit numeric(12,2) NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS public.ddpe_research_decisions (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL,
  decision_uid text NOT NULL,
  symbol text NOT NULL CHECK (symbol ~ '^[A-Za-z0-9_]{1,32}$'),
  strategy text NOT NULL CHECK (strategy IN ('DIFFERS','MATCHES')),
  target_digit smallint NOT NULL CHECK (target_digit BETWEEN 0 AND 9),
  predicted_at_epoch bigint NOT NULL,
  settled_at_epoch bigint,
  outcome_digit smallint CHECK (outcome_digit BETWEEN 0 AND 9),
  is_correct boolean,
  analysis_window integer NOT NULL CHECK (analysis_window BETWEEN 50 AND 5000),
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  empirical_rate numeric(8,6) NOT NULL CHECK (empirical_rate >= 0 AND empirical_rate <= 1),
  model_version text NOT NULL DEFAULT 'frequency-baseline-v1',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, decision_uid),
  CHECK ((settled_at_epoch IS NULL AND outcome_digit IS NULL AND is_correct IS NULL)
      OR (settled_at_epoch > predicted_at_epoch AND outcome_digit IS NOT NULL AND is_correct IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ddpe_research_owner_strategy_settled_idx
  ON public.ddpe_research_decisions (owner_id, strategy, settled_at_epoch DESC);
CREATE INDEX IF NOT EXISTS ddpe_research_owner_symbol_idx
  ON public.ddpe_research_decisions (owner_id, symbol, predicted_at_epoch DESC);
