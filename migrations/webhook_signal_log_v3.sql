-- Adds backtest enrichment columns directly to webhook_signal_log.
-- backtest_signals table is no longer needed after this migration.
ALTER TABLE webhook_signal_log
  ADD COLUMN IF NOT EXISTS session_high_ask  NUMERIC,
  ADD COLUMN IF NOT EXISTS session_low_ask   NUMERIC,
  ADD COLUMN IF NOT EXISTS session_high_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS session_low_time  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS exit_ask          NUMERIC;

DROP TABLE IF EXISTS backtest_signals;
