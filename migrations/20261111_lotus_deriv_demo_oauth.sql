-- Secure Deriv OAuth connection storage for the single Lotus owner.
-- Access tokens are encrypted by the application using AES-256-GCM before storage.
CREATE TABLE IF NOT EXISTS public.ddpe_deriv_oauth_states (
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ddpe_deriv_oauth_states_expiry_idx
  ON public.ddpe_deriv_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS public.ddpe_deriv_connections (
  owner_id text PRIMARY KEY,
  token_ciphertext text NOT NULL,
  token_iv text NOT NULL,
  token_tag text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  selected_demo_account_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
