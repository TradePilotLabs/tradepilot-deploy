const { placeOrder, cancelOrder, getOrder } = require('./tastyClient');
const { createTrade, closeTrade, cancelTrade, updateTradeEntryPrice } = require('../data/db');
const { removePosition, updatePosition, incrDailyPnl } = require('../data/redis');

/**
 * Places an opening BTO (Buy to Open) order for an option contract.
 *
 * Order type logic:
 *   - Ask price known  → Limit at ask  (market-equivalent, protects against slippage)
 *   - Ask price unknown → Market order  (let broker execute at best available)
 *   - limit_entry=true  → always Limit (at ask, or max_contract_cost if no price)
 *
 * max_contract_cost is a filter ceiling (enforced in contractSelector before we
 * get here) — it is NOT used as the order limit price.
 */
async function openPosition({ userId, accountNumber, contract, quantity, signal, settings }) {
  const hasPrice   = contract.ask !== null && contract.ask !== undefined;
  const wantsLimit = settings.limit_entry || settings.order_type === 'limit';

  let orderType, limitPrice;

  if (wantsLimit) {
    // User explicitly wants limit entry
    orderType  = 'Limit';
    limitPrice = contract.ask ?? settings.max_contract_cost ?? 2.50;
  } else if (hasPrice) {
    // Price known — use limit at ask (fills like market, no slippage)
    orderType  = 'Limit';
    limitPrice = contract.ask;
  } else {
    // No price available — true market order
    orderType  = 'Market';
    limitPrice = undefined;
  }

  const order = {
    'order-type':    orderType,
    'time-in-force': 'Day',
    'price-effect':  'Debit',
    legs: [
      {
        'instrument-type': 'Equity Option',
        'symbol':           contract.symbol,
        'quantity':         quantity,
        'action':           'Buy to Open',
      },
    ],
  };

  if (limitPrice !== undefined) order['price'] = limitPrice;

  console.log(`[ORDER] Opening ${quantity}x ${contract.symbol} @ ${orderType}${limitPrice !== undefined ? ` $${limitPrice}` : ''}`);

  const placed      = await placeOrder(userId, accountNumber, order);
  const tastyOrderId = placed?.id || placed?.['order-id'] || null;

  // Save to DB — entry_price filled later once order confirms
  const trade = await createTrade({
    userId,
    symbol:       signal.ticker,
    optionSymbol: contract.symbol,
    direction:    signal.direction,
    signalType:   signal.signalType,
    quantity,
    entryPrice:   contract.mid,
    tastyOrderId,
    rawSignal:    signal.raw,
  });

  console.log(`[ORDER] Trade created: ${trade.id} | TastyOrder: ${tastyOrderId}`);

  // For limit orders: background fill-timeout check.
  // If the order isn't filled within order_fill_timeout minutes, cancel it
  // so it doesn't count toward the user's daily trade limit.
  if (orderType === 'Limit' && tastyOrderId) {
    const timeoutMin = settings.order_fill_timeout ?? 3;
    watchOrderFill({ userId, accountNumber, tastyOrderId, tradeId: trade.id, timeoutMin })
      .catch(err => console.error('[ORDER] Fill watch error:', err.message));
  }

  return trade;
}

/**
 * Background: wait for order_fill_timeout minutes, then check fill status.
 * If the order is still open/pending, cancel it and mark the trade cancelled
 * so it doesn't count toward the user's daily trade limit.
 */
async function watchOrderFill({ userId, accountNumber, tastyOrderId, tradeId, timeoutMin }) {
  await new Promise(r => setTimeout(r, timeoutMin * 60 * 1000));

  let order;
  try {
    order = await getOrder(userId, accountNumber, tastyOrderId);
  } catch {
    return; // Can't check — leave trade as-is
  }

  const status = (order?.status || '').toLowerCase();

  if (status === 'filled') {
    // Backfill the entry price from the actual fill
    const fillPrice = parseFloat(order?.['avg-fill-price'] || 0);
    if (fillPrice > 0) {
      await updateTradeEntryPrice(tradeId, fillPrice);
      await updatePosition(userId, tradeId, { entryPrice: fillPrice, peakPrice: fillPrice })
        .catch(() => {}); // position may already be gone
      console.log(`[ORDER] Fill confirmed: trade ${tradeId} @ $${fillPrice}`);
    }
    return;
  }

  // Order not filled — cancel it and free up the daily trade slot
  try {
    await cancelOrder(userId, accountNumber, tastyOrderId);
  } catch { /* may already be cancelled or expired */ }

  await cancelTrade(tradeId);
  await removePosition(userId, tradeId).catch(() => {});
  console.log(`[ORDER] Limit order ${tastyOrderId} unfilled after ${timeoutMin}min — cancelled, daily slot freed`);
}

/**
 * Places a closing STC (Sell to Close) order.
 */
async function closePosition({ userId, accountNumber, position, exitReason, currentPrice }) {
  const order = {
    'order-type':    'Market',
    'time-in-force': 'Day',
    'price-effect':  'Credit',
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
  }

  const exitPrice = currentPrice || position.entryPrice;
  const pnl       = calcPnl(position.entryPrice, exitPrice, position.quantity);

  await closeTrade(position.tradeId, { exitPrice, exitReason, pnl });
  await removePosition(userId, position.tradeId);
  await incrDailyPnl(userId, pnl);

  console.log(`[ORDER] Position closed | P&L: $${pnl.toFixed(2)} | Reason: ${exitReason}`);
  return { pnl, exitPrice };
}

async function closeAllPositions({ userId, accountNumber, positions, exitReason }) {
  const results = [];
  for (const pos of positions) {
    try {
      const result = await closePosition({ userId, accountNumber, position: pos, exitReason, currentPrice: null });
      results.push({ success: true, tradeId: pos.tradeId, ...result });
    } catch (err) {
      console.error(`[ORDER] Failed to close position ${pos.tradeId}:`, err.message);
      results.push({ success: false, tradeId: pos.tradeId, error: err.message });
    }
  }
  return results;
}

function calcPnl(entryPrice, exitPrice, quantity) {
  return parseFloat(((exitPrice - entryPrice) * quantity * 100).toFixed(2));
}

module.exports = { openPosition, closePosition, closeAllPositions, calcPnl };
