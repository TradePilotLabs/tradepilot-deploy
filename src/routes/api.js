const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const {
  getOrCreateSettings, updateSettings,
  getTradeHistory, getOpenTrades, getTodayRealizedPnl,
  getDailyPnlHistory, getWebhookToken,
  savePreset, getPresets, deletePreset,
  isTastyConnected, getTastyTokens,
  getStrategies, getStrategyBySlug, getSignalLog,
  getPool,
} = require('../data/db');
const { getOpenPositionsForUser } = require('../data/redis');

router.use(requireAuth);

// ─── Settings ─────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const settings = await getOrCreateSettings(req.user.id);
    res.json({ settings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/settings', async (req, res) => {
  try {
    const allowed = [
      'trading_enabled', 'order_type', 'ticker_filter',
      'alert_source', 'signal_source',
      'risk_allocation', 'max_capital_per_trade',
      'max_trades_per_day', 'max_contract_cost', 'min_contract_cost',
      'take_profit_pct', 'stop_loss_pct',
      'kill_profit_enabled', 'kill_profit_type', 'kill_profit_value',
      'kill_loss_enabled',   'kill_loss_type',   'kill_loss_value',
      'unreal_profit_enabled', 'unreal_profit_type', 'unreal_profit_value',
      'unreal_loss_enabled',   'unreal_loss_type',   'unreal_loss_value',
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Presets ──────────────────────────────────────────────────

router.get('/presets', async (req, res) => {
  const presets = await getPresets(req.user.id);
  res.json({ presets });
});

router.post('/presets', async (req, res) => {
  const { name, settings } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const preset = await savePreset(req.user.id, name, settings);
  res.status(201).json({ preset });
});

router.delete('/presets/:id', async (req, res) => {
  await deletePreset(req.user.id, req.params.id);
  res.json({ deleted: true });
});

// ─── Positions & trades ───────────────────────────────────────

router.get('/positions', async (req, res) => {
  try {
    const positions = await getOpenPositionsForUser(req.user.id);
    res.json({ positions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/trades', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 50,  10), 200);
    const offset = parseInt(req.query.offset || 0, 10);
    const trades = await getTradeHistory(req.user.id, limit, offset);
    res.json({ trades });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Stats ────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;
    const pool   = getPool();
    const [openTrades, todayPnl, pnlHistory, connected, todayResult] = await Promise.all([
      getOpenTrades(userId),
      getTodayRealizedPnl(userId),
      getDailyPnlHistory(userId, 30),
      isTastyConnected(userId),
      pool.query(
        `SELECT * FROM trades
         WHERE user_id=$1 AND entry_time >= CURRENT_DATE
         ORDER BY entry_time DESC`,
        [userId]
      ),
    ]);
    const totalTrades = pnlHistory.reduce((s, d) => s + (d.trade_count || 0), 0);
    const totalWins   = pnlHistory.reduce((s, d) => s + (d.win_count   || 0), 0);
    const totalPnl    = pnlHistory.reduce((s, d) => s + parseFloat(d.total_pnl || 0), 0);

    const todayTrades    = todayResult.rows;
    const closedToday    = todayTrades.filter(t => t.status === 'closed' || t.exit_price != null);
    const todayWins      = closedToday.filter(t => parseFloat(t.pnl || 0) > 0).length;
    const todayLosses    = closedToday.filter(t => parseFloat(t.pnl || 0) <= 0).length;
    const todayGrossPnl  = closedToday.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
    const todayFees      = closedToday.reduce((s, t) => s + (parseFloat(t.quantity || 0) * 1.30), 0);
    const todayNetPnl    = todayGrossPnl - todayFees;

    res.json({
      openTradeCount: openTrades.length,
      todayPnl,
      totalPnl:         parseFloat(totalPnl.toFixed(2)),
      winRate:          totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100) : 0,
      totalTrades,
      pnlHistory,
      tastyConnected:   connected,
      todayTrades,
      todayCompleted:   closedToday.length,
      todayWins,
      todayLosses,
      todayGrossPnl:    parseFloat(todayGrossPnl.toFixed(2)),
      todayFees:        parseFloat(todayFees.toFixed(2)),
      todayNetPnl:      parseFloat(todayNetPnl.toFixed(2)),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Account ──────────────────────────────────────────────────

router.get('/account', async (req, res) => {
  const tokens = await getTastyTokens(req.user.id);
  res.json({
    connected:     !!tokens?.access_token,
    accountNumber: tokens?.account_number || null,
  });
});

// ─── Webhook URL ──────────────────────────────────────────────

router.get('/webhook-url', async (req, res) => {
  const token = await getWebhookToken(req.user.id);
  res.json({
    token,
    url: `${process.env.ATS_URL || 'https://ats.tradepilotlabs.com'}/webhook/${token}`,
  });
});

// ─── Strategies (Phase 3) ─────────────────────────────────────

router.get('/strategies', async (req, res) => {
  try {
    const strategies = await getStrategies(true);
    const safe = strategies.map(({ webhook_secret, ...s }) => s);
    res.json({ strategies: safe });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Signal log (Phase 3) ────────────────────────────────────

router.get('/signals', async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit || 50, 10), 200);
    const signals = await getSignalLog(req.user.id, limit);
    res.json({ signals });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Webhook info (Phase 3) ───────────────────────────────────

router.get('/webhook-info', async (req, res) => {
  try {
    const [token, settings] = await Promise.all([
      getWebhookToken(req.user.id),
      getOrCreateSettings(req.user.id),
    ]);
    const isCustom = !settings.signal_source || settings.signal_source === 'custom';
    let activeStrategy = null;
    if (!isCustom) {
      const s = await getStrategyBySlug(settings.signal_source);
      if (s) { const { webhook_secret, ...safe } = s; activeStrategy = safe; }
    }
    res.json({
      signalSource:   settings.signal_source || 'custom',
      isCustom,
      webhookUrl:     isCustom
        ? `${process.env.ATS_URL || 'https://ats.tradepilotlabs.com'}/webhook/${token}`
        : null,
      webhookToken:   isCustom ? token : null,
      activeStrategy,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/flatten-all — emergency close all open positions for the current user
router.post('/flatten-all', async (req, res) => {
  try {
    const userId = req.user.id;
    const { closePosition } = require('../services/orderPlacer');
    const tokens    = await getTastyTokens(userId);
    if (!tokens?.account_number) return res.status(400).json({ error: 'No broker connected' });

    const positions = await getOpenPositionsForUser(userId);
    if (!positions.length) return res.json({ flattened: 0 });

    let flattened = 0;
    for (const pos of positions) {
      try {
        await closePosition({ userId, accountNumber: tokens.account_number,
          position: pos, exitReason: 'manual_flatten', currentPrice: null });
        flattened++;
      } catch (e) {
        console.error(`[FLATTEN] ${pos.optionSymbol}:`, e.message);
      }
    }
    res.json({ flattened, total: positions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
