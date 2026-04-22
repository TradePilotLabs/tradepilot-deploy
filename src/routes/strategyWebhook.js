const router = require('express').Router();
const crypto = require('crypto');
const { getStrategyBySlug, logWebhookSignal, getAnyTastyUserId } = require('../data/db');
const { processStrategySignal } = require('../services/strategyRouter');
const { getQuotes } = require('../services/tastyClient');

// Convert PineScript option symbol → OCC format for TastyTrade quotes
// "SPY260421P705.0" → "SPY   260421P00705000"
function toOCCSymbol(tvSymbol) {
  if (!tvSymbol) return null;
  const m = tvSymbol.match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const [, root, date, type, strikeStr] = m;
  const strike = Math.round(parseFloat(strikeStr) * 1000);
  return `${root.padEnd(6, ' ')}${date}${type.toUpperCase()}${String(strike).padStart(8, '0')}`;
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

async function fetchOptionAsk(tvSymbol) {
  try {
    const userId = await getAnyTastyUserId();
    if (!userId) return null;
    const occ = toOCCSymbol(tvSymbol);
    if (!occ) return null;
    const quotes = await getQuotes(userId, [occ]);
    const q = quotes[0];
    // Use ask price; fall back to mid if ask unavailable
    const ask = parseFloat(q?.ask ?? q?.['ask-price'] ?? 0);
    return ask > 0 ? ask : null;
  } catch {
    return null;
  }
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

    // Always log the raw signal + option ask — fully non-blocking
    const meta = extractSignalMeta(slug, req.body);
    const logWithAsk = async () => {
      // Use ask from payload if PineScript sent it, otherwise fetch from TastyTrade
      const optionAsk = meta.optionAsk ?? await fetchOptionAsk(meta.optionSymbol);
      if (optionAsk) console.log(`[SIGNAL LOG] ${meta.optionSymbol} ask=$${optionAsk}`);
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
