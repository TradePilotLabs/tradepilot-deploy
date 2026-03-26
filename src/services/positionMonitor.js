const { getAllOpenPositions, updatePosition } = require('../data/redis');
const { getQuotes }                           = require('./tastyClient');
const { closePosition }                       = require('./orderPlacer');
const { checkKillSwitch }                     = require('./killSwitch');
const { getOrCreateSettings, getTastyTokens, getTodayRealizedPnl } = require('../data/db');

const POLL_INTERVAL_MS = 8000; // check every 8 seconds
let   monitorInterval  = null;

function startPositionMonitor() {
  if (monitorInterval) return; // already running
  console.log('✓ Position monitor started (8s interval)');
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
    if (!positions.length) return;

    // Group by userId so we batch quote requests per user
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
  // Load user settings + tokens
  const [settings, tokens] = await Promise.all([
    getOrCreateSettings(userId),
    getTastyTokens(userId),
  ]);
  if (!tokens?.account_number) return;

  const accountNumber = tokens.account_number;

  // Get quotes for all open positions in one API call
  const symbols = positions.map(p => p.optionSymbol);
  let quotes = [];
  try {
    quotes = await getQuotes(userId, symbols);
  } catch (err) {
    console.error(`[MONITOR] Quote fetch failed for user ${userId}:`, err.message);
    return;
  }

  // Build a symbol → price map
  const priceMap = {};
  for (const q of quotes) {
    const sym   = q['symbol'];
    const mark  = parseFloat(q['mark'] || q['last-price'] || 0);
    priceMap[sym] = mark;
  }

  // Check kill switch (realized P&L)
  const realizedPnl = await getTodayRealizedPnl(userId);

  // Calculate unrealized P&L across all open positions
  let unrealizedPnl = 0;
  for (const pos of positions) {
    const currentPrice = priceMap[pos.optionSymbol] || pos.entryPrice;
    unrealizedPnl += (currentPrice - pos.entryPrice) * pos.quantity * 100;
  }

  const killCheck = checkKillSwitch(settings, realizedPnl, unrealizedPnl);
  if (killCheck.tripped && killCheck.flatten) {
    console.log(`[MONITOR] Kill switch tripped for user ${userId}: ${killCheck.reason}`);
    for (const pos of positions) {
      const currentPrice = priceMap[pos.optionSymbol] || pos.entryPrice;
      await closePosition({ userId, accountNumber, position: pos,
        exitReason: 'kill_switch', currentPrice });
    }
    return;
  }

  // Check each position individually
  for (const pos of positions) {
    const currentPrice = priceMap[pos.optionSymbol];
    if (!currentPrice) continue;
    await checkExitConditions({ userId, accountNumber, pos, currentPrice, settings });
  }
}

async function checkExitConditions({ userId, accountNumber, pos, currentPrice, settings }) {
  const entryPrice = pos.entryPrice;
  if (!entryPrice || entryPrice <= 0) return;

  const pricePct = ((currentPrice - entryPrice) / entryPrice) * 100;

  // Update peak price for trailing stop
  if (currentPrice > (pos.peakPrice || entryPrice)) {
    await updatePosition(userId, pos.tradeId, { peakPrice: currentPrice });
    pos.peakPrice = currentPrice;
  }

  let exitReason = null;

  // ── 1. Hard stop loss ───────────────────────────────────────
  const stopPct = pos.stopPct || settings.stop_loss_pct;
  if (pricePct <= -Math.abs(stopPct)) {
    exitReason = 'stop_loss';
  }

  // ── 2. Fixed take profit (from signal override) ─────────────
  else if (pos.tpPct && pricePct >= pos.tpPct) {
    exitReason = 'take_profit';
  }

  // ── 3. Trailing stop ────────────────────────────────────────
  else if (settings.trailing_enabled) {
    const peakPrice   = pos.peakPrice || entryPrice;
    const peakPct     = ((peakPrice - entryPrice) / entryPrice) * 100;
    const triggerPct  = settings.trailing_trigger_pct || 4;
    const trailPct    = settings.trailing_pct || 20;

    if (peakPct >= triggerPct) {
      // Trail is now active
      const pullbackFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (pullbackFromPeak >= trailPct) {
        exitReason = 'trailing_stop';
      }
    }

    // Break-even protection: once up trigger%, move stop to entry
    if (!exitReason && settings.break_even_enabled && peakPct >= triggerPct) {
      if (currentPrice <= entryPrice) {
        exitReason = 'break_even';
      }
    }
  }

  if (exitReason) {
    console.log(
      `[MONITOR] Exit signal: ${exitReason} | ${pos.optionSymbol} | ` +
      `Entry: $${entryPrice} | Current: $${currentPrice} | Change: ${pricePct.toFixed(1)}%`
    );
    await closePosition({ userId, accountNumber, position: pos, exitReason, currentPrice });
  }
}

module.exports = { startPositionMonitor, stopPositionMonitor, runMonitorCycle };
