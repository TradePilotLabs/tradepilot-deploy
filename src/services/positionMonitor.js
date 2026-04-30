const { getAllOpenPositions, updatePosition } = require('../data/redis');
const { getQuotes }                           = require('./tastyClient');
const { closePosition }                       = require('./orderPlacer');
const { checkKillSwitch }                     = require('./killSwitch');
const { getOrCreateSettings, getTastyTokens, getTodayRealizedPnl } = require('../data/db');

const POLL_INTERVAL_MS = 8000;
let   monitorInterval  = null;

function startPositionMonitor() {
  if (monitorInterval) return;
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

  const symbols = positions.map(p => p.optionSymbol);
  let quotes = [];
  try {
    quotes = await getQuotes(userId, symbols);
  } catch (err) {
    console.error(`[MONITOR] Quote fetch failed for user ${userId}:`, err.message);
    return;
  }

  const priceMap = {};
  for (const q of quotes) {
    const sym  = q['symbol'];
    const mark = parseFloat(q['mark'] || q['last-price'] || 0);
    priceMap[sym] = mark;
  }

  const realizedPnl = await getTodayRealizedPnl(userId);
  let unrealizedPnl = 0;
  for (const pos of positions) {
    const cur = priceMap[pos.optionSymbol] || pos.entryPrice;
    unrealizedPnl += (cur - pos.entryPrice) * pos.quantity * 100;
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

  // Track peak price
  if (currentPrice > (pos.peakPrice || entryPrice)) {
    await updatePosition(userId, pos.tradeId, { peakPrice: currentPrice });
    pos.peakPrice = currentPrice;
  }
  const peakPrice = pos.peakPrice || entryPrice;
  const peakPct   = ((peakPrice - entryPrice) / entryPrice) * 100;

  let exitReason = null;

  // ── 1. Hard stop loss ────────────────────────────────────────
  const stopPct = pos.stopPct || settings.stop_loss_pct;
  if (pricePct <= -Math.abs(stopPct)) {
    exitReason = 'stop_loss';
  }

  // ── 2. Fixed take profit ─────────────────────────────────────
  else if (pos.tpPct && pricePct >= pos.tpPct) {
    exitReason = 'take_profit';
  }

  // ── 3. Active trade time limit ───────────────────────────────
  else if (settings.active_trade_time_limit && pos.openedAt) {
    const openMin = (Date.now() - new Date(pos.openedAt).getTime()) / 60_000;
    if (openMin >= settings.active_trade_time_limit) {
      exitReason = 'time_limit';
    }
  }

  // ── 4. Trailing tiers (multi-tier) ───────────────────────────
  if (!exitReason && settings.multi_tier_enabled && settings.trailing_tiers?.length) {
    const tiers = [...settings.trailing_tiers]
      .sort((a, b) => a.profitTrigger - b.profitTrigger);

    // Find highest tier that has been triggered by the peak
    const activeTier = tiers.filter(t => peakPct >= t.profitTrigger).pop();

    if (activeTier) {
      const pullbackFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
      if (pullbackFromPeak >= activeTier.trailPercent) {
        exitReason = 'trailing_stop';
        console.log(
          `[MONITOR] Trailing tier hit: trigger=${activeTier.profitTrigger}% ` +
          `trail=${activeTier.trailPercent}% pullback=${pullbackFromPeak.toFixed(1)}%`
        );
      }
    }
  }

  // ── 5. Single-level trailing stop ───────────────────────────
  else if (!exitReason && settings.trailing_enabled) {
    const triggerPct = settings.trailing_trigger_pct || 4;

    if (peakPct >= triggerPct) {
      const pullbackFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;

      if (settings.trailing_mode === 'dynamic') {
        // Dynamic: exit if price drops below peak × multiplier
        const multiplier = settings.trailing_stop_multiplier ?? 0.95;
        if (currentPrice <= peakPrice * multiplier) {
          exitReason = 'trailing_stop';
        }
      } else {
        // Static: exit if pullback from peak exceeds trail %
        const trailPct = settings.trailing_pct || 20;
        if (pullbackFromPeak >= trailPct) {
          exitReason = 'trailing_stop';
        }
      }

      // Break-even: move stop to entry once trigger hit
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

module.exports = { startPositionMonitor, stopPositionMonitor, runMonitorCycle };
