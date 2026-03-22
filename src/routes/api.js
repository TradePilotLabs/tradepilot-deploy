const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const {
  getOrCreateSettings, updateSettings,
  getTradeHistory, getOpenTrades, getTodayRealizedPnl,
  getDailyPnlHistory, getWebhookToken,
  savePreset, getPresets, deletePreset,
  isTastyConnected, getTastyTokens,
} = require('../data/db');
const { getOpenPositionsForUser } = require('../data/redis');

// All routes require JWT auth
router.use(requireAuth);

// ─── Settings ─────────────────────────────────────────────────

// GET /api/settings
router.get('/settings', async (req, res) => {
  try {
    const settings = await getOrCreateSettings(req.user.id);
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/settings
router.patch('/settings', async (req, res) => {
  try {
    const allowed = [
      'trading_enabled', 'order_type', 'ticker_filter',
      'alert_source', 'risk_allocation', 'max_capital_per_trade',
      'max_trades_per_day', 'max_contract_cost', 'min_contract_cost',
      'stop_loss_pct',
      'kill_profit_enabled', 'kill_profit_type', 'kill_profit_value',
      'kill_loss_enabled', 'kill_loss_type', 'kill_loss_value',
      'unreal_profit_enabled', 'unreal_profit_type', 'unreal_profit_value',
      'unreal_loss_enabled', 'unreal_loss_type', 'unreal_loss_value',
      'trailing_enabled', 'trailing_mode', 'trailing_trigger_pct',
      'trailing_pct', 'break_even_enabled', 'multi_tier_enabled',
      'schedule',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    await updateSettings(req.user.id, updates);
    const settings = await getOrCreateSettings(req.user.id);
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Presets ──────────────────────────────────────────────────

// GET /api/presets
router.get('/presets', async (req, res) => {
  const presets = await getPresets(req.user.id);
  res.json({ presets });
});

// POST /api/presets
router.post('/presets', async (req, res) => {
  const { name, settings } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const preset = await savePreset(req.user.id, name, settings);
  res.status(201).json({ preset });
});

// DELETE /api/presets/:id
router.delete('/presets/:id', async (req, res) => {
  await deletePreset(req.user.id, req.params.id);
  res.json({ deleted: true });
});

// ─── Trades & positions ───────────────────────────────────────

// GET /api/positions  — live open positions from Redis
router.get('/positions', async (req, res) => {
  try {
    const positions = await getOpenPositionsForUser(req.user.id);
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trades?limit=50&offset=0
router.get('/trades', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 50, 10), 200);
    const offset = parseInt(req.query.offset || 0, 10);
    const trades = await getTradeHistory(req.user.id, limit, offset);
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — dashboard overview numbers
router.get('/stats', async (req, res) => {
  try {
    const [
      openTrades,
      todayPnl,
      pnlHistory,
      connected,
    ] = await Promise.all([
      getOpenTrades(req.user.id),
      getTodayRealizedPnl(req.user.id),
      getDailyPnlHistory(req.user.id, 30),
      isTastyConnected(req.user.id),
    ]);

    const totalTrades = pnlHistory.reduce((s, d) => s + (d.trade_count || 0), 0);
    const totalWins   = pnlHistory.reduce((s, d) => s + (d.win_count || 0), 0);
    const totalPnl    = pnlHistory.reduce((s, d) => s + parseFloat(d.total_pnl || 0), 0);

    res.json({
      openTradeCount:  openTrades.length,
      todayPnl,
      totalPnl: parseFloat(totalPnl.toFixed(2)),
      winRate: totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0,
      totalTrades,
      pnlHistory,
      tastyConnected: connected,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/webhook-url — returns user's webhook URL
router.get('/webhook-url', async (req, res) => {
  const token = await getWebhookToken(req.user.id);
  res.json({
    token,
    url: `${process.env.ATS_URL || 'https://ats.tradepilot.io'}/webhook/${token}`,
  });
});

// GET /api/account — TastyTrade account info
router.get('/account', async (req, res) => {
  const tokens = await getTastyTokens(req.user.id);
  res.json({
    connected: !!tokens?.access_token,
    accountNumber: tokens?.account_number || null,
  });
});

module.exports = router;
