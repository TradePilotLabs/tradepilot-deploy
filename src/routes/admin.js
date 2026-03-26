const router  = require('express').Router();
const { requireAdmin } = require('../middleware/admin');
const {
  getStrategies, getStrategyBySlug, createStrategy,
  updateStrategy, deleteStrategy,
  getAllUsers, setAdminFlag,
  getUsersOnStrategy,
} = require('../data/db');

// All admin routes require admin JWT
router.use(requireAdmin);

// ─── Dashboard overview ───────────────────────────────────────

// GET /admin/overview
router.get('/overview', async (req, res) => {
  try {
    const [users, strategies] = await Promise.all([
      getAllUsers(1000, 0),
      getStrategies(false),
    ]);
    const activeTraders  = users.filter(u => u.trading_enabled).length;
    const connectedUsers = users.filter(u => u.account_number).length;
    const totalPnl       = users.reduce((s, u) => s + parseFloat(u.total_pnl || 0), 0);
    res.json({
      totalUsers: users.length,
      activeTraders,
      connectedUsers,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      strategies: strategies.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Users ────────────────────────────────────────────────────

// GET /admin/users?limit=100&offset=0
router.get('/users', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 100), 500);
    const offset = parseInt(req.query.offset || 0);
    const users  = await getAllUsers(limit, offset);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/users/:id  — toggle admin, disable trading etc
router.patch('/users/:id', async (req, res) => {
  try {
    const { is_admin } = req.body;
    if (is_admin !== undefined) {
      await setAdminFlag(req.params.id, is_admin);
    }
    res.json({ updated: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Strategies ───────────────────────────────────────────────

// GET /admin/strategies
router.get('/strategies', async (req, res) => {
  try {
    const strategies = await getStrategies(false); // include inactive
    // Include subscriber count per strategy
    const withCounts = await Promise.all(
      strategies.map(async (s) => {
        const subscribers = await getUsersOnStrategy(s.slug);
        return { ...s, subscriber_count: subscribers.length };
      })
    );
    res.json({ strategies: withCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/strategies
router.post('/strategies', async (req, res) => {
  try {
    const strategy = await createStrategy(req.body);
    res.status(201).json({ strategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/strategies/:id
router.patch('/strategies/:id', async (req, res) => {
  try {
    const allowed = [
      'name', 'description', 'detail', 'source_type', 'webhook_secret',
      'tickers', 'default_stop_pct', 'default_tp_pct', 'default_trailing_pct',
      'active', 'sort_order',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const strategy = await updateStrategy(req.params.id, updates);
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

// GET /admin/strategies/:slug/subscribers
router.get('/strategies/:slug/subscribers', async (req, res) => {
  try {
    const users = await getUsersOnStrategy(req.params.slug);
    res.json({ users, count: users.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/strategies/:slug/fire
// Manually fire a test signal to all subscribers (useful for testing)
router.post('/strategies/:slug/fire', async (req, res) => {
  try {
    const strategy = await getStrategyBySlug(req.params.slug);
    if (!strategy) return res.status(404).json({ error: 'Strategy not found' });

    // Import the strategy webhook handler and call it directly
    const { processStrategySignal } = require('../services/strategyRouter');
    const signal  = req.body;
    const results = await processStrategySignal(strategy, signal);
    res.json({ fired: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/bootstrap
// Promotes the calling user to admin if no admins exist yet
router.post('/bootstrap', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const jwt     = require('jsonwebtoken');
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { getAllUsers, setAdminFlag } = require('../data/db');

    const users    = await getAllUsers(1000);
    const hasAdmin = users.some(u => u.is_admin);
    if (hasAdmin) {
      return res.status(403).json({ error: 'Admin already exists — use database to promote additional admins' });
    }

    await setAdminFlag(payload.sub, true);
    res.json({ success: true, message: 'You are now an admin' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
