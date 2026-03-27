-- ============================================================
-- TradePilot V2 Schema — Phase 7
-- Run: node scripts/migrate-v2.js
-- Adds: subscriptions, broker_connections, license keys,
--       password reset, audit log, rate limiting
-- ============================================================

-- ─── Add columns to existing users table ─────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS license_key        VARCHAR(32) UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(100) UNIQUE,
  ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'inactive',
  ADD COLUMN IF NOT EXISTS subscription_id    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS trial_ends_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS plan               VARCHAR(20) DEFAULT 'elite',
  ADD COLUMN IF NOT EXISTS last_login_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_ip      VARCHAR(45),
  ADD COLUMN IF NOT EXISTS is_active          BOOLEAN DEFAULT true;

-- Generate license keys for existing users
UPDATE users
SET license_key = UPPER(SUBSTRING(MD5(id::text || RANDOM()::text), 1, 8)
  || '-' || SUBSTRING(MD5(id::text || RANDOM()::text), 1, 4)
  || '-' || SUBSTRING(MD5(id::text || RANDOM()::text), 1, 4)
  || '-' || SUBSTRING(MD5(id::text || RANDOM()::text), 1, 8))
WHERE license_key IS NULL;

-- ─── Broker connections ───────────────────────────────────────
-- One user can have multiple broker connections
-- TastyTrade uses OAuth tokens (stored in tastytrade_tokens)
-- Future brokers store encrypted API keys here
CREATE TABLE IF NOT EXISTS broker_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
  broker            VARCHAR(30) NOT NULL,     -- 'tastytrade' | 'webull' | 'alpaca'
  display_name      VARCHAR(100),             -- user-defined name e.g. "My TastyTrade"
  auth_type         VARCHAR(10) DEFAULT 'oauth', -- 'oauth' | 'apikey'
  -- For OAuth brokers: reference tastytrade_tokens table
  -- For API key brokers: store encrypted below
  api_key_encrypted TEXT,
  api_secret_encrypted TEXT,
  account_number    VARCHAR(50),
  status            VARCHAR(20) DEFAULT 'pending', -- 'active'|'invalid'|'disconnected'|'pending'
  is_primary        BOOLEAN DEFAULT false,
  last_validated_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, broker, account_number)
);

-- ─── Per broker-connection settings ──────────────────────────
-- Replaces user_settings for multi-broker support
-- Each broker connection has its own independent settings
CREATE TABLE IF NOT EXISTS broker_settings (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_connection_id   UUID UNIQUE REFERENCES broker_connections(id) ON DELETE CASCADE,
  user_id                UUID REFERENCES users(id) ON DELETE CASCADE,

  -- General
  trading_enabled        BOOLEAN DEFAULT false,
  order_type             VARCHAR(10) DEFAULT 'market',
  ticker_filter          VARCHAR(20) DEFAULT 'all',

  -- Strategy
  signal_source          VARCHAR(50) DEFAULT 'custom',
  alert_source           VARCHAR(100) DEFAULT 'Daily Trend',
  risk_allocation        INTEGER DEFAULT 100,
  max_capital_per_trade  DECIMAL(10,2) DEFAULT 250.00,
  max_trades_per_day     INTEGER DEFAULT 4,
  max_contract_cost      DECIMAL(6,2) DEFAULT 2.50,
  min_contract_cost      DECIMAL(6,2) DEFAULT 0.25,

  -- Risk
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

  -- Trailing
  trailing_enabled       BOOLEAN DEFAULT true,
  trailing_mode          VARCHAR(10) DEFAULT 'static',
  trailing_trigger_pct   INTEGER DEFAULT 4,
  trailing_pct           INTEGER DEFAULT 20,
  break_even_enabled     BOOLEAN DEFAULT false,
  multi_tier_enabled     BOOLEAN DEFAULT false,

  -- Schedule
  schedule               JSONB DEFAULT '{
    "Monday":    {"enabled": true, "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Tuesday":   {"enabled": true, "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Wednesday": {"enabled": true, "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Thursday":  {"enabled": true, "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]},
    "Friday":    {"enabled": true, "sessions": [{"from": "08:40 AM", "to": "02:45 PM"}]}
  }',

  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Add-ons (extra broker connections) ──────────────────────
CREATE TABLE IF NOT EXISTS add_ons (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID REFERENCES users(id) ON DELETE CASCADE,
  type                      VARCHAR(30) DEFAULT 'extra_broker',
  broker_connection_id      UUID REFERENCES broker_connections(id) ON DELETE SET NULL,
  stripe_subscription_item  VARCHAR(100),
  status                    VARCHAR(20) DEFAULT 'active',
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Password reset tokens ────────────────────────────────────
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token      VARCHAR(64) UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Audit log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action     VARCHAR(50) NOT NULL,   -- 'login'|'logout'|'trade_placed'|'settings_changed' etc
  detail     JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Rate limit tracking ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        VARCHAR(100) NOT NULL,  -- e.g. 'login:192.168.1.1' or 'signup:email@x.com'
  hits       INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(key)
);

-- ─── Email log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  type       VARCHAR(50),            -- 'welcome'|'password_reset'|'payment_failed' etc
  to_email   VARCHAR(255),
  subject    VARCHAR(255),
  status     VARCHAR(20) DEFAULT 'pending', -- 'sent'|'failed'
  provider_id VARCHAR(100),          -- Resend message ID
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Update trades table to support broker connections ────────
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS broker_connection_id UUID REFERENCES broker_connections(id) ON DELETE SET NULL;

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_broker_connections_user ON broker_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_broker_settings_conn    ON broker_settings(broker_connection_id);
CREATE INDEX IF NOT EXISTS idx_broker_settings_user    ON broker_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user          ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action        ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_password_reset_token    ON password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key         ON rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_email_log_user          ON email_log(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_license    ON users(license_key);
