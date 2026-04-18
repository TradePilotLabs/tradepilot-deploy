const router = require('express').Router();
const axios = require('axios');
const { requireAuth } = require('../middleware/auth');
const { saveTastyTokens, isTastyConnected } = require('../data/db');

const TASTY_AUTH_URL  = 'https://api.tastytrade.com/oauth/authorize';
const TASTY_TOKEN_URL = 'https://api.tastytrade.com/oauth/token';
const TASTY_API_BASE  = 'https://api.tastytrade.com';

// GET /tastytrade/connect — accepts JWT via ?token= query param (needed for browser redirects)
router.get('/connect', async (req, res) => {
  const jwt = require('jsonwebtoken');
  const { getUserById } = require('../data/db');
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  let user;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    user = await getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = user;
  const params = new URLSearchParams({
    client_id:     process.env.TASTY_CLIENT_ID,
    redirect_uri:  process.env.TASTY_REDIRECT_URI,
    response_type: 'code',
    scope:         'read trade openid',
    state:         req.user.id,   // we'll match this in callback
  });
  res.redirect(`${TASTY_AUTH_URL}?${params}`);
});

// GET /tastytrade/callback?code=xxx&state=userId
// TastyTrade redirects here after user authorizes
router.get('/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.DASHBOARD_URL}/onboard?step=2&error=access_denied`);
  }
  if (!code || !userId) {
    return res.redirect(`${process.env.DASHBOARD_URL}/onboard?step=2&error=invalid_callback`);
  }

  try {
    // Exchange code for tokens — OAuth requires form-encoded body, not JSON
    const tokenRes = await axios.post(TASTY_TOKEN_URL,
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     process.env.TASTY_CLIENT_ID,
        client_secret: process.env.TASTY_CLIENT_SECRET,
        redirect_uri:  process.env.TASTY_REDIRECT_URI,
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000);

    // Fetch their account number while we have a fresh token
    let accountNumber = null;
    try {
      const accountsRes = await axios.get(`${TASTY_API_BASE}/customers/me/accounts`, {
        headers: { Authorization: access_token },
      });
      const accounts = accountsRes.data?.data?.items;
      if (accounts?.length > 0) {
        accountNumber = accounts[0]['account-number'];
      }
    } catch (e) {
      console.warn('Could not fetch account number:', e.message);
    }

    await saveTastyTokens(userId, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
      accountNumber,
    });

    // Redirect back to dashboard — connected!
    res.redirect(`${process.env.DASHBOARD_URL}/onboard?step=3&connected=true`);
  } catch (err) {
    console.error('TastyTrade OAuth error:', err.response?.data || err.message);
    res.redirect(`${process.env.DASHBOARD_URL}/onboard?step=2&error=token_exchange_failed`);
  }
});

// GET /tastytrade/status — check if user has connected TastyTrade
router.get('/status', requireAuth, async (req, res) => {
  const connected = await isTastyConnected(req.user.id);
  res.json({ connected });
});

// DELETE /tastytrade/disconnect — revoke and remove tokens
router.delete('/disconnect', requireAuth, async (req, res) => {
  await saveTastyTokens(req.user.id, {
    accessToken: '', refreshToken: '', expiresAt: null, accountNumber: null,
  });
  res.json({ disconnected: true });
});

module.exports = router;
