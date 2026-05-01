const { placeOrder, cancelOrder, getOrder, placeComplexOrder, cancelComplexOrder } = require('./tastyClient');
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
    symbol:        signal.ticker,
    optionSymbol:  contract.symbol,
    direction:     signal.direction,
    signalType:    signal.signalType,
    quantity,
    entryPrice:    contract.mid,
    tastyOrderId,
    rawSignal:     signal.raw,
    stopPct:       settings.stop_loss_pct     ?? null,
    tpPct:         settings.take_profit_pct   ?? null,
    exitStrategy:  settings.exit_strategy     ?? null,
  });

  console.log(`[ORDER] Trade created: ${trade.id} | TastyOrder: ${tastyOrderId}`);

  // Background: check fill status quickly (30s) then again at fill timeout.
  // Captures actual fill price and cancels unfilled orders within the limit.
  if (tastyOrderId) {
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
  // Quick check at 30s — captures fill price for most orders before any manual action
  await new Promise(r => setTimeout(r, 30_000));
  const quickFill = await tryCaptureFill(userId, accountNumber, tastyOrderId, tradeId);
  if (quickFill) return;

  // Full timeout check
  await new Promise(r => setTimeout(r, (timeoutMin * 60 - 30) * 1000));

  await tryCaptureFill(userId, accountNumber, tastyOrderId, tradeId, true /* cancel if unfilled */);
}

/**
 * Check order fill status. Returns true if filled (entry price updated).
 * If cancelIfUnfilled=true and order isn't filled, cancels and voids the trade.
 */
async function tryCaptureFill(userId, accountNumber, tastyOrderId, tradeId, cancelIfUnfilled = false) {
  let order;
  try { order = await getOrder(userId, accountNumber, tastyOrderId); }
  catch { return false; }

  const status    = (order?.status || '').toLowerCase();
  // Fill price is in legs[0].fills[0]['fill-price'] (avg-fill-price field is absent in REST response)
  const fillPrice = parseFloat(order?.legs?.[0]?.fills?.[0]?.['fill-price'] || 0);

  if (status === 'filled' && fillPrice > 0) {
    await updateTradeEntryPrice(tradeId, fillPrice);
    await updatePosition(userId, tradeId, { entryPrice: fillPrice, peakPrice: fillPrice })
      .catch(() => {});
    console.log(`[ORDER] Fill captured: trade ${tradeId} @ $${fillPrice}`);

    // Place exit orders (OCO bracket or initial stop) now that we have the real fill price
    const pos = await require('../data/redis').getPosition(userId, tradeId).catch(() => null);
    if (pos) {
      await placeExitOrders({ userId, accountNumber, position: { ...pos, entryPrice: fillPrice } })
        .catch(err => console.error('[ORDER] Exit order placement failed:', err.message));
    }
    return true;
  }

  if (cancelIfUnfilled && status !== 'filled') {
    try { await cancelOrder(userId, accountNumber, tastyOrderId); } catch {}
    await cancelTrade(tradeId);
    await removePosition(userId, tradeId).catch(() => {});
    console.log(`[ORDER] Order ${tastyOrderId} unfilled — trade cancelled, daily slot freed`);
  }
  return false;
}

/**
 * Place exit orders after a BTO fill is confirmed.
 *
 * OCO mode:  Place a TastyTrade complex OCO order immediately —
 *   - Limit "Sell to Close" at take-profit price  (Credit)
 *   - Stop  "Sell to Close" at stop-loss price     (Credit)
 *   TastyTrade manages the exit; when one fires the other cancels.
 *
 * Trailing mode: Place an initial Stop order at the stop-loss price.
 *   The position monitor cancels/replaces it as the peak price rises.
 */
