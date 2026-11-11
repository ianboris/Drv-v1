-- Tick-level idempotency across overlapping reconnect backfills and differently-sized batches.
-- Apply only to the Lotus Neon staging branch.
CREATE TABLE IF NOT EXISTS public.ddpe_research_tick_ids (
  symbol text NOT NULL,
  tick_uid text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, tick_uid)
);
