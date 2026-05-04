const { getAllOpenPositions, updatePosition } = require('../data/redis');
const { getPositions, getOrder, placeOrder, cancelOrder } = require('./tastyClient');
const { getClient: getDxFeedClient, priceHub } = require('./dxFeedClient');
const { closePosition }                      = require('./orderPlacer');
const { checkKillSwitch }                     = require('./killSwitch');
const { getOrCreateSettings, getTastyTokens,
        getTodayRealizedPnl, updateTradeEntryPrice } = require('../data/db');

const POLL_INTERVAL_MS = 5000;
let   monitorInterval  = null;

function startPositionMonitor() {
  if (monitorInterval) return;
  console.log(`✓ Position monitor started (${POLL_INTERVAL_MS/1000}s interval, DXFeed streaming)`);
  monitorInterval = setInterval(runMonitorCycle, POLL_INTERVAL_MS);
}

function stopPositionMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

async function runMonitorCycle() {
  try {
    const positions = await getAllOpenPositions();
    if (!positions.length) {
      // Log once per minute so we can see the monitor is alive but finding nothing
      if (Date.now() % 60000 < 5000) {
        console.log('[MONITOR] No open positions in Redis');
      }
      return;
    }
    console.log(`[MONITOR] Cycle: ${positions.length} position(s) found`);

    const byUser = {};
    for (const pos of positions) {
      if (!byUser[pos.userId]) byUser[pos.userId] = [];
      byUser[pos.userId].push(pos);
    }

    for (const [userId, userPositions] of Object.entries(byUser)) {
      await checkUserPositions(userId, userPositions);
    }
  } catch (err) {
    console.error('[MONITOR] Cycle error:', err.message);
  }
}

async function checkUserPositions(userId, positions) {
  const [settings, tokens] = await Promise.all([
    getOrCreateSettings(userId),
    getTastyTokens(userId),
  ]);
  if (!tokens?.account_number) return;
  const accountNumber = tokens.account_number;

  // ── 1. Real-time prices via TastyTrade DXFeed WebSocket ──────
  // DXFeed streams Quote events (bid/ask) for each subscribed symbol.
  // Mid = (bid + ask) / 2. Updates are near-instantaneous from the exchange.
  const priceMap    = {};
  let brokerSymbols = new Set();

  // Get (or start) the DXFeed streaming client for this user
  let dxClient = null;
  try {
    dxClient = await getDxFeedClient(userId);
    // Ensure all open positions are subscribed
    for (const pos of positions) {
      dxClient.subscribe(pos.optionSymbol);
    }
    // Read latest prices from the streaming client
    for (const pos of positions) {
      const price = dxClient.getPrice(pos.optionSymbol);
      if (price && price > 0) priceMap[pos.optionSymbol] = price;
    }
  } catch (err) {
    console.error(`[MONITOR] DXFeed unavailable for ${userId}: ${err.message}`);
  }

  // Fetch broker positions for reconciliation (which symbols still exist at TT)
  let brokerPositions = [];
  let brokerFetched   = false;
  try {
    brokerPositions = await getPositions(userId, accountNumber);
    brokerSymbols   = new Set(brokerPositions.map(p => p['symbol']));
    brokerFetched   = true;

    // Use TastyTrade mark as fallback when DXFeed hasn't received a price yet
    for (const bp of brokerPositions) {
      const sym  = bp['symbol'];
      const mark = parseFloat(bp['mark'] || bp['mark-price'] || bp['close-price'] || 0);
      if (sym && mark > 0 && !priceMap[sym]) {
        priceMap[sym] = mark;
        console.log(`[MONITOR] Broker mark for ${sym}: $${mark}`);
      }
    }
  } catch (err) {
    console.error(`[MONITOR] Broker position fetch failed for ${userId}:`, err.message);
  }

  // Write current price to Redis and push to SSE stream
  for (const pos of positions) {
    const price = priceMap[pos.optionSymbol];
    if (price && price > 0) {
      if (price !== pos.currentPrice) {
        await updatePosition(userId, pos.tradeId, { currentPrice: price });
        pos.currentPrice = price;
      }
      // Always emit so the SSE stream gets broker marks when dxFeed is quiet
      priceHub.emit(userId, pos.optionSymbol, price);
    }
  }

  // ── 2. Recover missing entry prices from TastyTrade fill ─────
  for (const pos of positions) {
    if (!pos.entryPrice && pos.tastyOrderId) {
      try {
        const order = await getOrder(userId, accountNumber, pos.tastyOrderId);
        // Fill price lives in legs[0].fills[0]['fill-price']
        const fill = parseFloat(order?.legs?.[0]?.fills?.[0]?.['fill-price'] || 0);
        if (fill > 0) {
          await updatePosition(userId, pos.tradeId, { entryPrice: fill, peakPrice: fill });
          await updateTradeEntryPrice(pos.tradeId, fill);
          pos.entryPrice = fill;
          pos.peakPrice  = fill;
          console.log(`[MONITOR] Entry price recovered: ${pos.optionSymbol} @ $${fill}`);
        }
      } catch { /* order may still be pending */ }
    }
  }

  // ── 3. Reconcile: detect positions closed outside TradePilot ─
  // Run whenever we successfully fetched broker state — even if 0 positions.
  // This catches OCO/stop-loss fills that close the position at TastyTrade
  // without going through our close flow.

  if (brokerFetched) {
    for (const pos of positions) {
      if (!brokerSymbols.has(pos.optionSymbol)) {
        const lastPrice = priceMap[pos.optionSymbol] ?? pos.entryPrice ?? 0;
        const reason    = isExpired(pos.optionSymbol) ? 'expired' : 'manual_close';
        console.log(`[MONITOR] ${pos.optionSymbol} not found at broker — ${reason}`);
        // Don't send a STC order — the position is already gone at the broker.
        // Just sync TradePilot's records.
        await closeLocalPosition({ userId, position: pos, exitReason: reason, exitPrice: lastPrice });
      }
    }
    // Re-filter to only positions still open after reconciliation
    positions = positions.filter(p => brokerSymbols.has(p.optionSymbol));
  }

  // ── 4. Kill-switch check ─────────────────────────────────────
  const realizedPnl = await getTodayRealizedPnl(userId);
  let unrealizedPnl = 0;
  for (const pos of positions) {
    const cur = priceMap[pos.optionSymbol] || pos.entryPrice || 0;
    if (pos.entryPrice) unrealizedPnl += (cur - pos.entryPrice) * pos.quantity * 100;
  }

  const killCheck = checkKillSwitch(settings, realizedPnl, unrealizedPnl);
  if (killCheck.tripped && killCheck.flatten) {
    console.log(`[MONITOR] Kill switch for user ${userId}: ${killCheck.reason}`);
    for (const pos of positions) {
      const cur = priceMap[pos.optionSymbol] || pos.entryPrice;
      await closePosition({ userId, accountNumber, position: pos,
        exitReason: 'kill_switch', currentPrice: cur });
    }
    return;
  }

  // ── 5. Per-position exit checks ──────────────────────────────
  for (const pos of positions) {
    const currentPrice = priceMap[pos.optionSymbol];
    if (!currentPrice) continue;
    await checkExitConditions({ userId, accountNumber, pos, currentPrice, settings });
  }
}

