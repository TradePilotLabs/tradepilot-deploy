/**
 * One-off script: backfill exit prices for today's closed trades.
 *
 * Fetches all filled orders from TastyTrade for the day, matches "Sell to Close"
 * fills against today's closed trades by option symbol, then updates exit_price
 * and pnl in the DB.
 *
 * Run: heroku run node scripts/backfill-close-prices.js --app tradepilot-ats
 */

require('dotenv').config();
const { Pool }      = require('pg');
const axios         = require('axios');
const { decrypt }   = require('../src/services/encryption');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function getTastyTokens(userId) {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at, account_number,
            client_id_encrypted, client_secret_encrypted
     FROM tastytrade_tokens WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

async function refreshIfNeeded(tokens, userId) {
  // Refresh if expired or within 60s of expiry
  if (tokens.expires_at && new Date(tokens.expires_at) > new Date(Date.now() + 60000)) {
    return tokens.access_token;
  }
  const clientId     = decrypt(tokens.client_id_encrypted);
  const clientSecret = decrypt(tokens.client_secret_encrypted);
  if (!clientId || !clientSecret) throw new Error('Client credentials missing — reconnect TastyTrade in Brokers settings');
  const res = await axios.post('https://api.tastytrade.com/oauth/token',
    new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
      client_secret: clientSecret, refresh_token: tokens.refresh_token }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const { access_token, expires_in } = res.data;
  const expiresAt = new Date(Date.now() + expires_in * 1000);
  await pool.query(
    `UPDATE tastytrade_tokens SET access_token=$2, expires_at=$3 WHERE user_id=$1`,
    [userId, access_token, expiresAt]
  );
  console.log('  Token refreshed.');
  return access_token;
}

async function getTastyOrders(accessToken, accountNumber) {
  // Fetch ALL of today's orders (any status) so we can inspect what actually happened
  const today = new Date().toISOString().slice(0, 10);
  const url   = `https://api.tastytrade.com/accounts/${accountNumber}/orders?start-date=${today}`;
  const res   = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return res.data?.data?.items || [];
}

function extractFill(order) {
  const avg = parseFloat(order?.['avg-fill-price'] || 0);
  if (avg > 0) return avg;
  for (const leg of (order?.legs || [])) {
    for (const fill of (leg?.fills || [])) {
      const p = parseFloat(fill?.['fill-price'] || 0);
      if (p > 0) return p;
    }
  }
  return 0;
}

function calcPnl(entryPrice, exitPrice, quantity) {
  return parseFloat(((exitPrice - entryPrice) * quantity * 100).toFixed(2));
}

async function run() {
  // Get all users who had trades closed today
  const { rows: trades } = await pool.query(`
    SELECT id, user_id, option_symbol, entry_price, exit_price, pnl, quantity, complex_order_id, tasty_order_id
    FROM trades
    WHERE status = 'closed'
      AND DATE(exit_time) = CURRENT_DATE
      AND entry_price IS NOT NULL
    ORDER BY exit_time DESC
  `);

  if (!trades.length) {
    console.log('No closed trades found for today.');
    await pool.end();
    return;
  }

  console.log(`Found ${trades.length} closed trade(s) today. Fetching TastyTrade fill data...`);

  // Group by user
  const byUser = {};
  for (const t of trades) {
    if (!byUser[t.user_id]) byUser[t.user_id] = [];
    byUser[t.user_id].push(t);
  }

  for (const [userId, userTrades] of Object.entries(byUser)) {
    const tokens = await getTastyTokens(userId);
    if (!tokens?.access_token || !tokens?.account_number) {
      console.log(`  [user ${userId}] No TastyTrade tokens — skipping`);
      continue;
    }

    let accessToken;
    try { accessToken = await refreshIfNeeded(tokens, userId); }
    catch (err) { console.error(`  [user ${userId}] Token refresh failed: ${err.message}`); continue; }

    let orders = [];
    try {
      orders = await getTastyOrders(accessToken, tokens.account_number);
      console.log(`  [user ${userId}] Fetched ${orders.length} filled order(s) from TastyTrade`);
    } catch (err) {
      console.error(`  [user ${userId}] Failed to fetch orders: ${err.message}`);
      continue;
    }

    // Dump all orders so we can see what TastyTrade has
    console.log(`  All orders today:`);
    for (const o of orders) {
      const sym    = o.legs?.[0]?.symbol || '?';
      const action = o.legs?.[0]?.action || o.legs?.[0]?.['action-description'] || '?';
      const status = o.status || '?';
      const fill   = extractFill(o);
      console.log(`    [${status}] ${action} ${sym} fill=$${fill} id=${o.id}`);
    }

    // Build a map: optionSymbol → fill price (STC only)
    const fillMap = {};
    for (const o of orders) {
      const isStc = o.legs?.some(l =>
        l.action === 'Sell to Close' || l['action-description'] === 'Sell to Close'
      );
      if (!isStc) continue;
      const sym  = o.legs?.[0]?.symbol;
      const fill = extractFill(o);
      if (sym && fill > 0) {
        fillMap[sym] = fill;
        console.log(`    STC fill: ${sym} @ $${fill}`);
      }
    }

    // Update each trade where we have a fill
    for (const trade of userTrades) {
      const sym       = (trade.option_symbol || '').trim();
      const fillPrice = fillMap[sym];

      if (!fillPrice) {
        console.log(`  [${sym}] No STC fill found — skipping (current exit: $${trade.exit_price})`);
        continue;
      }

      if (Math.abs(fillPrice - parseFloat(trade.exit_price)) < 0.001) {
        console.log(`  [${sym}] Exit price already correct at $${fillPrice} — skipping`);
        continue;
      }

      const newPnl = calcPnl(parseFloat(trade.entry_price), fillPrice, parseInt(trade.quantity));
      const pnlDiff = newPnl - parseFloat(trade.pnl || 0);

      await pool.query(
        `UPDATE trades SET exit_price = $2, pnl = $3 WHERE id = $1`,
        [trade.id, fillPrice, newPnl]
      );

      // Adjust daily_pnl_summary
      await pool.query(
        `UPDATE daily_pnl_summary
            SET gross_pnl    = gross_pnl    + $2,
                net_pnl      = net_pnl      + $2,
                winning_trades = CASE WHEN $3 > 0 THEN winning_trades + 1
                                      WHEN $4 THEN GREATEST(winning_trades - 1, 0) ELSE winning_trades END,
                losing_trades  = CASE WHEN $3 < 0 THEN losing_trades  + 1
                                      WHEN $5 THEN GREATEST(losing_trades  - 1, 0) ELSE losing_trades  END
          WHERE user_id = $1 AND date = CURRENT_DATE`,
        [userId, pnlDiff, newPnl > 0, parseFloat(trade.pnl) > 0 && newPnl <= 0,
                                       parseFloat(trade.pnl) < 0 && newPnl >= 0]
      );

      console.log(`  ✓ [${sym}] Updated exit $${trade.exit_price} → $${fillPrice} | P&L: $${trade.pnl} → $${newPnl}`);
    }
  }

  console.log('\nBackfill complete.');
  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
