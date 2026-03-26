/**
 * TradingView sends a webhook POST with a JSON body.
 * The alert message in TradingView should be set to:
 *
 * {
 *   "ticker":    "{{ticker}}",
 *   "action":    "BUY_CALLS",
 *   "signal":    "A1",
 *   "price":     {{close}},
 *   "stopPct":   40,
 *   "tpPct":     80,
 *   "comment":   "{{strategy.order.comment}}"
 * }
 *
 * action values:  BUY_CALLS | BUY_PUTS | CLOSE_ALL
 * signal values:  A1 | A2 | B1 | B2 | C1 | C2 | D1 | D2
 */

const VALID_ACTIONS  = ['BUY_CALLS', 'BUY_PUTS', 'CLOSE_ALL'];
const VALID_TICKERS  = ['SPY', 'QQQ'];
const VALID_SIGNALS  = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'];

function parseSignal(body) {
  if (!body || typeof body !== 'object') return null;

  const ticker = (body.ticker || '').toUpperCase().trim();
  const action = (body.action || '').toUpperCase().trim();
  const signal = (body.signal || '').toUpperCase().trim();

  // Validate required fields
  if (!VALID_TICKERS.includes(ticker)) {
    console.warn(`Signal rejected: invalid ticker "${ticker}"`);
    return null;
  }
  if (!VALID_ACTIONS.includes(action)) {
    console.warn(`Signal rejected: invalid action "${action}"`);
    return null;
  }

  // Map action to direction
  const direction = action === 'BUY_CALLS' ? 'calls'
                  : action === 'BUY_PUTS'  ? 'puts'
                  : 'close';

  return {
    ticker,
    action,
    direction,
    signalType:   VALID_SIGNALS.includes(signal) ? signal : 'CUSTOM',
    price:        parseFloat(body.price) || null,
    stopPct:      parseFloat(body.stopPct) || null,    // override user setting if provided
    tpPct:        parseFloat(body.tpPct)  || null,    // override user setting if provided
    comment:      body.comment || '',
    raw:          body,
  };
}

module.exports = { parseSignal };
