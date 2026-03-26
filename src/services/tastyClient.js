const axios = require('axios');
const { getTastyTokens, updateTastyAccessToken } = require('../data/db');

const BASE = 'https://api.tastytrade.com';

// ─── Token refresh ────────────────────────────────────────────

async function refreshAccessToken(userId, tokens) {
  try {
    const res = await axios.post(`${BASE}/oauth/token`, {
      grant_type:    'refresh_token',
      client_id:     process.env.TASTY_CLIENT_ID,
      client_secret: process.env.TASTY_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    });
    const { access_token, expires_in } = res.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    await updateTastyAccessToken(userId, access_token, expiresAt);
    return access_token;
  } catch (err) {
    throw new Error(`Token refresh failed: ${err.response?.data?.error || err.message}`);
  }
}

// ─── Core API call wrapper ────────────────────────────────────
// Handles token expiry + one automatic retry

async function api(userId, method, path, data = null) {
  const tokens = await getTastyTokens(userId);
  if (!tokens) throw new Error('No TastyTrade tokens found for user');

  // Refresh if expired (with 60s buffer)
  let accessToken = tokens.access_token;
  if (tokens.expires_at && new Date(tokens.expires_at) < new Date(Date.now() + 60000)) {
    accessToken = await refreshAccessToken(userId, tokens);
  }

  const config = {
    method,
    url: BASE + path,
    headers: {
      Authorization:  accessToken,
      'Content-Type': 'application/json',
    },
  };
  if (data) config.data = data;

  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    // 401 = token expired mid-request, refresh and retry once
    if (err.response?.status === 401) {
      const newToken = await refreshAccessToken(userId, tokens);
      config.headers.Authorization = newToken;
      const res = await axios(config);
      return res.data;
    }
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`TastyTrade API error [${method} ${path}]: ${msg}`);
  }
}

// ─── Account ──────────────────────────────────────────────────

async function getAccounts(userId) {
  const res = await api(userId, 'GET', '/customers/me/accounts');
  return res.data?.items || [];
}

async function getAccountBalances(userId, accountNumber) {
  const res = await api(userId, 'GET', `/accounts/${accountNumber}/balances`);
  return res.data;
}

// ─── Option chains ────────────────────────────────────────────

async function getOptionChain(userId, ticker) {
  const res = await api(userId, 'GET', `/option-chains/${ticker}/nested`);
  return res.data?.items?.[0] || null;
}

// ─── Market data / quotes ─────────────────────────────────────

async function getQuotes(userId, symbols) {
  // symbols = array of OCC option symbols e.g. ['SPY   260319C00660000']
  const query = symbols.map(s => `symbols[]=${encodeURIComponent(s)}`).join('&');
  const res = await api(userId, 'GET', `/market-data/quotes?${query}`);
  return res.data?.items || [];
}

async function getEquityQuote(userId, ticker) {
  const res = await api(userId, 'GET', `/market-data/quotes?symbols[]=${ticker}`);
  return res.data?.items?.[0] || null;
}

// ─── Orders ───────────────────────────────────────────────────

async function placeOrder(userId, accountNumber, order) {
  const res = await api(userId, 'POST', `/accounts/${accountNumber}/orders`, order);
  return res.data?.order;
}

async function cancelOrder(userId, accountNumber, orderId) {
  const res = await api(userId, 'DELETE', `/accounts/${accountNumber}/orders/${orderId}`);
  return res.data;
}

async function getOrder(userId, accountNumber, orderId) {
  const res = await api(userId, 'GET', `/accounts/${accountNumber}/orders/${orderId}`);
  return res.data?.order;
}

async function getOpenOrders(userId, accountNumber) {
  const res = await api(userId, 'GET', `/accounts/${accountNumber}/orders/live`);
  return res.data?.items || [];
}

// ─── Positions ────────────────────────────────────────────────

async function getPositions(userId, accountNumber) {
  const res = await api(userId, 'GET', `/accounts/${accountNumber}/positions`);
  return res.data?.items || [];
}

module.exports = {
  getAccounts,
  getAccountBalances,
  getOptionChain,
  getQuotes,
  getEquityQuote,
  placeOrder,
  cancelOrder,
  getOrder,
  getOpenOrders,
  getPositions,
};
