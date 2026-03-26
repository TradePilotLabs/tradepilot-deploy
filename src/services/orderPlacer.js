const { placeOrder, cancelOrder, getOrder } = require('./tastyClient');
const { createTrade, closeTrade } = require('../data/db');
const { removePosition, incrDailyPnl } = require('../data/redis');

/**
 * Places an opening BTO (Buy to Open) order for an option contract.
 * Returns the trade record saved to the DB.
 */
async function openPosition({ userId, accountNumber, contract, quantity, signal, settings }) {
  const orderType = settings.order_type === 'limit' ? 'Limit' : 'Market';

  const order = {
    'order-type':    orderType,
    'time-in-force': 'Day',
    'price':         orderType === 'Limit' ? contract.ask : undefined, // use ask for limit
    legs: [
      {
        'instrument-type': 'Equity Option',
        'symbol':           contract.symbol,
        'quantity':         quantity,
        'action':           'Buy to Open',
      },
    ],
  };

  // Remove undefined price field for market orders
  if (order['price'] === undefined) delete order['price'];

  console.log(`[ORDER] Opening ${quantity}x ${contract.symbol} @ ${orderType}`);

  const placed = await placeOrder(userId, accountNumber, order);
  const tastyOrderId = placed?.id || placed?.['order-id'] || null;

  // Save to DB
  const trade = await createTrade({
    userId,
    symbol:        signal.ticker,
    optionSymbol:  contract.symbol,
    direction:     signal.direction,
    signalType:    signal.signalType,
    quantity,
    entryPrice:    contract.mid,
    tastyOrderId,
    rawSignal:     signal.raw,
  });

  console.log(`[ORDER] Trade created: ${trade.id} | TastyOrder: ${tastyOrderId}`);
  return trade;
}

/**
 * Places a closing STC (Sell to Close) order.
 * Updates the trade record with exit info and P&L.
 */
async function closePosition({ userId, accountNumber, position, exitReason, currentPrice }) {
  const order = {
    'order-type':    'Market',
    'time-in-force': 'Day',
    legs: [
      {
        'instrument-type': 'Equity Option',
        'symbol':           position.optionSymbol,
        'quantity':         position.quantity,
        'action':           'Sell to Close',
      },
    ],
  };

  console.log(`[ORDER] Closing ${position.quantity}x ${position.optionSymbol} | Reason: ${exitReason}`);

  try {
    await placeOrder(userId, accountNumber, order);
  } catch (err) {
    console.error(`[ORDER] Close order failed for ${position.optionSymbol}:`, err.message);
    // Still remove from Redis and log — position may have already been closed
  }

  // Calculate P&L
  const exitPrice = currentPrice || position.entryPrice;
  const pnl = calcPnl(position.entryPrice, exitPrice, position.quantity);

  // Update DB trade record
  await closeTrade(position.tradeId, { exitPrice, exitReason, pnl });

  // Remove from Redis
  await removePosition(userId, position.tradeId);

  // Update daily P&L cache
  await incrDailyPnl(userId, pnl);

  console.log(`[ORDER] Position closed | P&L: $${pnl.toFixed(2)} | Reason: ${exitReason}`);
  return { pnl, exitPrice };
}

/**
 * Closes ALL open positions for a user (used by kill switch + market close job).
 */
async function closeAllPositions({ userId, accountNumber, positions, exitReason }) {
  const results = [];
  for (const pos of positions) {
    try {
      const result = await closePosition({
        userId,
        accountNumber,
        position: pos,
        exitReason,
        currentPrice: null,
      });
      results.push({ success: true, tradeId: pos.tradeId, ...result });
    } catch (err) {
      console.error(`[ORDER] Failed to close position ${pos.tradeId}:`, err.message);
      results.push({ success: false, tradeId: pos.tradeId, error: err.message });
    }
  }
  return results;
}

/**
 * P&L calculation for options:
 * (exitPrice - entryPrice) * quantity * 100 shares per contract
 */
function calcPnl(entryPrice, exitPrice, quantity) {
  return parseFloat(((exitPrice - entryPrice) * quantity * 100).toFixed(2));
}

module.exports = { openPosition, closePosition, closeAllPositions, calcPnl };
