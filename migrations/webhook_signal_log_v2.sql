-- Expand webhook_signal_log with all signal detail columns
-- Run: heroku pg:psql --app tradepilot-ats < migrations/webhook_signal_log_v2.sql

ALTER TABLE webhook_signal_log
  ADD COLUMN IF NOT EXISTS signal_source    VARCHAR(100),   -- webhookTag from PineScript (may differ from strategy_slug)
  ADD COLUMN IF NOT EXISTS suggested_option VARCHAR(50),    -- e.g. "SPY 21/21 710p"
  ADD COLUMN IF NOT EXISTS action           VARCHAR(20),    -- open | close
  ADD COLUMN IF NOT EXISTS volume           INTEGER,        -- option volume at signal time
  ADD COLUMN IF NOT EXISTS stop_loss_pct    DECIMAL(6,2),   -- e.g. 50.0
  ADD COLUMN IF NOT EXISTS orb_high         DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS orb_low          DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS rsi              DECIMAL(6,2);

CREATE INDEX IF NOT EXISTS idx_wsl_source ON webhook_signal_log(signal_source);