async function placeExitOrders({ userId, accountNumber, position }) {
  const { getOrCreateSettings, updateComplexOrderId } = require('../data/db');
  const settings = await getOrCreateSettings(userId);

  const exitStrategy = settings.exit_strategy || 'oco';
  const entryPrice   = parseFloat(position.entryPrice);
  const qty          = position.quantity;
  const sym          = position.optionSymbol;

  if (!entryPrice || entryPrice <= 0) return;

  const stopPct = position.stopPct || settings.stop_loss_pct || 40;
  const tpPct   = position.tpPct   || settings.take_profit_pct || 60;

  const stopPrice = parseFloat((entryPrice * (1 - Math.abs(stopPct) / 100)).toFixed(2));
  const tpPrice   = parseFloat((entryPrice * (1 + Math.abs(tpPct)   / 100)).toFixed(2));

  const leg = {
    'instrument-type': 'Equity Option',
    symbol:             sym,
    quantity:           qty,
    action:             'Sell to Close',
  };

  if (exitStrategy === 'oco') {
    // ── OCO bracket: TP Limit + SL Stop ───────────────────────
    try {
      const result = await placeComplexOrder(userId, accountNumber, {
        type:   'OCO',
        orders: [
          {
            'order-type':    'Limit',
            'time-in-force': 'Day',
            'price':          tpPrice.toFixed(2),
            'price-effect':   'Credit',
            legs:             [leg],
          },
          {
            'order-type':    'Stop',
            'time-in-force': 'Day',
            'stop-trigger':   stopPrice.toFixed(2),
            'price-effect':   'Credit',
            legs:             [leg],
          },
        ],
      });
      const complexId = result?.['id'] || result?.['complex-order-id'] || null;
      if (complexId) {
        await updatePosition(userId, position.tradeId, { complexOrderId: complexId, tpPrice, stopPrice });
        if (updateComplexOrderId) await updateComplexOrderId(position.tradeId, complexId);
        console.log(`[ORDER] OCO bracket placed: complex=${complexId} TP=$${tpPrice} SL=$${stopPrice}`);
      }
    } catch (err) {
      console.error('[ORDER] OCO placement failed:', err.message);
    }
  } else {
    // ── Trailing: place initial stop order ────────────────────
    try {
      const placed = await placeOrder(userId, accountNumber, {
        'order-type':    'Stop',
        'time-in-force': 'Day',
        'stop-trigger':   stopPrice.toFixed(2),
        'price-effect':   'Credit',
        legs:             [leg],
      });
      const stopOrderId = placed?.id || placed?.['order-id'] || null;
      if (stopOrderId) {
        await updatePosition(userId, position.tradeId, { stopOrderId, stopPrice });
        console.log(`[ORDER] Initial stop placed: order=${stopOrderId} SL=$${stopPrice}`);
      }
    } catch (err) {
      console.error('[ORDER] Initial stop placement failed:', err.message);
    }
  }
}

/**
 * Places a closing STC (Sell to Close) market order.
 *
 * If the position has active exit orders at TastyTrade (OCO complex order
 * or trailing stop order), those must be cancelled FIRST — otherwise TT
 * rejects the manual close with a preflight failure because the position
 * would be "double-covered".
 */
async function closePosition({ userId, accountNumber, position, exitReason, currentPrice }) {
  // ── Cancel any existing exit orders before placing manual close ──
  if (position.complexOrderId) {
    try {
      await cancelComplexOrder(userId, accountNumber, position.complexOrderId);
      console.log(`[ORDER] Cancelled OCO complex order ${position.complexOrderId} before manual close`);
    } catch (err) {
      // May already be filled/cancelled — log and continue
      console.warn(`[ORDER] Could not cancel OCO ${position.complexOrderId}: ${err.message}`);
    }
  }

  if (position.stopOrderId) {
    try {
      await cancelOrder(userId, accountNumber, position.stopOrderId);
      console.log(`[ORDER] Cancelled stop order ${position.stopOrderId} before manual close`);
    } catch (err) {
      console.warn(`[ORDER] Could not cancel stop ${position.stopOrderId}: ${err.message}`);
    }
  }

  // ── Small delay to let TT process cancellations ──────────────
  if (position.complexOrderId || position.stopOrderId) {
    await new Promise(r => setTimeout(r, 500));
  }

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

  let closedAtBroker = false;
  try {
    await placeOrder(userId, accountNumber, order);
    closedAtBroker = true;
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('uncovered') || msg.includes('not approved')) {
      // Position already gone at broker (expired / manually closed there)
      console.warn(`[ORDER] Close order rejected — position already gone at broker: ${msg}`);
      closedAtBroker = true; // treat as closed since it no longer exists
    } else if (msg.includes('preflight')) {
      // Preflight failed — log the full error so we can debug
      console.error(`[ORDER] Close order preflight failed for ${position.optionSymbol}: ${msg}`);
      // Don't clean up locally — position still open at TT
      throw err;
    } else {
      console.error(`[ORDER] Close order failed for ${position.optionSymbol}:`, msg);
      throw err;
    }
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
