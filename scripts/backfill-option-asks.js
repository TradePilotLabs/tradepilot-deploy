/**
 * One-time backfill: fetch option ask prices from Polygon for signals
 * that were logged before Polygon was connected (option_ask is null).
 *
 * Run with:
 *   heroku run node scripts/backfill-option-asks.js --app tradepilot-ats
 *
 * Requires POLYGON_API_KEY and DATABASE_URL to be set as config vars.
 */

const { Pool } = require('pg');
const axios    = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const POLYGON_BASE = 'https://api.polygon.io';
const API_KEY      = process.env.POLYGON_API_KEY;

if (!API_KEY) {
  console.error('POLYGON_API_KEY is not set');
  process.exit(1);
}

// "SPY260423C560.0" → "O:SPY260423C00560000"
function toPolygonSymbol(tvSymbol) {
  const m = tvSymbol?.match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const [, root, date, type, strikeStr] = m;
  const strike = Math.round(parseFloat(strikeStr) * 1000);
  return `O:${root}${date}${type.toUpperCase()}${String(strike).padStart(8, '0')}`;
}

async function fetchAskAtTime(polygonSym, signalTimeMs) {
  const date = new Date(signalTimeMs).toISOString().slice(0, 10);
  try {
    const res = await axios.get(
      `${POLYGON_BASE}/v2/aggs/ticker/${polygonSym}/range/1/minute/${date}/${date}`,
      { params: { adjusted: false, sort: 'asc', limit: 500, apiKey: API_KEY }, timeout: 8000 }
    );
    const bars = res.data?.results || [];
    // Find the bar that covers the signal time (bar timestamp is bar open time)
    const bar = bars.find(b => b.t <= signalTimeMs && b.t + 60_000 > signalTimeMs)
             || bars.find(b => b.t >= signalTimeMs - 120_000)
             || bars[0];
    // Use open price of the covering bar — closest to signal time
    return bar?.o ?? bar?.c ?? null;
  } catch (err) {
    return null;
  }
}

async function main() {
  const { rows } = await pool.query(
    `SELECT id, option_symbol, signal_time
     FROM webhook_signal_log
     WHERE option_ask IS NULL AND option_symbol IS NOT NULL
     ORDER BY signal_time DESC`
  );

  console.log(`Found ${rows.length} signal(s) missing option_ask\n`);
  if (!rows.length) { await pool.end(); return; }

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const sym = toPolygonSymbol(row.option_symbol);
    if (!sym) {
      console.log(`  ✗ [${row.id}] ${row.option_symbol} — unrecognised symbol format`);
      skipped++;
      continue;
    }

    const signalTimeMs = new Date(row.signal_time).getTime();
    const ask = await fetchAskAtTime(sym, signalTimeMs);

    if (ask && ask > 0) {
      await pool.query('UPDATE webhook_signal_log SET option_ask = $1 WHERE id = $2', [ask, row.id]);
      console.log(`  ✓ [${row.id}] ${row.option_symbol} @ ${new Date(row.signal_time).toISOString()} → $${ask}`);
      updated++;
    } else {
      console.log(`  ✗ [${row.id}] ${row.option_symbol} @ ${new Date(row.signal_time).toISOString()} — no Polygon data`);
      skipped++;
    }

    // Courtesy delay — Polygon Starter has no hard rate limit but free tier does
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
