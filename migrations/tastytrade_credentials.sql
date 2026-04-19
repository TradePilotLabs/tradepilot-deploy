-- Add per-user client credentials to tastytrade_tokens
ALTER TABLE tastytrade_tokens
  ADD COLUMN IF NOT EXISTS client_id_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS client_secret_encrypted TEXT;
