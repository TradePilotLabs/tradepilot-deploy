-- Backtest feature migration
-- Run once against your Postgres database

-- System-level historical signal records (admin-seeded)
-- Each row = one signal that fired, with the actual outcome recorded
CREATE TABLE IF NOT EXISTS backtest_signals (
  id            SERIAL PRIMARY KEY,
  strategy_slug VARCHAR(100)   NOT NULL,
  ticker        VARCHAR(10)    NOT NULL,       -- SPY, QQQ
  direction     VARCHAR(10)    NOT NULL,       -- call, put
  signal_time   TIMESTAMPTZ    NOT NULL,       -- when the signal arrived
  exit_time     TIMESTAMPTZ    NOT NULL,       -- when the trade actually closed
  ask_price     DECIMAL(10,4)  NOT NULL,       -- option ask at entry (what was filled)
  exit_ask      DECIMAL(10,4),                 -- actual exit ask (used for market_close/time_limit)
  outcome       VARCHAR(20)    NOT NULL,       -- take_profit | stop_loss | market_close | time_limit
  option_symbol VARCHAR(50),                   -- e.g. SPY  231003C00430000
  created_at    TIMESTAMPTZ    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bt_signals_slug ON backtest_signals(strategy_slug);
CREATE INDEX IF NOT EXISTS idx_bt_signals_time ON backtest_signals(signal_time);
CREATE INDEX IF NOT EXISTS idx_bt_signals_ticker ON backtest_signals(ticker);

-- Per-user saved backtest configurations
CREATE TABLE IF NOT EXISTS backtest_presets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(100)   NOT NULL,
  settings   JSONB          NOT NULL,
  created_at TIMESTAMPTZ    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bt_presets_user ON backtest_presets(user_id);
