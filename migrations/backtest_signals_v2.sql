-- Adds intraday session high/low columns fetched from Polygon.io
-- Used by backtest engine to accurately simulate TP/SL exits
ALTER TABLE backtest_signals
  ADD COLUMN IF NOT EXISTS session_high_ask  NUMERIC,
  ADD COLUMN IF NOT EXISTS session_low_ask   NUMERIC,
  ADD COLUMN IF NOT EXISTS session_high_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS session_low_time  TIMESTAMPTZ;
