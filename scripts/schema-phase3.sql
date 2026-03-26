-- ============================================================
-- TradePilot Schema — Phase 3 additions
-- Run: node scripts/migrate-phase3.js
-- Adds: strategies, user signal source, admin flag
-- ============================================================

-- ─── Add admin flag to users ─────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- ─── Add signal_source to user_settings ──────────────────────
-- 'custom'       = user's own webhook (Mode B)
-- strategy slug  = managed strategy e.g. 'dual-trend' (Mode A)
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS signal_source VARCHAR(50) DEFAULT 'custom';

-- ─── Strategies (managed by you via admin panel) ──────────────
CREATE TABLE IF NOT EXISTS strategies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(100) NOT NULL,
  slug           VARCHAR(50)  UNIQUE NOT NULL,
  description    TEXT,
  detail         TEXT,                        -- longer explanation shown to users
  source_type    VARCHAR(20)  DEFAULT 'tradingview', -- 'tradingview' | 'internal'
  webhook_secret VARCHAR(128),                -- secret token for YOUR TradingView alert
  tickers        TEXT[]       DEFAULT ARRAY['SPY','QQQ'],
  default_stop_pct     INTEGER DEFAULT 40,
  default_tp_pct       INTEGER DEFAULT 80,
  default_trailing_pct INTEGER DEFAULT 20,
  active         BOOLEAN      DEFAULT true,
  sort_order     INTEGER      DEFAULT 0,
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── Seed built-in strategies ────────────────────────────────
INSERT INTO strategies (name, slug, description, detail, tickers, sort_order)
VALUES
  (
    'Dual Trend',
    'dual-trend',
    'Calls and puts based on dual EMA crossover with volume confirmation.',
    'Uses a fast and slow EMA crossover combined with volume filters to identify high-probability directional moves on SPY and QQQ. Trades multiple times per day when conditions align.',
    ARRAY['SPY','QQQ'],
    1
  ),
  (
    'Daily Trend',
    'daily-trend',
    'Single directional trade based on morning trend structure.',
    'Reads the opening 30-minute range and places one trade per day in the direction of the dominant trend. Lower frequency, higher confidence setups.',
    ARRAY['SPY','QQQ'],
    2
  ),
  (
    'Breakout',
    'breakout',
    'Trades confirmed resistance breakouts and support breaks.',
    'Waits for price to close above key resistance or below key support with elevated volume before entering. Designed for trending days with strong momentum.',
    ARRAY['SPY','QQQ'],
    3
  ),
  (
    'Custom Webhook',
    'custom',
    'Use your own TradingView alerts or any signal source.',
    'Connect any signal source by pasting your personal webhook URL into TradingView or your own system. Full control over entry signals — TradePilot handles execution and risk management.',
    ARRAY['SPY','QQQ'],
    99
  )
ON CONFLICT (slug) DO NOTHING;

-- ─── Signal log (records every incoming signal + outcome) ─────
CREATE TABLE IF NOT EXISTS signal_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  strategy_slug VARCHAR(50),
  signal_type   VARCHAR(20),
  ticker        VARCHAR(10),
  action        VARCHAR(20),
  raw_payload   JSONB,
  outcome       VARCHAR(30),   -- 'trade_opened'|'skipped'|'error'
  outcome_detail TEXT,
  trade_id      UUID REFERENCES trades(id) ON DELETE SET NULL,
  received_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_log_user ON signal_log(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_log_strategy ON signal_log(strategy_slug);
