#!/usr/bin/env node
/**
 * One-shot recovery for trades that were marked closed locally but are still
 * live at the broker (the "orphan" failure mode positionMonitor's symbol-
 * disappear used to produce before 1.1.46).
 *
 * Reverts the trade row to status='open' (clearing exit_* fields) AND rebuilds
 * the Redis position so positionMonitor picks it back up. Does NOT place any
 * order at the broker — the existing TT position is left alone.
 *
 * Usage:
 *   TRADE_ID=<uuid> node scripts/reopen-trade.js
 *
 * Required env: DATABASE_URL, REDIS_URL (Heroku already has these).
 */

const { Pool } = require('pg');
const Redis    = require('ioredis');

const TRADE_ID = process.env.TRADE_ID;
if (!TRADE_ID) {
  console.error('Set TRADE_ID env var to the uuid of the trade to recover');
  process.exit(2);
}

const pool  = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const redis = new Redis(process.env.REDIS_URL, {
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
});

// Expire the Redis position at midnight ET (matches addPosition's safety net).
function endOfDayUnix() {
  const now = new Date();
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  // Midnight tomorrow ET
  et.setHours(24, 0, 0, 0);
  // Convert back to UTC unix seconds
  const utcMs = et.getTime() - (et.getTime() - new Date(et.toLocaleString('en-US', { timeZone: 'America/New_York' })).getTime());
  return Math.floor(Date.now() / 1000) + 6 * 60 * 60; // 6 hours from now, safe upper bound
}

(async () => {
  const { rows } = await pool.query(
    `SELECT t.id, t.user_id, t.option_symbol, t.symbol, t.direction, t.quantity,
            t.entry_price, t.entry_time, t.tasty_order_id, t.stop_pct, t.tp_pct,
            t.exit_strategy, t.status, t.exit_price, t.exit_reason,
            tt.account_number
       FROM trades t
       LEFT JOIN tastytrade_tokens tt ON tt.user_id = t.user_id
      WHERE t.id = $1`,
    [TRADE_ID]
  );
  const row = rows[0];
  if (!row) {
    console.error(`No trade found with id ${TRADE_ID}`);
    process.exit(1);
  }

  console.log('Found trade:');
  console.log(`  user_id:        ${row.user_id}`);
  console.log(`  option_symbol:  ${row.option_symbol}`);
  console.log(`  status:         ${row.status}`);
  console.log(`  entry_price:    ${row.entry_price}`);
  console.log(`  exit_price:     ${row.exit_price}`);
  console.log(`  exit_reason:    ${row.exit_reason}`);
  console.log(`  tasty_order_id: ${row.tasty_order_id}`);
  console.log(`  account_number: ${row.account_number}`);

  if (row.status === 'open') {
    console.log('Trade is already status=open — only rebuilding Redis position.');
  }
  if (!row.account_number) {
    console.error('No TT account_number for this user — cannot rebuild Redis position.');
    process.exit(1);
  }

  // 1. DB: revert close fields
  await pool.query(
    `UPDATE trades SET
       status      = 'open',
       exit_price  = NULL,
       exit_time   = NULL,
       exit_reason = NULL,
       pnl         = NULL,
       peak_price  = NULL
     WHERE id = $1`,
    [TRADE_ID]
  );
  console.log('✓ DB row reverted to status=open (exit fields cleared)');

  // 2. Redis: rebuild position
  const entryPrice = parseFloat(row.entry_price);
  const position = {
    tradeId:       row.id,
    tastyOrderId:  row.tasty_order_id,
    complexOrderId: null,                // never got placed for this trade
    tpOrderId:     null,
    slOrderId:     null,
    stopOrderId:   null,
    tpPrice:       null,
    stopPrice:     null,
    optionSymbol:  row.option_symbol,
    symbol:        row.symbol,
    direction:     row.direction,
    quantity:      parseInt(row.quantity, 10),
    entryPrice:    entryPrice,
    peakPrice:     entryPrice,           // start peak at entry; monitor will advance
    accountNumber: row.account_number,
    openedAt:      row.entry_time ? new Date(row.entry_time).toISOString() : new Date().toISOString(),
    stopPct:       parseFloat(row.stop_pct) || 50,
    tpPct:         parseFloat(row.tp_pct)   || 60,
    exitStrategy:  row.exit_strategy || 'oco',
    userId:        row.user_id,
  };

  const key      = `position:${row.user_id}:${row.id}`;
  const indexKey = `positions:${row.user_id}`;
  await redis.set(key, JSON.stringify(position));
  await redis.sadd(indexKey, row.id);
  await redis.expireat(key, endOfDayUnix());
  console.log(`✓ Redis position rebuilt at ${key}`);
  console.log(`  entryPrice=$${entryPrice} qty=${position.quantity} exitStrategy=${position.exitStrategy}`);
  console.log('  No OCO leg ids stored — positionMonitor will fall back to its hard-stop check at -50% if price breaches.');

  await pool.end();
  await redis.quit();
  console.log('Done. Next monitor cycle (~5s) will pick it up.');
})().catch(err => {
  console.error('Recovery failed:', err);
  process.exit(1);
});
