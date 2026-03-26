const router = require('express').Router();
const { getStrategyBySlug } = require('../data/db');
const { processStrategySignal } = require('../services/strategyRouter');

/**
 * POST /webhook/strategy/:slug
 *
 * This endpoint receives alerts from YOUR TradingView account
 * for managed strategies. It then fans the signal out to all
 * users subscribed to that strategy.
 *
 * Secure with a webhook secret per strategy (set in admin panel).
 * Add ?secret=YOUR_SECRET to your TradingView webhook URL.
 *
 * Example TradingView webhook URL:
 * https://ats.tradepilotlabs.com/webhook/strategy/dual-trend?secret=abc123
 *
 * TradingView alert message:
 * {
 *   "ticker":  "{{ticker}}",
 *   "action":  "BUY_CALLS",
 *   "signal":  "B1",
 *   "price":   {{close}},
 *   "stopPct": 40
 * }
 */
router.post('/:slug', async (req, res) => {
  const { slug }   = req.params;
  const { secret } = req.query;

  try {
    // Load strategy
    const strategy = await getStrategyBySlug(slug);
    if (!strategy || !strategy.active) {
      return res.status(404).json({ error: 'Strategy not found or inactive' });
    }

    // Validate webhook secret if one is set
    if (strategy.webhook_secret) {
      if (!secret || secret !== strategy.webhook_secret) {
        console.warn(`[STRATEGY WEBHOOK] Invalid secret for strategy: ${slug}`);
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }
    }

    // Fan signal out to all subscribers
    const results = await processStrategySignal(strategy, req.body);

    res.json({
      success:  true,
      strategy: slug,
      results,
    });

  } catch (err) {
    console.error(`[STRATEGY WEBHOOK] Error for ${slug}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
