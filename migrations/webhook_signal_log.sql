-- Logs every incoming webhook signal regardless of whether a trade was placed.
-- Used to reconstruct backtest data even when no users traded the signal.
CREATE TABLE IF NOT EXISTS webhook_signal_log (
  id            SERIAL PRIMARY KEY,
  strategy_slug VARCHAR(100)  NOT NULL,
  ticker        VARCHAR(10),
  direction     VARCHAR(10),
  option_symbol VARCHAR(100),
  signal_time   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  stock_price   DECIMAL(10,4),
  option_ask    DECIMAL(10,4),   -- option ask at signal time (fetched from TastyTrade)
  raw_payload   JSONB         NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wsl_slug ON webhook_signal_log(strategy_slug);
CREATE INDEX IF NOT EXISTS idx_wsl_time ON webhook_signal_log(signal_time);
