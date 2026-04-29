/**
 * Polygon.io client for option market data.
 *
 * Used for two purposes:
 *   1. Live option ask price on webhook receipt (replaces TastyTrade system client)
 *   2. Historical intraday minute bars for backtest signal enrichment
 *
 * Required env var:
 *   POLYGON_API_KEY — get from https://polygon.io (Starter plan $29/mo for real-time + history)
 *
 * Free tier: 15-min delayed data only — ok for testing, not for live ask prices.
 * Starter:   Real-time snapshots + 2 years of historical minute bars.
 */

const axios = require('axios');

const BASE = 'https://api.polygon.io';

function apiKey() {
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error('POLYGON_API_KEY env var not set');
  return key;
}

// ─── Symbol conversion ────────────────────────────────────────
// "SPY260423C560.0" → "O:SPY260423C00560000"
function toPolygonSymbol(tvSymbol) {
  if (!tvSymbol) return null;
  const m = tvSymbol.match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const [, root, date, type, strikeStr] = m;
  const strike = Math.round(parseFloat(strikeStr) * 1000);
  return `O:${root}${date}${type.toUpperCase()}${String(strike).padStart(8, '0')}`;
}

function underlyingFromTv(tvSymbol) {
  return tvSymbol?.match(/^([A-Z]+)/)?.[1] || null;
}

// ─── Live ask price (snapshot) ────────────────────────────────

async function getOptionAsk(tvSymbol) {
  const sym        = toPolygonSymbol(tvSymbol);
  const underlying = underlyingFromTv(tvSymbol);
  if (!sym || !underlying) return null;

  try {
    const res = await axios.get(
      `${BASE}/v3/snapshot/options/${underlying}/${sym}`,
      { params: { apiKey: apiKey() }, timeout: 5000 }
    );
    const ask = res.data?.results?.last_quote?.ask ?? null;
    return ask != null ? parseFloat(ask) : null;
  } catch {
    return null;
  }
}

// ─── Historical minute bars ───────────────────────────────────

async function getOptionMinuteBars(polygonSym, fromMs, toMs) {
  const from = new Date(fromMs).toISOString().slice(0, 10);
  const to   = new Date(toMs).toISOString().slice(0, 10);
  try {
    const res = await axios.get(
      `${BASE}/v2/aggs/ticker/${polygonSym}/range/1/minute/${from}/${to}`,
      {
        params: { adjusted: false, sort: 'asc', limit: 500, apiKey: apiKey() },
        timeout: 10000,
      }
    );
    const bars = res.data?.results || [];
    if (!bars.length) {
      console.warn(`[POLYGON] No bars returned for ${polygonSym} ${from} — status: ${res.data?.status}, resultsCount: ${res.data?.resultsCount}`);
    }
    return bars;
  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.error || err.message;
    console.error(`[POLYGON] getOptionMinuteBars failed for ${polygonSym}: [${status}] ${message}`);
    return [];
  }
}

// ─── Bars for a signal (used by backtest engine at run time) ─────────────────

async function getBarsForSignal(signal) {
  const sym = toPolygonSymbol(signal.option_symbol);
  if (!sym || !signal.signal_time) return [];
  const entryMs      = new Date(signal.signal_time).getTime();
  const d            = new Date(signal.signal_time);
  const sessionEndMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19, 44, 0);
  const bars = await getOptionMinuteBars(sym, entryMs, sessionEndMs);
  return bars.filter(b => b.t >= entryMs - 60_000);
}

// ─── Health check ─────────────────────────────────────────────

async function checkConnection() {
  if (!process.env.POLYGON_API_KEY) {
    return { ok: false, reason: 'POLYGON_API_KEY env var not set' };
  }
  try {
    const res = await axios.get(
      `${BASE}/v2/aggs/ticker/SPY/range/1/day/2025-01-01/2025-01-02`,
      { params: { apiKey: apiKey() }, timeout: 5000 }
    );
    const status = res.data?.status;
    if (status !== 'OK' && status !== 'DELAYED') {
      return { ok: false, reason: `Unexpected status: ${status}` };
    }
    return { ok: true, plan: status === 'DELAYED' ? 'free (delayed)' : 'real-time' };
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    return { ok: false, reason: msg };
  }
}

module.exports = { toPolygonSymbol, getOptionAsk, getOptionMinuteBars, getBarsForSignal, checkConnection };
