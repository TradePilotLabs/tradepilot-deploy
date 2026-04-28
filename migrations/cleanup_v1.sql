-- Remove columns that were added speculatively but are not needed.
-- Backtest bars are fetched live from Polygon on each run, not stored.
ALTER TABLE webhook_signal_log
  DROP COLUMN IF EXISTS session_high_ask,
  DROP COLUMN IF EXISTS session_low_ask,
  DROP COLUMN IF EXISTS session_high_time,
  DROP COLUMN IF EXISTS session_low_time,
  DROP COLUMN IF EXISTS exit_ask;

-- Never referenced anywhere in application code
DROP TABLE IF EXISTS add_ons;
