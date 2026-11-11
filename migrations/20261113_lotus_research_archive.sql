-- Independent public-market research collector. Apply to the intended Neon branch after review.
-- Raw tick archives live as daily gzip-compressed JSONL on the OCI worker; Neon stores compact daily aggregates and health only.
CREATE TABLE IF NOT EXISTS public.ddpe_research_daily (
  owner_id text NOT NULL DEFAULT 'primary',
  trading_day date NOT NULL,
  symbol text NOT NULL,
  tick_count bigint NOT NULL DEFAULT 0 CHECK (tick_count >= 0),
  digit_counts jsonb NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0]'::jsonb,
  first_tick_epoch bigint NOT NULL,
  last_tick_epoch bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, trading_day, symbol),
  CHECK (jsonb_typeof(digit_counts) = 'array' AND jsonb_array_length(digit_counts) = 10)
);
CREATE INDEX IF NOT EXISTS ddpe_research_daily_symbol_day_idx
  ON public.ddpe_research_daily (owner_id, symbol, trading_day DESC);
CREATE TABLE IF NOT EXISTS public.ddpe_research_worker (
  owner_id text PRIMARY KEY DEFAULT 'primary',
  instance_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('CONNECTING','CONNECTED','DEGRADED','STOPPED')),
  connected_at timestamptz,
  last_tick_at timestamptz,
  total_ticks bigint NOT NULL DEFAULT 0,
  subscribed_symbols jsonb NOT NULL DEFAULT '[]'::jsonb,
  reconnect_count integer NOT NULL DEFAULT 0,
  last_error text,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);
