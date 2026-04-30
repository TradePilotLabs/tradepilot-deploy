ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS max_active_trades          INTEGER,
  ADD COLUMN IF NOT EXISTS active_trade_time_limit    INTEGER,
  ADD COLUMN IF NOT EXISTS trailing_stop_multiplier   NUMERIC  DEFAULT 0.95,
  ADD COLUMN IF NOT EXISTS trailing_tiers             JSONB,
  ADD COLUMN IF NOT EXISTS limit_entry                BOOLEAN  DEFAULT false,
  ADD COLUMN IF NOT EXISTS order_fill_timeout         INTEGER  DEFAULT 3;