async function checkExitConditions({ userId, accountNumber, pos, currentPrice, settings }) {
  const entryPrice    = pos.entryPrice;
  if (!entryPrice || entryPrice <= 0) return;

  const exitStrategy  = pos.exitStrategy || settings.exit_strategy || 'oco';

  // For OCO positions TastyTrade manages TP/SL directly — only enforce hard stop
  // and update the trailing stop order if price moves in our favor.
  if (exitStrategy === 'oco') {
    // Hard stop only — OCO bracket handles TP and normal SL
    const stopPct  = pos.stopPct || settings.stop_loss_pct || 40;
    const pricePct = ((currentPrice - entryPrice) / entryPrice) * 100;
    if (pricePct <= -Math.abs(stopPct)) {
      console.log(`[MONITOR] Hard stop (OCO fallback) | ${pos.optionSymbol} | ${pricePct.toFixed(1)}%`);
      await closePosition({ userId, accountNumber, position: pos, exitReason: 'stop_loss', currentPrice });
    }
    return;
  }

  const pricePct = ((currentPrice - entryPrice) / entryPrice) * 100;

  // Track peak — if price moved up and trailing mode, update the stop order at TT
  if (currentPrice > (pos.peakPrice || entryPrice)) {
    await updatePosition(userId, pos.tradeId, { peakPrice: currentPrice, currentPrice });
    pos.peakPrice = currentPrice;

    // Update the live stop order at TastyTrade when peak advances
    if (pos.stopOrderId) {
      const stopPct    = pos.stopPct || settings.stop_loss_pct || 40;
      const newStop    = parseFloat((currentPrice * (1 - Math.abs(stopPct) / 100)).toFixed(2));
      await updateTrailingStop({ userId, accountNumber, pos, newStop });
    }
  }
  const peakPrice = pos.peakPrice || entryPrice;
  const peakPct   = ((peakPrice - entryPrice) / entryPrice) * 100;

  let exitReason = null;

  // ── Hard stop loss (always active) ──────────────────────────
  const stopPct = pos.stopPct || settings.stop_loss_pct || 50;
  if (pricePct <= -Math.abs(stopPct)) {
    exitReason = 'stop_loss';
  }

  // ── Fixed take profit (when trailing is not active) ──────────
  // tpPct comes from signal or user's take_profit_pct setting
  else if (pos.tpPct && pricePct >= pos.tpPct) {
    exitReason = 'take_profit';
  }

  // ── Active trade time limit ──────────────────────────────────
  else if (settings.active_trade_time_limit && pos.openedAt) {
    const openMin = (Date.now() - new Date(pos.openedAt).getTime()) / 60_000;
    if (openMin >= settings.active_trade_time_limit) {
      exitReason = 'time_limit';
    }
  }

  // ── Trailing tiers (multi-tier) ──────────────────────────────
  if (!exitReason && settings.multi_tier_enabled && settings.trailing_tiers?.length) {
    const tiers = [...settings.trailing_tiers].sort((a, b) => a.profitTrigger - b.profitTrigger);
    const activeTier = tiers.filter(t => peakPct >= t.profitTrigger).pop();
    if (activeTier) {
      const pullback = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (pullback >= activeTier.trailPercent) {
        exitReason = 'trailing_stop';
        console.log(`[MONITOR] Tier hit: trigger=${activeTier.profitTrigger}% trail=${activeTier.trailPercent}% pullback=${pullback.toFixed(1)}%`);
      }
    }
  }

  // ── Single-level trailing stop ───────────────────────────────
  else if (!exitReason && settings.trailing_enabled) {
    const triggerPct = settings.trailing_trigger_pct || 4;
    if (peakPct >= triggerPct) {
      const pullback = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (settings.trailing_mode === 'dynamic') {
        const multiplier = settings.trailing_stop_multiplier ?? 0.95;
        if (currentPrice <= peakPrice * multiplier) exitReason = 'trailing_stop';
      } else {
        const trailPct = settings.trailing_pct || 20;
        if (pullback >= trailPct) exitReason = 'trailing_stop';
      }
      if (!exitReason && settings.break_even_enabled && currentPrice <= entryPrice) {
        exitReason = 'break_even';
      }
    }
  }

  if (exitReason) {
    console.log(
      `[MONITOR] ${exitReason} | ${pos.optionSymbol} | ` +
      `Entry: $${entryPrice} | Current: $${currentPrice} | Change: ${pricePct.toFixed(1)}%`
    );
    await closePosition({ userId, accountNumber, position: pos, exitReason, currentPrice });
  }
}

