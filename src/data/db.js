const { Pool } = require('pg');

let pool;

function connectDB() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => console.error('Postgres error:', err.message));
  console.log('✓ Postgres connected');
  return pool;
}

function getPool() {
  if (!pool) throw new Error('DB not initialised — call connectDB() first');
  return pool;
}

// ─── Users ────────────────────────────────────────────────────

async function createUser({ email, passwordHash, name }) {
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3) RETURNING id, email, name, created_at`,
    [email.toLowerCase(), passwordHash, name]
  );
  return rows[0];
}

async function getUserByEmail(email) {
  const { rows } = await getPool().query(
    `SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await getPool().query(
    `SELECT id, email, name, is_admin, created_at FROM users WHERE id = $1`, [id]
  );
  return rows[0] || null;
}

// ─── Webhook tokens ───────────────────────────────────────────

async function createWebhookToken(userId) {
  const { randomBytes } = require('crypto');
  const token = randomBytes(32).toString('hex');
  await getPool().query(
    `INSERT INTO webhook_tokens (user_id, token) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET token = $2`,
    [userId, token]
  );
  return token;
}

async function getUserByWebhookToken(token) {
  const { rows } = await getPool().query(
    `SELECT u.id, u.email, u.name
     FROM users u
     JOIN webhook_tokens wt ON wt.user_id = u.id
     WHERE wt.token = $1`,
    [token]
  );
  return rows[0] || null;
}

async function getWebhookToken(userId) {
  const { rows } = await getPool().query(
    `SELECT token FROM webhook_tokens WHERE user_id = $1`, [userId]
  );
  return rows[0]?.token || null;
}

// ─── TastyTrade tokens ────────────────────────────────────────

async function saveTastyTokens(userId, { accessToken, refreshToken, expiresAt, accountNumber }) {
  await getPool().query(
    `INSERT INTO tastytrade_tokens (user_id, access_token, refresh_token, expires_at, account_number)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token   = $2,
       refresh_token  = $3,
       expires_at     = $4,
       account_number = COALESCE($5, tastytrade_tokens.account_number),
       updated_at     = NOW()`,
    [userId, accessToken, refreshToken, expiresAt, accountNumber]
  );
}

async function getTastyTokens(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM tastytrade_tokens WHERE user_id = $1`, [userId]
  );
  return rows[0] || null;
}

async function updateTastyAccessToken(userId, accessToken, expiresAt) {
  await getPool().query(
    `UPDATE tastytrade_tokens
     SET access_token = $2, expires_at = $3, updated_at = NOW()
     WHERE user_id = $1`,
    [userId, accessToken, expiresAt]
  );
}

async function isTastyConnected(userId) {
  const t = await getTastyTokens(userId);
  return !!t?.access_token;
}

// ─── User settings ────────────────────────────────────────────

async function getOrCreateSettings(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM user_settings WHERE user_id = $1`, [userId]
  );
  if (rows[0]) return rows[0];
  const { rows: created } = await getPool().query(
    `INSERT INTO user_settings (user_id) VALUES ($1) RETURNING *`, [userId]
  );
  return created[0];
}

async function updateSettings(userId, settings) {
  const fields = Object.keys(settings);
  if (fields.length === 0) return;
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values    = fields.map(f => settings[f]);
  await getPool().query(
    `UPDATE user_settings SET ${setClause}, updated_at = NOW() WHERE user_id = $1`,
    [userId, ...values]
  );
}

// ─── Trades ───────────────────────────────────────────────────

async function createTrade(data) {
  const { rows } = await getPool().query(
    `INSERT INTO trades
       (user_id, symbol, option_symbol, direction, signal_type,
        quantity, entry_price, entry_time, status, tasty_order_id, raw_signal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),'open',$8,$9)
     RETURNING *`,
    [data.userId, data.symbol, data.optionSymbol, data.direction,
     data.signalType, data.quantity, data.entryPrice,
     data.tastyOrderId, JSON.stringify(data.rawSignal)]
  );
  return rows[0];
}

