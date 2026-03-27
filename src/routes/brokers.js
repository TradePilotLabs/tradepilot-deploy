const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireActiveSubscription } = require('../middleware/subscription');
const {
  getBrokerConnections, getBrokerConnection,
  createBrokerConnection, updateBrokerConnection,
  deleteBrokerConnection, getBrokerSettings,
  upsertBrokerSettings, setPrimaryBroker,
} = require('../data/db');
const { getTastyTokens } = require('../data/db');
const { getAccounts } = require('../services/tastyClient');

router.use(requireAuth);

// GET /brokers — list all broker connections for this user
router.get('/', async (req, res) => {
  try {
    const connections = await getBrokerConnections(req.user.id);
    // Never return encrypted keys to client — just metadata
    const safe = connections.map(({ api_key_encrypted, api_secret_encrypted, ...c }) => c);
    res.json({ connections: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /brokers — add a new broker connection
// For TastyTrade: triggered after OAuth completes
// For future brokers: accepts api_key + api_secret
router.post('/', requireActiveSubscription, async (req, res) => {
  try {
    const { broker, displayName, authType, apiKey, apiSecret, accountNumber } = req.body;
    if (!broker) return res.status(400).json({ error: 'Broker required' });

    const validBrokers = ['tastytrade', 'webull', 'alpaca'];
    if (!validBrokers.includes(broker)) {
      return res.status(400).json({ error: 'Unsupported broker' });
    }

    let encryptedKey = null;
    let encryptedSecret = null;

    if (authType === 'apikey') {
      if (!apiKey) return res.status(400).json({ error: 'API key required' });
      const { encrypt } = require('../services/encryption');
      encryptedKey    = encrypt(apiKey);
      encryptedSecret = apiSecret ? encrypt(apiSecret) : null;
    }

    // Check if this is their first broker connection (make it primary)
    const existing = await getBrokerConnections(req.user.id);
    const isPrimary = existing.length === 0;

    const connection = await createBrokerConnection({
      userId:             req.user.id,
      broker,
      displayName:        displayName || broker,
      authType:           authType || 'oauth',
      apiKeyEncrypted:    encryptedKey,
      apiSecretEncrypted: encryptedSecret,
      accountNumber,
      isPrimary,
    });

    // Create default settings for this connection
    await upsertBrokerSettings(connection.id, req.user.id, {});

    res.status(201).json({ connection: sanitizeConnection(connection) });
  } catch (err) {
    console.error('Add broker error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /brokers/:id — get a single connection + its settings
router.get('/:id', async (req, res) => {
  try {
    const connection = await getBrokerConnection(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    const settings = await getBrokerSettings(req.params.id);
    res.json({ connection: sanitizeConnection(connection), settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /brokers/:id — update display name or account number
router.patch('/:id', async (req, res) => {
  try {
    const connection = await getBrokerConnection(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    const allowed = ['display_name', 'account_number'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const updated = await updateBrokerConnection(req.params.id, updates);
    res.json({ connection: sanitizeConnection(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /brokers/:id — remove a broker connection
router.delete('/:id', async (req, res) => {
  try {
    const connection = await getBrokerConnection(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    if (connection.is_primary) {
      return res.status(400).json({ error: 'Cannot delete primary broker. Set another as primary first.' });
    }
    await deleteBrokerConnection(req.params.id, req.user.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /brokers/:id/primary — set as primary broker
router.post('/:id/primary', async (req, res) => {
  try {
    const connection = await getBrokerConnection(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    await setPrimaryBroker(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /brokers/:id/validate — test if connection is working
router.post('/:id/validate', async (req, res) => {
  try {
    const connection = await getBrokerConnection(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });

    if (connection.broker === 'tastytrade' && connection.auth_type === 'oauth') {
      const tokens = await getTastyTokens(req.user.id);
      if (!tokens?.access_token) {
        await updateBrokerConnection(req.params.id, { status: 'invalid', last_validated_at: new Date() });
        return res.json({ valid: false, reason: 'No OAuth token found — reconnect TastyTrade' });
      }
      // Try fetching accounts to validate the token
      try {
        const accounts = await getAccounts(req.user.id);
        const accountNumbers = accounts.map(a => a['account-number']);
        await updateBrokerConnection(req.params.id, { status: 'active', last_validated_at: new Date() });
        res.json({ valid: true, accounts: accountNumbers });
      } catch (e) {
        await updateBrokerConnection(req.params.id, { status: 'invalid', last_validated_at: new Date() });
        res.json({ valid: false, reason: 'Token invalid or expired — reconnect TastyTrade' });
      }
    } else {
      res.json({ valid: true, reason: 'Validation not yet supported for this broker' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /brokers/:id/settings
router.get('/:id/settings', async (req, res) => {
  try {
    const connection = await getBrokerConnection(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    const settings = await getBrokerSettings(req.params.id);
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /brokers/:id/settings
router.patch('/:id/settings', async (req, res) => {
  try {
    const connection = await getBrokerConnection(req.params.id, req.user.id);
    if (!connection) return res.status(404).json({ error: 'Connection not found' });
    const settings = await upsertBrokerSettings(req.params.id, req.user.id, req.body);
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function sanitizeConnection(c) {
  const { api_key_encrypted, api_secret_encrypted, ...safe } = c;
  return safe;
}

module.exports = router;
