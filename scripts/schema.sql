-- ============================================================
-- TradePilot Database Schema
-- Run: node scripts/migrate.js
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Users ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Webhook tokens (each user gets a unique webhook URL) ───
CREATE TABLE IF NOT EXISTS webhook_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── TastyTrade OAuth tokens per user ───────────────────────
CREATE TABLE IF NOT EXISTS tastytrade_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT,
  expires_at     TIMESTAMPTZ,
  account_number VARCHAR(50),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Per-user trading settings ──────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- General
  trading_enabled        BOOLEAN DEFAULT false,
  order_type             VARCHAR(10) DEFAULT 'market',
  ticker_filter          VARCHAR(20) DEFAULT 'all',

  -- Strategy
  alert_source           VARCHAR(100) DEFAULT 'Daily Trend',
  risk_allocation        INTEGER DEFAULT 100,
  max_capital_per_trade  DECIMAL(10,2) DEFAULT 250.00,
  max_trades_per_day     INTEGER DEFAULT 4,
  max_contract_cost      DECIMAL(6,2) DEFAULT 2.50,
  min_contract_cost      DECIMAL(6,2) DEFAULT 0.25,

  -- Risk / kill switch
  stop_loss_pct          INTEGER DEFAULT 40,
  kill_profit_enabled    BOOLEAN DEFAULT true,
  kill_profit_type       VARCHAR(1) DEFAULT '$',
  kill_profit_value      DECIMAL(10,2) DEFAULT 100,
  kill_loss_enabled      BOOLEAN DEFAULT false,
  kill_loss_type         VARCHAR(1) DEFAULT '$',
  kill_loss_value        DECIMAL(10,2) DEFAULT 300,
  unreal_profit_enabled  BOOLEAN DEFAULT true,
  unreal_profit_type     VARCHAR(1) DEFAULT '$',
  unreal_profit_value    DECIMAL(10,2) DEFAULT 600,
  unreal_loss_enabled    BOOLEAN DEFAULT false,
  unreal_loss_type       VARCHAR(1) DEFAULT '$',
  unreal_loss_value      DECIMAL(10,2) DEFAULT 400,

  -- Trailing stops
  trailing_enabled       BOOLEAN DEFAULT true,
  trailing_mode          VARCHAR(10) DEFAULT 'static',
  trailing_trigger_pct   INTEGER DEFAULT 4,
  trailing_pct           INTEGER DEFAULT 20,
  break_even_enabled     BOOLEAN DEFAULT false,
  multi_tier_enabled     BOOLEAN DEFAULT false,

  -- Schedule (JSON: { Monday: { enabled, sessions: [{from,to}] }, ... })
  schedule               JSONB DEFAULT '{
    "Monday":    {"enabled": true,  "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Tuesday":   {"enabled": true,  "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Wednesday": {"enabled": true,  "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Thursday":  {"enabled": true,  "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Friday":    {"enabled": true,  "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]}
  }',

  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Saved setting presets ──────────────────────────────────
CREATE TABLE IF NOT EXISTS setting_presets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  settings   JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Trades (full history log) ──────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  symbol          VARCHAR(10) NOT NULL,
  option_symbol   VARCHAR(60),
  direction       VARCHAR(5) NOT NULL,   -- 'calls' | 'puts'
  signal_type     VARCHAR(20),           -- 'A1' | 'B1' | 'C1' etc
  quantity        INTEGER NOT NULL,
  entry_price     DECIMAL(8,2),
  exit_price      DECIMAL(8,2),
  entry_time      TIMESTAMPTZ,
  exit_time       TIMESTAMPTZ,
  exit_reason     VARCHAR(30),           -- 'stop_loss'|'take_profit'|'trailing_stop'|'kill_switch'|'market_close'
  pnl             DECIMAL(10,2),
  status          VARCHAR(10) DEFAULT 'open',  -- 'open' | 'closed'
  tasty_order_id  VARCHAR(100),
  raw_signal      JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Daily P&L summary ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_pnl (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  date         DATE NOT NULL,
  total_pnl    DECIMAL(10,2) DEFAULT 0,
  trade_count  INTEGER DEFAULT 0,
  win_count    INTEGER DEFAULT 0,
  UNIQUE(user_id, date)
);

-- ─── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trades_user_id    ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_status     ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time DESC);
CREATE INDEX IF NOT EXISTS idx_daily_pnl_user    ON daily_pnl(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_token     ON webhook_tokens(token);
