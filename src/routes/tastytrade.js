const router = require('express').Router();
const axios  = require('axios');
const { requireAuth } = require('../middleware/auth');
const { saveTastyTokens, getTastyTokens, isTastyConnected } = require('../data/db');
const { encrypt, decrypt, maskKey } = require('../services/encryption');

const TASTY_TOKEN_URL = 'https://api.tastytrade.com/oauth/token';
const TASTY_API_BASE  = 'https://api.tastytrade.com';

// POST /auth/tastytrade/credentials
// Validates Client ID + Client Secret + Refresh Token by exchanging for an access token.
// Account number is NOT required here — users enter it separately on the Brokers page.
router.post('/credentials', requireAuth, async (req, res) => {
  const { clientId, clientSecret, refreshToken } = req.body;
  if (!clientId || !clientSecret || !refreshToken) {
    return res.status(400).json({ error: 'clientId, clientSecret, and refreshToken are all required' });
  }

  // Step 1: Exchange refresh token → access token. This is the only thing that validates credentials.
  let accessToken, expiresAt;
  try {
    const tokenRes = await axios.post(TASTY_TOKEN_URL,
      new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    accessToken = tokenRes.data.access_token;
    const expiresIn = tokenRes.data.expires_in || 3600;
    expiresAt = new Date(Date.now() + expiresIn * 1000);
  } catch (err) {
    const msg = err.response?.data?.error_description
             || err.response?.data?.error
             || err.message;
    return res.status(400).json({ error: `Credential verification failed: ${msg}` });
  }

  // Step 2: Opportunistically try to discover account number — never block on this.
  let accountNumber = null;
  try {
    const acctRes = await axios.get(`${TASTY_API_BASE}/customers/me/accounts`, {
      headers: { Authorization: accessToken },
    });
    const items = acctRes.data?.data?.items;
    if (items?.length > 0) accountNumber = items[0]['account-number'];
  } catch {
    // Non-critical — user can enter account number manually on the Brokers page
  }

  await saveTastyTokens(req.user.id, {
    accessToken,
    refreshToken,
    expiresAt,
    accountNumber,           // null if discovery failed — that's fine
    clientIdEncrypted:     encrypt(clientId),
    clientSecretEncrypted: encrypt(clientSecret),
  });

  res.json({ connected: true, accountNumber });
});

// PATCH /auth/tastytrade/account — set/update account number manually
router.patch('/account', requireAuth, async (req, res) => {
  const { accountNumber } = req.body;
  if (!accountNumber) return res.status(400).json({ error: 'accountNumber required' });

  const tokens = await getTastyTokens(req.user.id);
  if (!tokens?.refresh_token) {
    return res.status(400).json({ error: 'No credentials saved — connect TastyTrade first' });
  }

  await saveTastyTokens(req.user.id, {
    accessToken:           tokens.access_token,
    refreshToken:          tokens.refresh_token,
    expiresAt:             tokens.expires_at,
    accountNumber:         accountNumber.trim(),
    clientIdEncrypted:     tokens.client_id_encrypted,
    clientSecretEncrypted: tokens.client_secret_encrypted,
  });

  res.json({ updated: true, accountNumber: accountNumber.trim() });
});

// GET /auth/tastytrade/credentials — returns masked status + account number
router.get('/credentials', requireAuth, async (req, res) => {
  const tokens = await getTastyTokens(req.user.id);
  if (!tokens?.refresh_token) {
    return res.json({ connected: false });
  }
  const clientId = decrypt(tokens.client_id_encrypted);
  res.json({
    connected:      true,
    accountNumber:  tokens.account_number,
    clientIdMasked: clientId ? maskKey(clientId, 4) : null,
    connectedAt:    tokens.updated_at,
  });
});

// GET /auth/tastytrade/status — simple connected boolean (used by other routes)
router.get('/status', requireAuth, async (req, res) => {
  const connected = await isTastyConnected(req.user.id);
  res.json({ connected });
});

// DELETE /auth/tastytrade/disconnect — wipe all tokens and credentials
router.delete('/disconnect', requireAuth, async (req, res) => {
  await saveTastyTokens(req.user.id, {
    accessToken: null, refreshToken: null,
    expiresAt:   null, accountNumber: null,
    clientIdEncrypted: null, clientSecretEncrypted: null,
  });
  res.json({ disconnected: true });
});

module.exports = router;
