/**
 * System-level TastyTrade client.
 *
 * Uses env vars instead of per-user DB tokens so option-ask fetching
 * works on every webhook regardless of which users are connected.
 *
 * Required env vars (set via `heroku config:set`):
 *   TASTY_CLIENT_ID      — OAuth application client_id
 *   TASTY_CLIENT_SECRET  — OAuth application client_secret
 *   TASTY_REFRESH_TOKEN  — long-lived refresh token from "Create Grant"
 *
 * How to get these:
 *   1. Go to https://developer.tastytrade.com → OAuth Applications → Create
 *   2. Set scopes: market-data:read
 *   3. Add any redirect URI (e.g. http://localhost)
 *   4. Click "Create Grant" to generate a refresh token
 *   5. Copy client_id, client_secret, and the refresh token
 */

const axios = require('axios');

const BASE = process.env.TASTY_API_BASE || 'https://api.tastytrade.com';

let _cachedToken  = null;
let _tokenExpiry  = 0;

// ─── Refresh token persistence (survives rotation + dyno restarts) ────────────

async function getStoredRefreshToken() {
  try {
    const { getPool } = require('../data/db');
    const { rows } = await getPool().query(
      `SELECT value FROM system_config WHERE key = 'tasty_refresh_token'`
    );
    if (rows[0]?.value) return rows[0].value;
  } catch {}
  // Fall back to env var — used on first bootstrap before DB has been seeded
  return process.env.TASTY_REFRESH_TOKEN || null;
}

async function persistRefreshToken(token) {
  try {
    const { getPool } = require('../data/db');
    await getPool().query(
      `INSERT INTO system_config (key, value, updated_at)
       VALUES ('tasty_refresh_token', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [token]
    );
  } catch (e) {
    console.warn('[SYSTEM TASTY] Failed to persist refresh token to DB:', e.message);
  }
}

// ─── Token management ─────────────────────────────────────────

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) return _cachedToken;

  const clientId     = process.env.TASTY_CLIENT_ID?.trim();
  const clientSecret = process.env.TASTY_CLIENT_SECRET?.trim();
  const refreshToken = (await getStoredRefreshToken())?.trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      'System TastyTrade credentials not configured — set TASTY_CLIENT_ID and ' +
      'TASTY_CLIENT_SECRET in Heroku config vars'
    );
  }
  if (!refreshToken) {
    throw new Error(
      'No system refresh token available — set TASTY_REFRESH_TOKEN in Heroku config vars for initial bootstrap'
    );
  }

  try {
    const res = await axios.post(
      `${BASE}/oauth/token`,
      new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    _cachedToken = res.data.access_token;
    _tokenExpiry = Date.now() + (res.data.expires_in || 86400) * 1000;

    // TastyTrade rotates refresh tokens — persist the new one immediately
    if (res.data.refresh_token) {
      await persistRefreshToken(res.data.refresh_token);
    }

    return _cachedToken;
  } catch (err) {
    const body   = err.response?.data;
    const detail = body?.error_description || body?.error || body?.message
                || (body ? JSON.stringify(body) : err.message);
    const status = err.response?.status ?? 'no-response';
    throw new Error(`System TastyTrade token refresh failed [${status}]: ${detail}`);
  }
}

// ─── Core GET wrapper ─────────────────────────────────────────

async function systemGet(path) {
  const token = await getAccessToken();
  try {
    const res = await axios.get(BASE + path, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`TastyTrade system API [GET ${path}]: ${msg}`);
  }
}

// ─── Symbol conversion ────────────────────────────────────────

// PineScript format → OCC format for TastyTrade quotes
// "SPY260421P705.0" → "SPY   260421P00705000"
function toOCCSymbol(tvSymbol) {
  if (!tvSymbol) return null;
  const m = tvSymbol.match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const [, root, date, type, strikeStr] = m;
  const strike = Math.round(parseFloat(strikeStr) * 1000);
  return `${root.padEnd(6, ' ')}${date}${type.toUpperCase()}${String(strike).padStart(8, '0')}`;
}

// ─── Option ask ───────────────────────────────────────────────

async function getOptionAsk(tvSymbol) {
  const occ = toOCCSymbol(tvSymbol);
  if (!occ) return null;
  const data = await systemGet(`/market-data/quotes?symbols[]=${encodeURIComponent(occ)}`);
  const q = data?.data?.items?.[0];
  const ask = parseFloat(q?.ask ?? q?.['ask-price'] ?? 0);
  return ask > 0 ? ask : null;
}

// ─── Health check ─────────────────────────────────────────────

async function checkConnection() {
  const clientId     = process.env.TASTY_CLIENT_ID;
  const clientSecret = process.env.TASTY_CLIENT_SECRET;
  const refreshToken = process.env.TASTY_REFRESH_TOKEN;

  const missing = [
    !clientId     && 'TASTY_CLIENT_ID',
    !clientSecret && 'TASTY_CLIENT_SECRET',
    !refreshToken && 'TASTY_REFRESH_TOKEN',
  ].filter(Boolean);

  if (missing.length) {
    return { ok: false, reason: `Missing env vars: ${missing.join(', ')}` };
  }

  const clientId     = process.env.TASTY_CLIENT_ID?.trim();
  const clientSecret = process.env.TASTY_CLIENT_SECRET?.trim();
  const refreshToken = (await getStoredRefreshToken())?.trim();
  const tokenSource  = refreshToken ? (await (async () => {
    try {
      const { getPool } = require('../data/db');
      const { rows } = await getPool().query(`SELECT value FROM system_config WHERE key = 'tasty_refresh_token'`);
      return rows[0]?.value ? 'db' : 'env';
    } catch { return 'env'; }
  })()) : null;

  try {
    // Just confirm the token exchange itself works — that's all we need
    await getAccessToken();
    // Verify market-data scope works with a simple equity quote
    const data   = await systemGet('/market-data/quotes?symbols[]=SPY');
    const spyAsk = data?.data?.items?.[0]?.ask ?? data?.data?.items?.[0]?.['ask-price'] ?? null;
    return { ok: true, tokenCached: !!_cachedToken, tokenSource, spyAsk };
  } catch (err) {
    return {
      ok: false,
      reason: err.message,
      debug: {
        hasClientId:     !!clientId,
        hasClientSecret: !!clientSecret,
        hasRefreshToken: !!refreshToken,
        refreshTokenLen: refreshToken?.length ?? 0,
        tokenSource,
      },
    };
  }
}

module.exports = { getOptionAsk, checkConnection, toOCCSymbol };
