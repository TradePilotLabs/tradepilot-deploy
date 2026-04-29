const router = require('express').Router();
const crypto = require('crypto');
const { getStrategyBySlug, logWebhookSignal } = require('../data/db');
const { processStrategySignal } = require('../services/strategyRouter');
const polygon   = require('../services/polygonClient');
const tastySystem = require('../services/systemTastyClient');

async function fetchOptionAsk(tvSymbol) {
  if (!tvSymbol) return null;
  // Polygon is primary — simpler auth, no rotating tokens
  if (process.env.POLYGON_API_KEY) {
    const ask = await polygon.getOptionAsk(tvSymbol).catch(() => null);
    if (ask) return ask;
  }
  // Fall back to TastyTrade system client
  return tastySystem.getOptionAsk(tvSymbol).catch(() => null);
}

function extractSignalMeta(slug, body) {
  const optSym  = body.unmodifiedTicker || body.option_symbol || null;
  const tickerMatch = optSym?.match(/^([A-Z]+)/);
  const ticker  = tickerMatch ? tickerMatch[1] : (body.ticker || null);
  const dir     = (body.direction || '').toLowerCase();
  const direction = dir === 'calls' ? 'call' : dir === 'puts' ? 'put' : dir || null;
  const optionAsk = body.ask ? parseFloat(body.ask) : null;
  return {
    strategySlug:    slug,
    signalSource:    body.source         || null,
    ticker,
    direction,
    optionSymbol:    optSym,
    suggestedOption: body.suggestedOption || null,
    action:          body.action         || null,
    stockPrice:      body.price          || null,
    optionAsk,
    volume:          body.volume         || null,
    stopLossPct:     body.stopLossPct    || null,
    orbHigh:         body.orbHigh        || null,
    orbLow:          body.orbLow         || null,
    rsi:             body.rsi            || null,
    rawPayload:      body,
  };
}


/**
 * POST /webhook/strategy/:slug?secret=YOUR_SECRET
 *
 * Receives TradingView (or any platform) alerts for admin-managed strategies.
 * Fans the signal out to all subscribed users.
 *
 * Authentication: webhook_secret query param — ALWAYS required.
 * Every strategy must have a webhook_secret set (auto-generated on creation).
 * Use timing-safe comparison to prevent timing attacks.
 */
router.post('/:slug', async (req, res) => {
  const { slug }   = req.params;
  const { secret } = req.query;

  if (!secret) {
    return res.status(401).json({ error: 'Missing webhook secret' });
  }

  try {
    const strategy = await getStrategyBySlug(slug);
    if (!strategy || !strategy.active) {
      return res.status(404).json({ error: 'Strategy not found or inactive' });
    }

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

    // Log signal + fetch option ask from system TastyTrade account — non-blocking
    const meta = extractSignalMeta(slug, req.body);
    const signalTime = req.body.timestamp || new Date().toISOString();

    const logWithAsk = async () => {
      // Use ask from payload if sent; otherwise fetch from system TastyTrade client
      let optionAsk = meta.optionAsk;
      if (!optionAsk && meta.optionSymbol) {
        optionAsk = await fetchOptionAsk(meta.optionSymbol);
      }
      if (optionAsk) {
        console.log(`[SIGNAL LOG] ${meta.optionSymbol} ask=$${optionAsk}`);
      } else {
        console.warn(`[SIGNAL LOG] ${meta.optionSymbol} — option ask unavailable, storing signal without price`);
      }
      await logWebhookSignal({ ...meta, optionAsk });
    };
    logWithAsk().catch(e => console.warn('[SIGNAL LOG]', e.message));

    const results = await processStrategySignal(strategy, req.body);

    res.json({ success: true, strategy: slug, results });

  } catch (err) {
    console.error(`[STRATEGY WEBHOOK] Error for ${slug}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
