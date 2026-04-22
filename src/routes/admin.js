const router     = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const {
  getAllUsers, getStrategies, createStrategy,
  updateStrategy, deleteStrategy, getPool,
  insertBacktestSignals, clearBacktestSignals, countBacktestSignals,
  getWebhookSignalLogs, countWebhookSignalLogs,
} = require('../data/db');

router.use(requireAuth, requireAdmin);

// GET /admin/overview
router.get('/overview', async (req, res) => {
  try {
    const pool = getPool();
    const [users, strategies, trades] = await Promise.all([
      pool.query(`SELECT
        COUNT(*)                                                        AS total_users,
        COUNT(*) FILTER (WHERE subscription_status IN ('active','trialing')) AS active_subscribers,
        COUNT(*) FILTER (WHERE subscription_status = 'past_due')       AS past_due,
        COUNT(*) FILTER (WHERE subscription_status NOT IN ('active','trialing') 
                            OR subscription_status IS NULL)             AS no_subscription,
        COUNT(*) FILTER (WHERE trading_enabled = true
          AND EXISTS (SELECT 1 FROM user_settings us WHERE us.user_id = users.id AND us.trading_enabled = true))
                                                                        AS active_traders
        FROM users`),
      pool.query(`SELECT COUNT(*) AS total FROM strategies`),
      pool.query(`SELECT COALESCE(SUM(pnl),0) AS total_pnl FROM trades WHERE status='closed'`),
    ]);

    const u = users.rows[0];
    res.json({
      totalUsers:        parseInt(u.total_users),
      activeSubscribers: parseInt(u.active_subscribers),
      pastDue:           parseInt(u.past_due),
      noSubscription:    parseInt(u.no_subscription),
      activeTraders:     parseInt(u.active_traders),
      totalStrategies:   parseInt(strategies.rows[0].total),
      totalPnl:          parseFloat(trades.rows[0].total_pnl),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/users?status=all|active|trialing|past_due|inactive|no_subscription
router.get('/users', async (req, res) => {
  try {
    const { status = 'all', search = '', limit = 100, offset = 0 } = req.query;

    let where = [];
    const values = [];
    let i = 1;

    if (search) {
      where.push(`(u.email ILIKE $${i} OR u.name ILIKE $${i})`);
      values.push(`%${search}%`);
      i++;
    }

    if (status === 'active') {
      where.push(`u.subscription_status = 'active'`);
    } else if (status === 'trialing') {
      where.push(`u.subscription_status = 'trialing'`);
    } else if (status === 'past_due') {
      where.push(`u.subscription_status = 'past_due'`);
    } else if (status === 'no_subscription') {
      where.push(`(u.subscription_status NOT IN ('active','trialing','past_due') OR u.subscription_status IS NULL)`);
    } else if (status === 'inactive') {
      where.push(`u.is_active = false`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    values.push(parseInt(limit), parseInt(offset));

    const { rows } = await getPool().query(
      `SELECT
         u.id, u.email, u.name, u.is_admin, u.created_at,
         u.subscription_status, u.plan, u.is_active,
         u.license_key, u.last_login_at, u.trial_ends_at,
         us.trading_enabled, us.signal_source,
         tt.account_number,
         (SELECT COUNT(*) FROM trades t WHERE t.user_id = u.id)                     AS trade_count,
         (SELECT COALESCE(SUM(pnl),0) FROM trades t
          WHERE t.user_id = u.id AND t.status = 'closed')                           AS total_pnl,
         (SELECT COUNT(*) FROM broker_connections bc WHERE bc.user_id = u.id)       AS broker_count
       FROM users u
       LEFT JOIN user_settings us      ON us.user_id = u.id
       LEFT JOIN tastytrade_tokens tt  ON tt.user_id = u.id
       ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      values
    );

    // Total count for pagination
    const { rows: countRows } = await getPool().query(
      `SELECT COUNT(*) FROM users u ${whereClause}`,
      values.slice(0, -2)
    );

    res.json({ users: rows, total: parseInt(countRows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/users/:id — update user (activate, deactivate, set admin)
router.patch('/users/:id', async (req, res) => {
  try {
    const allowed = ['is_active', 'is_admin', 'subscription_status', 'plan'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });
    const fields    = Object.keys(updates);
    const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values    = fields.map(f => updates[f]);
    const { rows }  = await getPool().query(
      `UPDATE users SET ${setClause} WHERE id = $1 RETURNING id, email, is_active, is_admin, subscription_status`,
      [req.params.id, ...values]
    );
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/strategies
router.get('/strategies', async (req, res) => {
  try {
    const atsUrl = process.env.ATS_URL || '';
    const strategies = await getStrategies(false);
    const withCounts = await Promise.all(strategies.map(async s => {
      const { rows } = await getPool().query(
        `SELECT COUNT(*) FROM user_settings WHERE signal_source = $1`, [s.slug]
      );
      const webhookUrl = s.webhook_secret
        ? `${atsUrl}/webhook/strategy/${s.slug}?secret=${s.webhook_secret}`
        : `${atsUrl}/webhook/strategy/${s.slug}`;
      return { ...s, subscriber_count: parseInt(rows[0].count), webhook_url: webhookUrl };
    }));
    res.json({ strategies: withCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/strategies
router.post('/strategies', async (req, res) => {
  try {
    const crypto = require('crypto');
    // Auto-generate a webhook secret if not provided
    const data = {
      ...req.body,
      webhook_secret: req.body.webhook_secret || crypto.randomBytes(24).toString('hex'),
    };
    const strategy = await createStrategy(data);
    res.status(201).json({ strategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/strategies/:id/regenerate-secret — generate new webhook secret
router.post('/strategies/:id/regenerate-secret', async (req, res) => {
  try {
    const crypto = require('crypto');
    const newSecret = crypto.randomBytes(24).toString('hex');
    const strategy  = await updateStrategy(req.params.id, { webhook_secret: newSecret });
    const atsUrl    = process.env.ATS_URL || '';
    const webhookUrl = `${atsUrl}/webhook/strategy/${strategy.slug}?secret=${newSecret}`;
    res.json({ strategy, webhook_url: webhookUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/strategies/:slug/fire — send a test signal to a strategy
router.post('/strategies/:slug/fire', async (req, res) => {
  try {
    const { getStrategyBySlug } = require('../data/db');
    const { processStrategySignal } = require('../services/strategyRouter');
    const strategy = await getStrategyBySlug(req.params.slug);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
    const payload = req.body.payload || {
      ticker: req.body.ticker || 'SPY',
      action: req.body.action || 'BUY_CALLS',
      signal: 'TEST',
      price:  req.body.price || 500,
    };
    const results = await processStrategySignal(strategy, payload);
    res.json({ fired: true, strategy: strategy.slug, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/strategies/:id
router.patch('/strategies/:id', async (req, res) => {
  try {
    const strategy = await updateStrategy(req.params.id, req.body);
    res.json({ strategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/strategies/:id
router.delete('/strategies/:id', async (req, res) => {
  try {
    await deleteStrategy(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/bootstrap — first-time admin setup
router.post('/bootstrap', async (req, res) => {
  try {
    const jwt     = require('jsonwebtoken');
    const token   = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await getPool().query(
      `SELECT COUNT(*) FROM users WHERE is_admin = true`
    );
    if (parseInt(rows[0].count) > 0) {
      return res.status(403).json({ error: 'Admin already exists' });
    }
    await getPool().query(
      `UPDATE users SET is_admin = true WHERE id = $1`, [payload.sub]
    );
    res.json({ success: true, message: 'You are now an admin' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Test user creation ───────────────────────────────────────

// POST /admin/create-test-user
router.post('/create-test-user', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { createUser, getUserByEmail, createWebhookToken } = require('../data/db');
    const { generateLicenseKey } = require('../services/encryption');

    const name  = req.body.name  || 'Test User';
    const email = req.body.email || `test+${Date.now()}@tradepilotlabs.com`;
    const pass  = req.body.password || 'TestPass123!';
    const plan  = req.body.plan  || 'elite';
    const subscriptionStatus = req.body.subscriptionStatus || 'active';

    const existing = await getUserByEmail(email);
    if (existing) return res.status(400).json({ error: `User ${email} already exists` });

    const passwordHash = await bcrypt.hash(pass, 10);
    const licenseKey   = generateLicenseKey();
    const user = await createUser({ email, passwordHash, name, licenseKey });

    // Set subscription status directly
    await getPool().query(
      `UPDATE users SET subscription_status = $2, plan = $3, is_active = true WHERE id = $1`,
      [user.id, subscriptionStatus, plan]
    );

    await createWebhookToken(user.id);

    res.json({ user: { id: user.id, email, name, password: pass, subscriptionStatus, plan, licenseKey } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backtest signal management ───────────────────────────────

// GET /admin/backtest/signals — counts per strategy
router.get('/backtest/signals', async (req, res) => {
  try {
    const counts = await countBacktestSignals();
    res.json({ counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/backtest/signals — bulk upload signals
// Body: { signals: [{ strategy_slug, ticker, direction, signal_time, exit_time, ask_price, exit_ask?, outcome, option_symbol? }] }
router.post('/backtest/signals', async (req, res) => {
  try {
    const { signals, replace = false } = req.body;
    if (!Array.isArray(signals) || !signals.length) {
      return res.status(400).json({ error: 'signals array required' });
    }
    const required = ['strategy_slug','ticker','direction','signal_time','exit_time','ask_price','outcome'];
    for (const s of signals) {
      for (const f of required) {
        if (!s[f]) return res.status(400).json({ error: `Missing field: ${f}` });
      }
    }
    if (replace) {
      const slug = signals[0].strategy_slug;
      await clearBacktestSignals(slug);
    }
    const count = await insertBacktestSignals(signals);
    res.json({ inserted: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/webhook-signals — list logged signals (for backtest import)
router.get('/webhook-signals', async (req, res) => {
  try {
    const { slug, limit = 200, offset = 0 } = req.query;
    const [rows, counts] = await Promise.all([
      getWebhookSignalLogs({ slug, limit: parseInt(limit), offset: parseInt(offset) }),
      countWebhookSignalLogs(),
    ]);
    res.json({ signals: rows, counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/backtest/signals/:slug — clear signals for a strategy
router.delete('/backtest/signals/:slug', async (req, res) => {
  try {
    await clearBacktestSignals(req.params.slug);
    res.json({ cleared: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