// Cancel the existing stop order and place a new one at the updated trail level.
async function updateTrailingStop({ userId, accountNumber, pos, newStop }) {
  if (!pos.stopOrderId || !pos.stopPrice) return;
  if (newStop <= pos.stopPrice) return; // only move stop UP, never down

  try {
    await cancelOrder(userId, accountNumber, pos.stopOrderId);
  } catch { /* may already be filled/cancelled */ }

  try {
    const leg = {
      'instrument-type': 'Equity Option',
      symbol:             pos.optionSymbol,
      quantity:           pos.quantity,
      action:             'Sell to Close',
    };
    const placed = await placeOrder(userId, accountNumber, {
      'order-type':    'Stop',
      'time-in-force': 'Day',
      'stop-trigger':   newStop.toFixed(2),
      'price-effect':   'Credit',
      legs:             [leg],
    });
    const newOrderId = placed?.id || placed?.['order-id'] || null;
    if (newOrderId) {
      await updatePosition(userId, pos.tradeId, { stopOrderId: newOrderId, stopPrice: newStop });
      pos.stopOrderId = newOrderId;
      pos.stopPrice   = newStop;
      console.log(`[MONITOR] Trailing stop moved to $${newStop} (order ${newOrderId})`);
    }
  } catch (err) {
    console.error('[MONITOR] Trail stop update failed:', err.message);
  }
}

// Close a position in TradePilot records without placing a broker order.
// Used when we know the broker position is already gone (expired, manual close).
async function closeLocalPosition({ userId, position, exitReason, exitPrice }) {
  const { closeTrade, updateTradeEntryPrice } = require('../data/db');
  const { removePosition, incrDailyPnl } = require('../data/redis');
  const { calcPnl, tryCaptureFill } = require('./orderPlacer');

  // Try to backfill entry price from TastyTrade order fill if missing
  let entryPrice = position.entryPrice;
  if (!entryPrice && position.tastyOrderId && position.accountNumber) {
    try {
      const order = await require('./tastyClient').getOrder(userId, position.accountNumber, position.tastyOrderId);
      const fill  = parseFloat(order?.['avg-fill-price'] || 0);
      if (fill > 0) {
        await updateTradeEntryPrice(position.tradeId, fill);
        entryPrice = fill;
        console.log(`[MONITOR] Entry price recovered at close: $${fill}`);
      }
    } catch {}
  }

  const pnl = entryPrice ? calcPnl(entryPrice, exitPrice ?? 0, position.quantity) : 0;
  await closeTrade(position.tradeId, { exitPrice: exitPrice ?? 0, exitReason, pnl });
  await removePosition(userId, position.tradeId);
  await incrDailyPnl(userId, pnl);
  console.log(`[MONITOR] Local close: ${position.optionSymbol} | Reason: ${exitReason} | P&L: $${pnl.toFixed(2)}`);
}

// Extract YYMMDD from OCC symbol and check if the expiry date is in the past.
// "SPY   260430C00715000" → expiry = 2026-04-30
function isExpired(occSym) {
  const m = (occSym || '').trim().match(/^[A-Z]+(\d{2})(\d{2})(\d{2})[CP]/i);
  if (!m) return false;
  const [, yy, mm, dd] = m;
  const expiry = new Date(`20${yy}-${mm}-${dd}T21:00:00Z`); // options expire at ~5 PM ET
  return Date.now() > expiry.getTime();
}

module.exports = { startPositionMonitor, stopPositionMonitor, runMonitorCycle };