async function closeTrade(tradeId, { exitPrice, exitReason, pnl }) {
  await getPool().query(
    `UPDATE trades SET
       exit_price = $2, exit_reason = $3, pnl = $4,
       exit_time  = NOW(), status = 'closed'
     WHERE id = $1`,
    [tradeId, exitPrice, exitReason, pnl]
  );
  const { rows } = await getPool().query(
    `SELECT user_id FROM trades WHERE id = $1`, [tradeId]
  );
  if (rows[0]) await upsertDailyPnl(rows[0].user_id, pnl, pnl > 0);
}

async function getOpenTrades(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM trades WHERE user_id = $1 AND status = 'open'
     ORDER BY entry_time DESC`,
    [userId]
  );
  return rows;
}

async function getTradeHistory(userId, limit = 50, offset = 0) {
  const { rows } = await getPool().query(
    `SELECT * FROM trades WHERE user_id = $1
     ORDER BY entry_time DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function getTodayTradeCount(userId) {
  const { rows } = await getPool().query(
    `SELECT COUNT(*) as count FROM trades
     WHERE user_id = $1
       AND entry_time >= CURRENT_DATE
       AND entry_time <  CURRENT_DATE + INTERVAL '1 day'`,
    [userId]
  );
  return parseInt(rows[0].count, 10);
}

async function getTodayRealizedPnl(userId) {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(pnl), 0) as total FROM trades
     WHERE user_id = $1
       AND status   = 'closed'
       AND exit_time >= CURRENT_DATE`,
    [userId]
  );
  return parseFloat(rows[0].total);
}

// ─── Daily P&L ────────────────────────────────────────────────

async function upsertDailyPnl(userId, pnl, isWin) {
  await getPool().query(
    `INSERT INTO daily_pnl (user_id, date, total_pnl, trade_count, win_count)
     VALUES ($1, CURRENT_DATE, $2, 1, $3)
     ON CONFLICT (user_id, date) DO UPDATE SET
       total_pnl   = daily_pnl.total_pnl   + $2,
       trade_count = daily_pnl.trade_count  + 1,
       win_count   = daily_pnl.win_count    + $3`,
    [userId, pnl, isWin ? 1 : 0]
  );
}

async function getDailyPnlHistory(userId, days = 30) {
  const { rows } = await getPool().query(
    `SELECT * FROM daily_pnl WHERE user_id = $1
     ORDER BY date DESC LIMIT $2`,
    [userId, days]
  );
  return rows;
}

// ─── Setting presets ──────────────────────────────────────────

async function savePreset(userId, name, settings) {
  const { rows } = await getPool().query(
    `INSERT INTO setting_presets (user_id, name, settings)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, name, JSON.stringify(settings)]
  );
  return rows[0];
}

