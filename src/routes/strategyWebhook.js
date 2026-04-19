const router = require('express').Router();
const crypto = require('crypto');
const { getStrategyBySlug } = require('../data/db');
const { processStrategySignal } = require('../services/strategyRouter');

/**
 * POST /webhook/strategy/:slug?secret=YOUR_SECRET
 *
 * Receives TradingView (or any platform) alerts for admin-managed strategies.
 * Fans the signal out to all subscribed users.
 *
 * Authentication: webhook_secret query param — ALWAYS required.
 * Every strategy must have a webhook_secret set (auto-generated on creation).
 * Use timing-safe comparison to prevent timing attacks.
 *
 * TradingView alert message body:
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

  // Always require secret — reject immediately if missing
  if (!secret) {
    return res.status(401).json({ error: 'Missing webhook secret' });
  }

  try {
    const strategy = await getStrategyBySlug(slug);
    if (!strategy || !strategy.active) {
      return res.status(404).json({ error: 'Strategy not found or inactive' });
    }

    // Timing-safe comparison to prevent timing attacks
    if (!strategy.webhook_secret) {
      console.warn(`[STRATEGY WEBHOOK] Strategy ${slug} has no secret configured`);
      return res.status(403).json({ error: 'Strategy webhook not configured' });
    }

    const expected = Buffer.from(strategy.webhook_secret);
    const provided = Buffer.from(secret);
    const valid = expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided);

    if (!valid) {
      console.warn(`[STRATEGY WEBHOOK] Invalid secret for strategy: ${slug}`);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const results = await processStrategySignal(strategy, req.body);

    res.json({ success: true, strategy: slug, results });

  } catch (err) {
    console.error(`[STRATEGY WEBHOOK] Error for ${slug}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
