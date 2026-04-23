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

// ─── Token management ─────────────────────────────────────────

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) return _cachedToken;

  const clientId     = process.env.TASTY_CLIENT_ID;
  const clientSecret = process.env.TASTY_CLIENT_SECRET;
  const refreshToken = process.env.TASTY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'System TastyTrade credentials not configured — set TASTY_CLIENT_ID, ' +
      'TASTY_CLIENT_SECRET, and TASTY_REFRESH_TOKEN in Heroku config vars'
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
    return _cachedToken;
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
    throw new Error(`System TastyTrade token refresh failed: ${detail}`);
  }
}

// ─── Core GET wrapper ─────────────────────────────────────────

async function systemGet(path) {
  let token = await getAccessToken();
  try {
    const res = await axios.get(BASE + path, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      // Force token refresh and retry once
      _cachedToken = null;
      _tokenExpiry  = 0;
      token = await getAccessToken();
      const res = await axios.get(BASE + path, {
        headers: { Authorization: token, 'Content-Type': 'application/json' },
      });
      return res.data;
    }
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

  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, reason: 'TASTY_CLIENT_ID / TASTY_CLIENT_SECRET / TASTY_REFRESH_TOKEN not set in config vars' };
  }

  try {
    // Validate token by hitting a lightweight endpoint
    await getAccessToken();
    const data = await systemGet('/customers/me');
    const email = data?.data?.email || data?.data?.['email'] || null;
    return { ok: true, tokenCached: !!_cachedToken, account: email };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { getOptionAsk, checkConnection, toOCCSymbol };
