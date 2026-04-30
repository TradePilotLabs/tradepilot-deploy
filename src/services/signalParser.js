/**
 * Parses incoming webhook signals from TradingView.
 *
 * Supports two formats:
 *
 * FORMAT A — legacy/custom (original):
 *   { "ticker": "SPY", "action": "BUY_CALLS", "price": 561.23, "stopPct": 40 }
 *
 * FORMAT B — ORB-15 / new PineScript format:
 *   { "direction": "calls"|"puts", "action": "open", "unmodifiedTicker": "SPY260430C711.0",
 *     "price": 710.55, "stopLossPct": 50, "source": "tradepilot-orb15", ... }
 *   Ticker is extracted from the root symbol of unmodifiedTicker.
 */

const VALID_TICKERS = ['SPY', 'QQQ'];

function parseSignal(body) {
  if (!body || typeof body !== 'object') return null;

  const rawAction    = (body.action    || '').toLowerCase().trim();
  const rawDirection = (body.direction || '').toLowerCase().trim();

  let ticker, direction, action;

  // ── Format B: ORB-15 / new format (action = "open", direction = "calls"|"puts") ──
  if (rawAction === 'open' && (rawDirection === 'calls' || rawDirection === 'puts')) {
    direction = rawDirection;
    action    = direction === 'calls' ? 'BUY_CALLS' : 'BUY_PUTS';

    // Extract ticker from unmodifiedTicker (e.g. "SPY260430P711.0" → "SPY")
    const sym = body.unmodifiedTicker || body.option_symbol || '';
    const match = sym.match(/^([A-Z]+)/i);
    ticker = match ? match[1].toUpperCase() : (body.ticker || '').toUpperCase().trim();

    if (!VALID_TICKERS.includes(ticker)) {
      console.warn(`[SIGNAL] Format-B rejected: unrecognised ticker "${ticker}" from "${sym}"`);
      return null;
    }

    // optionPrice: PineScript can send option OHLC in the signal (like automation app does).
    // If present, contractSelector uses it directly instead of calling Polygon.
    const optionClose = parseFloat(body.close) || parseFloat(body.optionPrice) || null;

    return {
      ticker,
      action,
      direction,
      signalType:   'CUSTOM',
      price:        parseFloat(body.price)       || null, // underlying price
      optionPrice:  optionClose,                          // option mid from signal (optional)
      stopPct:      parseFloat(body.stopLossPct) || parseFloat(body.stopPct) || null,
      tpPct:        parseFloat(body.tpPct)       || null,
      comment:      body.source || '',
      raw:          body,
    };
  }

  // ── Format A: legacy BUY_CALLS / BUY_PUTS ──────────────────────────────────────
  const VALID_ACTIONS = ['BUY_CALLS', 'BUY_PUTS', 'CLOSE_ALL'];
  const VALID_SIGNALS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'];

  ticker = (body.ticker || '').toUpperCase().trim();
  action = (body.action || '').toUpperCase().trim();
  const signal = (body.signal || '').toUpperCase().trim();

  if (!VALID_TICKERS.includes(ticker)) {
    console.warn(`[SIGNAL] Format-A rejected: invalid ticker "${ticker}"`);
    return null;
  }
  if (!VALID_ACTIONS.includes(action)) {
    console.warn(`[SIGNAL] Format-A rejected: invalid action "${action}"`);
    return null;
  }

  direction = action === 'BUY_CALLS' ? 'calls'
            : action === 'BUY_PUTS'  ? 'puts'
            : 'close';

  return {
    ticker,
    action,
    direction,
    signalType:  VALID_SIGNALS.includes(signal) ? signal : 'CUSTOM',
    price:       parseFloat(body.price)   || null,
    stopPct:     parseFloat(body.stopPct) || null,
    tpPct:       parseFloat(body.tpPct)  || null,
    comment:     body.comment || '',
    raw:         body,
  };
}

module.exports = { parseSignal };
