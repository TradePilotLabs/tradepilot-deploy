const router = require('express').Router();
const { requireAuth }      = require('../middleware/auth');
const { runBacktest }      = require('../services/backtestEngine');
const { getBarsForSignal } = require('../services/polygonClient');
const { EVENT_COUNTS }     = require('../data/marketEvents');
const {
  getBacktestSignals, countBacktestSignals,
  saveBacktestPreset, getBacktestPresets, deleteBacktestPreset,
  getStrategies,
} = require('../data/db');

router.use(requireAuth);

// GET /backtest/meta — signal counts per strategy + market event counts
router.get('/meta', async (req, res) => {
  try {
    const [signalCounts, strategies] = await Promise.all([
      countBacktestSignals(),
      getStrategies(true),
    ]);
    res.json({ signalCounts, strategies, marketEventCounts: EVENT_COUNTS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /backtest/run — run a backtest with given settings
router.post('/run', async (req, res) => {
  try {
    const settings = req.body;

    const signals = await getBacktestSignals({
      strategySlug: settings.strategySlug !== 'all' ? settings.strategySlug : undefined,
      from:         settings.dateFrom || undefined,
      to:           settings.dateTo   || undefined,
    });

    if (!signals.length) {
      return res.json({
        summary: null,
        trades:  [],
        message: 'No signals found for the selected strategy and date range.',
      });
    }

    // Fetch Polygon intraday bars for each signal live — used by engine to
    // simulate when TP or SL was hit. Runs sequentially with a small delay
    // to avoid hitting Polygon rate limits on lower-tier plans.
    for (const sig of signals) {
      if (sig.option_symbol) {
        sig._bars = await getBarsForSignal(sig).catch(() => []);
        await new Promise(r => setTimeout(r, 150));
      }
    }

    const results = runBacktest(signals, settings);
    res.json(results);
  } catch (err) {
    console.error('Backtest run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /backtest/presets
router.get('/presets', async (req, res) => {
  try {
    const presets = await getBacktestPresets(req.user.id);
    res.json({ presets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /backtest/presets
router.post('/presets', async (req, res) => {
  try {
    const { name, settings } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const preset = await saveBacktestPreset(req.user.id, name, settings);
    res.json({ preset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /backtest/presets/:id
router.delete('/presets/:id', async (req, res) => {
  try {
    await deleteBacktestPreset(req.user.id, req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