async function getPresets(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM setting_presets WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function deletePreset(userId, presetId) {
  await getPool().query(
    `DELETE FROM setting_presets WHERE id = $1 AND user_id = $2`,
    [presetId, userId]
  );
}

// ─── Strategies ───────────────────────────────────────────────

async function getStrategies(activeOnly = true) {
  const { rows } = await getPool().query(
    `SELECT * FROM strategies
     ${activeOnly ? 'WHERE active = true' : ''}
     ORDER BY sort_order ASC, name ASC`
  );
  return rows;
}

async function getStrategyBySlug(slug) {
  const { rows } = await getPool().query(
    `SELECT * FROM strategies WHERE slug = $1`, [slug]
  );
  return rows[0] || null;
}

async function createStrategy(data) {
  const { rows } = await getPool().query(
    `INSERT INTO strategies
       (name, slug, description, detail, source_type, webhook_secret,
        tickers, default_stop_pct, default_tp_pct, default_trailing_pct,
        active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      data.name, data.slug, data.description, data.detail,
      data.source_type    || 'tradingview',
      data.webhook_secret || null,
      data.tickers        || ['SPY', 'QQQ'],
      data.default_stop_pct      || 40,
      data.default_tp_pct        || 80,
      data.default_trailing_pct  || 20,
      data.active !== false,
      data.sort_order || 0,
    ]
  );
  return rows[0];
}

async function updateStrategy(id, data) {
  const fields = Object.keys(data);
  if (!fields.length) return;
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values    = fields.map(f => data[f]);
  const { rows }  = await getPool().query(
    `UPDATE strategies SET ${setClause}, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

async function deleteStrategy(id) {
  await getPool().query(`DELETE FROM strategies WHERE id = $1`, [id]);
}

async function getUsersOnStrategy(slug) {
  const { rows } = await getPool().query(
    `SELECT u.id, u.email, u.name,
            us.trading_enabled, us.ticker_filter,
            us.max_capital_per_trade, us.max_trades_per_day,
            us.max_contract_cost, us.min_contract_cost,
            us.stop_loss_pct, us.order_type, us.schedule,
            us.trailing_enabled, us.trailing_trigger_pct,
            us.trailing_pct, us.break_even_enabled,
            us.kill_profit_enabled, us.kill_profit_type, us.kill_profit_value,
            us.kill_loss_enabled,   us.kill_loss_type,   us.kill_loss_value,
            us.unreal_profit_enabled, us.unreal_profit_type, us.unreal_profit_value,
            us.unreal_loss_enabled,   us.unreal_loss_type,   us.unreal_loss_value
     FROM users u
     JOIN user_settings us ON us.user_id = u.id
     WHERE us.signal_source = $1
       AND us.trading_enabled = true`,
    [slug]
  );
  return rows;
}

// ─── Signal log ───────────────────────────────────────────────

async function logSignal({ userId, strategySlug, signalType, ticker,
                            action, rawPayload, outcome, outcomeDetail, tradeId }) {
  await getPool().query(
    `INSERT INTO signal_log
       (user_id, strategy_slug, signal_type, ticker, action,
        raw_payload, outcome, outcome_detail, trade_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, strategySlug, signalType, ticker, action,
     JSON.stringify(rawPayload), outcome, outcomeDetail, tradeId || null]
  );
}

async function getSignalLog(userId, limit = 50) {
  const { rows } = await getPool().query(
    `SELECT * FROM signal_log WHERE user_id = $1
     ORDER BY received_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// ─── Admin ────────────────────────────────────────────────────

async function getAllUsers(limit = 100, offset = 0) {
  const { rows } = await getPool().query(
    `SELECT u.id, u.email, u.name, u.is_admin, u.created_at,
            us.trading_enabled, us.signal_source,
            tt.account_number,
            (SELECT COUNT(*)          FROM trades t WHERE t.user_id = u.id) as trade_count,
            (SELECT COALESCE(SUM(pnl),0) FROM trades t
             WHERE t.user_id = u.id AND t.status = 'closed')                as total_pnl
     FROM users u
     LEFT JOIN user_settings      us ON us.user_id = u.id
     LEFT JOIN tastytrade_tokens  tt ON tt.user_id = u.id
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function setAdminFlag(userId, isAdmin) {
  await getPool().query(
    `UPDATE users SET is_admin = $2 WHERE id = $1`, [userId, isAdmin]
  );
}

module.exports = {
  connectDB, getPool,
  // Users
  createUser, getUserByEmail, getUserById,
  // Webhook tokens
  createWebhookToken, getUserByWebhookToken, getWebhookToken,
  // TastyTrade
  saveTastyTokens, getTastyTokens, updateTastyAccessToken, isTastyConnected,
  // Settings
  getOrCreateSettings, updateSettings,
  // Trades
  createTrade, closeTrade, getOpenTrades, getTradeHistory,
  getTodayTradeCount, getTodayRealizedPnl,
  // P&L
  upsertDailyPnl, getDailyPnlHistory,
  // Presets
  savePreset, getPresets, deletePreset,
  // Strategies
  getStrategies, getStrategyBySlug, createStrategy,
  updateStrategy, deleteStrategy, getUsersOnStrategy,
  // Signal log
  logSignal, getSignalLog,
  // Admin
  getAllUsers, setAdminFlag,
};
