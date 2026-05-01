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

async function getUserByEmail(email) {
  const { rows } = await getPool().query(
    `SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]
  );
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await getPool().query(
    `SELECT id, email, name, is_admin, is_active, created_at,
            subscription_status, plan, license_key, trial_ends_at,
            stripe_customer_id, last_login_at
     FROM users WHERE id = $1`, [id]
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

async function saveTastyTokens(userId, { accessToken, refreshToken, expiresAt, accountNumber, clientIdEncrypted, clientSecretEncrypted }) {
  await getPool().query(
    `INSERT INTO tastytrade_tokens
       (user_id, access_token, refresh_token, expires_at, account_number, client_id_encrypted, client_secret_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token           = $2,
       refresh_token          = $3,
       expires_at             = $4,
       account_number         = COALESCE($5, tastytrade_tokens.account_number),
       client_id_encrypted    = COALESCE($6, tastytrade_tokens.client_id_encrypted),
       client_secret_encrypted= COALESCE($7, tastytrade_tokens.client_secret_encrypted),
       updated_at             = NOW()`,
    [userId, accessToken, refreshToken, expiresAt, accountNumber, clientIdEncrypted || null, clientSecretEncrypted || null]
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
  return !!t?.refresh_token;
}

// Returns the first admin user with a live TastyTrade connection — used for system-level quote fetches
async function getAnyTastyUserId() {
  const { rows } = await getPool().query(
    `SELECT tt.user_id FROM tastytrade_tokens tt
     JOIN users u ON u.id = tt.user_id
     WHERE tt.refresh_token IS NOT NULL
       AND u.is_active = true
     ORDER BY u.is_admin DESC, u.created_at ASC
     LIMIT 1`
  );
  return rows[0]?.user_id || null;
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

async function updateTradeEntryPrice(tradeId, entryPrice) {
  await getPool().query(
    `UPDATE trades SET entry_price = $2 WHERE id = $1 AND entry_price IS NULL`,
    [tradeId, entryPrice]
  );
}

async function updateComplexOrderId(tradeId, complexOrderId) {
  await getPool().query(
    `UPDATE trades SET complex_order_id=$2 WHERE id=$1`,
    [tradeId, complexOrderId]
  );
}

async function cancelTrade(tradeId) {
  await getPool().query(
    `UPDATE trades SET status='cancelled', exit_reason='order_not_filled', exit_time=NOW()
     WHERE id = $1 AND status = 'open'`,
    [tradeId]
  );
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
    `SELECT * FROM trades WHERE user_id = $1 AND status IN ('open','closed')
     ORDER BY entry_time DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows;
}

async function getTodayTradeCount(userId) {
  // Use Eastern Time date so the trading day boundary matches market hours
  const { rows } = await getPool().query(
    `SELECT COUNT(*) as count FROM trades
     WHERE user_id   = $1
       AND (entry_time AT TIME ZONE 'America/New_York')::date
             = (NOW() AT TIME ZONE 'America/New_York')::date
       AND status    != 'cancelled'
       AND entry_price IS NOT NULL`,
    [userId]
  );
  return parseInt(rows[0].count, 10);
}

async function getTodayRealizedPnl(userId) {
  const { rows } = await getPool().query(
    `SELECT COALESCE(SUM(pnl), 0) as total FROM trades
     WHERE user_id = $1
       AND status   = 'closed'
       AND (exit_time AT TIME ZONE 'America/New_York')::date
             = (NOW() AT TIME ZONE 'America/New_York')::date`,
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
            us.trailing_enabled, us.trailing_mode, us.trailing_trigger_pct,
            us.trailing_pct, us.break_even_enabled, us.multi_tier_enabled,
            us.trailing_stop_multiplier, us.trailing_tiers,
            us.max_active_trades, us.active_trade_time_limit,
            us.limit_entry, us.order_fill_timeout,
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

// ─── Updated createUser (with licenseKey) ────────────────────
async function createUser({ email, passwordHash, name, licenseKey }) {
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash, name, license_key, subscription_status, is_active)
     VALUES ($1, $2, $3, $4, 'inactive', true)
     RETURNING id, email, name, license_key, is_admin, subscription_status, plan`,
    [email.toLowerCase(), passwordHash, name, licenseKey || null]
  );
  return rows[0];
}

// ─── Password reset ───────────────────────────────────────────

async function createPasswordResetToken(userId, token, expiresAt) {
  // Invalidate any existing tokens for this user first
  await getPool().query(
    `UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false`,
    [userId]
  );
  await getPool().query(
    `INSERT INTO password_reset_tokens (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
}

async function getPasswordResetToken(token) {
  const { rows } = await getPool().query(
    `SELECT * FROM password_reset_tokens WHERE token = $1`, [token]
  );
  return rows[0] || null;
}

async function markPasswordResetTokenUsed(token) {
  await getPool().query(
    `UPDATE password_reset_tokens SET used = true WHERE token = $1`, [token]
  );
}

async function updateUserPassword(userId, passwordHash) {
  await getPool().query(
    `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
    [userId, passwordHash]
  );
}

async function updateUserLastLogin(userId, ip) {
  await getPool().query(
    `UPDATE users SET last_login_at = NOW(), last_login_ip = $2 WHERE id = $1`,
    [userId, ip]
  );
}

// ─── Subscription management ──────────────────────────────────

async function updateUserSubscription(userId, {
  stripeCustomerId, subscriptionId, subscriptionStatus, isActive, trialEndsAt
}) {
  const sets = [];
  const vals = [userId];
  let i = 2;
  if (stripeCustomerId  !== undefined) { sets.push(`stripe_customer_id = $${i++}`);  vals.push(stripeCustomerId); }
  if (subscriptionId    !== undefined) { sets.push(`subscription_id = $${i++}`);     vals.push(subscriptionId); }
  if (subscriptionStatus!== undefined) { sets.push(`subscription_status = $${i++}`); vals.push(subscriptionStatus); }
  if (isActive          !== undefined) { sets.push(`is_active = $${i++}`);           vals.push(isActive); }
  if (trialEndsAt       !== undefined) { sets.push(`trial_ends_at = $${i++}`);       vals.push(trialEndsAt); }
  if (!sets.length) return;
  await getPool().query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals
  );
}

async function getUserByStripeCustomer(stripeCustomerId) {
  const { rows } = await getPool().query(
    `SELECT * FROM users WHERE stripe_customer_id = $1`, [stripeCustomerId]
  );
  return rows[0] || null;
}

// ─── Broker connections ───────────────────────────────────────

async function getBrokerConnections(userId) {
  const { rows } = await getPool().query(
    `SELECT bc.*, bs.trading_enabled, bs.signal_source
     FROM broker_connections bc
     LEFT JOIN broker_settings bs ON bs.broker_connection_id = bc.id
     WHERE bc.user_id = $1
     ORDER BY bc.is_primary DESC, bc.created_at ASC`,
    [userId]
  );
  return rows;
}

async function getBrokerConnection(id, userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM broker_connections WHERE id = $1 AND user_id = $2`, [id, userId]
  );
  return rows[0] || null;
}

async function createBrokerConnection({
  userId, broker, displayName, authType,
  apiKeyEncrypted, apiSecretEncrypted, accountNumber, isPrimary
}) {
  const { rows } = await getPool().query(
    `INSERT INTO broker_connections
       (user_id, broker, display_name, auth_type,
        api_key_encrypted, api_secret_encrypted,
        account_number, is_primary, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
     RETURNING *`,
    [userId, broker, displayName, authType,
     apiKeyEncrypted, apiSecretEncrypted, accountNumber, isPrimary]
  );
  return rows[0];
}

async function updateBrokerConnection(id, updates) {
  const fields = Object.keys(updates);
  if (!fields.length) return;
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values    = fields.map(f => updates[f]);
  const { rows }  = await getPool().query(
    `UPDATE broker_connections SET ${setClause}, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return rows[0];
}

async function deleteBrokerConnection(id, userId) {
  await getPool().query(
    `DELETE FROM broker_connections WHERE id = $1 AND user_id = $2`, [id, userId]
  );
}

async function setPrimaryBroker(id, userId) {
  await getPool().query(
    `UPDATE broker_connections SET is_primary = false WHERE user_id = $1`, [userId]
  );
  await getPool().query(
    `UPDATE broker_connections SET is_primary = true WHERE id = $1`, [id]
  );
}

// ─── Broker settings ──────────────────────────────────────────

async function getBrokerSettings(brokerConnectionId) {
  const { rows } = await getPool().query(
    `SELECT * FROM broker_settings WHERE broker_connection_id = $1`,
    [brokerConnectionId]
  );
  return rows[0] || null;
}

async function upsertBrokerSettings(brokerConnectionId, userId, settings) {
  const existing = await getBrokerSettings(brokerConnectionId);
  if (!existing) {
    const { rows } = await getPool().query(
      `INSERT INTO broker_settings (broker_connection_id, user_id)
       VALUES ($1, $2) RETURNING *`,
      [brokerConnectionId, userId]
    );
    return rows[0];
  }
  const allowed = [
    'trading_enabled', 'order_type', 'ticker_filter',
    'signal_source', 'alert_source', 'risk_allocation',
    'max_capital_per_trade', 'max_trades_per_day',
    'max_contract_cost', 'min_contract_cost', 'stop_loss_pct',
    'kill_profit_enabled', 'kill_profit_type', 'kill_profit_value',
    'kill_loss_enabled', 'kill_loss_type', 'kill_loss_value',
    'unreal_profit_enabled', 'unreal_profit_type', 'unreal_profit_value',
    'unreal_loss_enabled', 'unreal_loss_type', 'unreal_loss_value',
    'trailing_enabled', 'trailing_mode', 'trailing_trigger_pct',
    'trailing_pct', 'break_even_enabled', 'multi_tier_enabled', 'schedule',
    'max_active_trades', 'active_trade_time_limit',
    'trailing_stop_multiplier', 'trailing_tiers',
    'limit_entry', 'order_fill_timeout',
  ];
  const updates = {};
  for (const key of allowed) {
    if (settings[key] !== undefined) updates[key] = settings[key];
  }
  if (!Object.keys(updates).length) return existing;
  const fields    = Object.keys(updates);
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values    = fields.map(f => updates[f]);
  const { rows }  = await getPool().query(
    `UPDATE broker_settings SET ${setClause}, updated_at = NOW()
     WHERE broker_connection_id = $1 RETURNING *`,
    [brokerConnectionId, ...values]
  );
  return rows[0];
}

// ─── Backtest signals (sourced directly from webhook_signal_log) ──────────────

async function getBacktestSignals({ strategySlug, from, to } = {}) {
  const conds = ['ticker IS NOT NULL', 'direction IS NOT NULL'];
  const vals  = [];
  if (strategySlug) { conds.push(`strategy_slug = $${vals.length+1}`); vals.push(strategySlug); }
  if (from)         { conds.push(`signal_time >= $${vals.length+1}`);  vals.push(from); }
  if (to)           { conds.push(`signal_time <= $${vals.length+1}`);  vals.push(to); }
  const { rows } = await getPool().query(
    `SELECT * FROM webhook_signal_log WHERE ${conds.join(' AND ')} ORDER BY signal_time ASC`, vals
  );
  return rows;
}

async function countBacktestSignals() {
  const { rows } = await getPool().query(
    `SELECT strategy_slug, COUNT(*) as count,
            MIN(signal_time) as earliest, MAX(signal_time) as latest
     FROM webhook_signal_log
     WHERE ticker IS NOT NULL AND direction IS NOT NULL
     GROUP BY strategy_slug ORDER BY strategy_slug`
  );
  return rows;
}


// ─── Webhook signal log ───────────────────────────────────────

async function logWebhookSignal({
  strategySlug, signalSource, ticker, direction, optionSymbol,
  suggestedOption, action, stockPrice, optionAsk,
  volume, stopLossPct, orbHigh, orbLow, rsi, rawPayload,
}) {
  await getPool().query(
    `INSERT INTO webhook_signal_log
       (strategy_slug, signal_source, ticker, direction, option_symbol,
        suggested_option, action, stock_price, option_ask,
        volume, stop_loss_pct, orb_high, orb_low, rsi, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      strategySlug,
      signalSource   || null,
      ticker         || null,
      direction      || null,
      optionSymbol   || null,
      suggestedOption|| null,
      action         || null,
      stockPrice     || null,
      optionAsk      || null,
      volume         ? parseInt(volume) : null,
      stopLossPct    ? parseFloat(stopLossPct) : null,
      orbHigh        ? parseFloat(orbHigh) : null,
      orbLow         ? parseFloat(orbLow)  : null,
      rsi            ? parseFloat(rsi)     : null,
      JSON.stringify(rawPayload),
    ]
  );
}

async function getWebhookSignalLogs({ slug, limit = 200, offset = 0 } = {}) {
  const where  = slug ? `WHERE strategy_slug = $3` : '';
  const values = slug ? [limit, offset, slug] : [limit, offset];
  const { rows } = await getPool().query(
    `SELECT * FROM webhook_signal_log ${where}
     ORDER BY signal_time DESC LIMIT $1 OFFSET $2`,
    values
  );
  return rows;
}

async function countWebhookSignalLogs() {
  const { rows } = await getPool().query(
    `SELECT strategy_slug, COUNT(*) as count,
            MIN(signal_time) as from, MAX(signal_time) as to
     FROM webhook_signal_log GROUP BY strategy_slug ORDER BY strategy_slug`
  );
  return rows;
}

// ─── Backtest presets ─────────────────────────────────────────

async function saveBacktestPreset(userId, name, settings) {
  const { rows } = await getPool().query(
    `INSERT INTO backtest_presets (user_id, name, settings) VALUES ($1,$2,$3) RETURNING *`,
    [userId, name, JSON.stringify(settings)]
  );
  return rows[0];
}

async function getBacktestPresets(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM backtest_presets WHERE user_id = $1 ORDER BY created_at DESC`, [userId]
  );
  return rows;
}

async function deleteBacktestPreset(userId, id) {
  await getPool().query(
    `DELETE FROM backtest_presets WHERE id = $1 AND user_id = $2`, [id, userId]
  );
}

// ─── Audit log ────────────────────────────────────────────────

async function logAudit({ userId, action, detail, ip, userAgent }) {
  await getPool().query(
    `INSERT INTO audit_log (user_id, action, detail, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId || null, action, JSON.stringify(detail || {}), ip, userAgent]
  ).catch(e => console.error('Audit log error:', e.message));
}

module.exports = {
  connectDB, getPool,
  // Users
  createUser, getUserByEmail, getUserById,
  // Webhook tokens
  createWebhookToken, getUserByWebhookToken, getWebhookToken,
  // TastyTrade
  saveTastyTokens, getTastyTokens, updateTastyAccessToken, isTastyConnected, getAnyTastyUserId,
  // Settings
  getOrCreateSettings, updateSettings,
  // Trades
  createTrade, closeTrade, cancelTrade, updateTradeEntryPrice, updateComplexOrderId, getOpenTrades, getTradeHistory,
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
  // User Management
  createPasswordResetToken, getPasswordResetToken,
  markPasswordResetTokenUsed, updateUserPassword,
  updateUserLastLogin, updateUserSubscription,
  getUserByStripeCustomer,
  getBrokerConnections, getBrokerConnection,
  createBrokerConnection, updateBrokerConnection,
  deleteBrokerConnection, setPrimaryBroker,
  getBrokerSettings, upsertBrokerSettings,
  logAudit,
  // Backtest
  getBacktestSignals, countBacktestSignals,
  saveBacktestPreset, getBacktestPresets, deleteBacktestPreset,
  // Webhook signal log
  logWebhookSignal, getWebhookSignalLogs, countWebhookSignalLogs,
};
