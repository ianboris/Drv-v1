-- Idempotent archive ledger. Apply only to the Lotus Neon staging branch.
CREATE TABLE IF NOT EXISTS public.ddpe_research_batches (
  batch_id text PRIMARY KEY,
  checksum text NOT NULL,
  archive_file text NOT NULL,
  tick_count integer NOT NULL CHECK (tick_count > 0),
  first_tick_epoch bigint NOT NULL,
  last_tick_epoch bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ddpe_research_batches_committed_idx
  ON public.ddpe_research_batches (committed_at DESC);
