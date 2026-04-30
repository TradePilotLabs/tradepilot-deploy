/**
 * Backtest engine — replays historical signals with user-specified settings.
 *
 * Each signal has a known outcome (take_profit | stop_loss | market_close | time_limit).
 * The engine recalculates position sizing and P&L based on the user's TP/SL/risk settings
 * while preserving the recorded win/loss outcome.
 *
 * This matches real trading: the same signal that hit TP in production will still
 * hit TP in the backtest (assuming the user's TP% is ≤ the original). For simplicity
 * we treat the outcome as fixed and only vary sizing and risk gates.
 */

const { isSkipDay } = require('../data/marketEvents');

const TASTY_FEE_PER_CONTRACT = 0.60;

// Walks bars to find the first minute where TP or SL was crossed.
// Returns outcome, exitPrice, pnlPct, and the bar's timestamp (exitTimeMs).
// SL wins when both are hit in the same bar (conservative — intra-bar order unknown).
function resolveFromBars(bars, entryPrice, takeProfitPct, stopLossPct, maxExitMs) {
  const tpThreshold = entryPrice * (1 + takeProfitPct / 100);
  const slThreshold = entryPrice * (1 - stopLossPct  / 100);
  const window = maxExitMs ? bars.filter(b => b.t <= maxExitMs) : bars;

  for (const bar of window) {
    if (bar.l <= slThreshold) {
      const pct = -stopLossPct / 100;
      return { outcome: 'stop_loss',   pnlPct: pct,
               exitPrice: parseFloat((entryPrice * (1 + pct)).toFixed(4)),
               exitTimeMs: bar.t };
    }
    if (bar.h >= tpThreshold) {
      const pct = takeProfitPct / 100;
      return { outcome: 'take_profit', pnlPct: pct,
               exitPrice: parseFloat((entryPrice * (1 + pct)).toFixed(4)),
               exitTimeMs: bar.t };
    }
  }

  const lastBar   = window[window.length - 1];
  const exitPrice = lastBar?.c ?? entryPrice;
  return { outcome: 'market_close',
           pnlPct:     (exitPrice - entryPrice) / entryPrice,
           exitPrice,
           exitTimeMs: lastBar?.t ?? maxExitMs };
}

function toDateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function toET(ts) {
  // Returns hour + minute fraction in ET (UTC-4 EDT / UTC-5 EST)
  const d = new Date(ts);
  // Approximate: use fixed UTC-4 (EDT). For production accuracy use a tz library.
  const etOffset = 4 * 60;
  const etMs = d.getTime() - etOffset * 60000;
  const et = new Date(etMs);
  return et.getUTCHours() + et.getUTCMinutes() / 60;
}

function parseTime(str) {
  // "08:40 AM" → hours fraction
  const [time, ampm] = str.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h + m / 60;
}

function isInSchedule(ts, schedule) {
  if (!schedule) return true;
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const d = new Date(ts);
  // Convert to ET to get correct day-of-week
  const etMs = d.getTime() - 4 * 60 * 60000;
  const et   = new Date(etMs);
  const dayName = dayNames[et.getUTCDay()];
  const daySched = schedule[dayName];
  if (!daySched || !daySched.enabled || !daySched.sessions?.length) return false;
  const etHour = toET(ts);
  return daySched.sessions.some(s => {
    const start = parseTime(s.start);
    const end   = parseTime(s.end);
    return etHour >= start && etHour <= end;
  });
}

/**
 * Run a backtest simulation.
 *
 * @param {Array}  signals  - rows from backtest_signals
 * @param {Object} settings - user backtest settings
 * @returns {Object} results
 */
function runBacktest(signals, settings) {
  const {
    startingBalance     = 10000,
    riskAllocation      = 100,        // 1-100 %
    maxCapitalPerTrade  = 1500,
    maxContractCost     = 2.50,
    minContractCost     = 0.01,
    slippage            = 0,          // %
    maxTradesPerDay     = 6,
    activeTimeLimitMin  = null,       // null = disabled
    tradeDirection      = 'any',      // any | call | put
    includeBrokerFees   = true,
    takeProfitPct       = 60,
    stopLossPct         = 50,
    schedule            = null,
    dateFrom            = null,
    dateTo              = null,
    skipMarketEvents    = {},
    killSwitch          = {},
  } = settings;

  // ── Filter signals ──────────────────────────────────────────
  let filtered = signals.slice();

  if (settings.strategySlug && settings.strategySlug !== 'all') {
    filtered = filtered.filter(s => s.strategy_slug === settings.strategySlug);
  }
  if (settings.ticker && settings.ticker !== 'all') {
    filtered = filtered.filter(s => s.ticker.toUpperCase() === settings.ticker.toUpperCase());
  }
  if (tradeDirection !== 'any') {
    filtered = filtered.filter(s => s.direction.toLowerCase() === tradeDirection.toLowerCase());
  }
  if (dateFrom) filtered = filtered.filter(s => new Date(s.signal_time) >= new Date(dateFrom));
  if (dateTo)   filtered = filtered.filter(s => new Date(s.signal_time) <= new Date(dateTo + 'T23:59:59Z'));

  filtered.sort((a, b) => new Date(a.signal_time) - new Date(b.signal_time));

  // ── Simulation state ─────────────────────────────────────────
  let balance = startingBalance;

  // Open positions: { signal, contracts, entryPrice, entryTime, exitTime, outcome, cost }
  const openTrades = [];
  const closedTrades = [];

  // Daily trackers
  const dailyRealizedPnl  = {};  // date → net P&L (after fees)
  const dailyTradeCount   = {};  // date → trades opened
  const dailyKillHit      = {};  // date → { profit: bool, loss: bool }

  let totalFees = 0;

  // Helper: close trades that exited at or before a given timestamp
  function flushClosedTrades(upToTime) {
    const still = [];
    for (const t of openTrades) {
      if (new Date(t.exitTime) <= new Date(upToTime)) {
        // Calculate exit price and P&L based on settings
        let exitPrice, pnlPct, grossPnl, fees = 0;

        // Use pre-resolved result — outcome, price, and exit time were all set at open
        exitPrice = t._resolved.exitPrice;
        pnlPct    = t._resolved.pnlPct;
        grossPnl  = t.contracts * t.entryPrice * 100 * pnlPct;

        if (includeBrokerFees) {
          fees = t.contracts * TASTY_FEE_PER_CONTRACT;
        }

        const netPnl = grossPnl - fees;
        balance += netPnl;
        totalFees += fees;

        const date = toDateStr(t.entryTime);
        dailyRealizedPnl[date] = (dailyRealizedPnl[date] || 0) + netPnl;

        closedTrades.push({
          id:          t.signal.id,
          result:      grossPnl >= 0 ? 'win' : 'loss',
          date:        date,
          strategy:    t.signal.strategy_slug,
          ticker:      t.signal.ticker,
          direction:   t.signal.direction,
          optionSymbol:t.signal.option_symbol,
          qty:         t.contracts,
          entryPrice:  t.entryPrice,
          exitPrice:   exitPrice,
          entryTime:   t.entryTime,
          exitTime:    t.exitTime,
          pnlPct:      parseFloat((pnlPct * 100).toFixed(1)),
          grossPnl:    parseFloat(grossPnl.toFixed(2)),
          fees:        parseFloat(fees.toFixed(2)),
          netPnl:      parseFloat(netPnl.toFixed(2)),
          exitReason:  t.outcome,
          durationMin: Math.round((new Date(t.exitTime) - new Date(t.entryTime)) / 60000),
        });
      } else {
        still.push(t);
      }
    }
    openTrades.length = 0;
    openTrades.push(...still);
  }

  const skippedSignals = [];

  // ── Process each signal ──────────────────────────────────────
  for (const sig of filtered) {
    const signalTime = new Date(sig.signal_time);
    const dateStr    = toDateStr(sig.signal_time);

    // Close trades that exited before this signal
    flushClosedTrades(sig.signal_time);

    // Initialize daily state
    if (!dailyTradeCount[dateStr]) dailyTradeCount[dateStr] = 0;
    if (!dailyKillHit[dateStr])    dailyKillHit[dateStr]    = { profit: false, loss: false };

    // Check realized kill switches
    const dayPnl = dailyRealizedPnl[dateStr] || 0;
    if (killSwitch.profitEnabled) {
      const target = killSwitch.profitType === '%'
        ? startingBalance * killSwitch.profitValue / 100
        : killSwitch.profitValue;
      if (dayPnl >= target) { skippedSignals.push({ ...sig, skipReason: 'kill_profit' }); continue; }
    }
    if (killSwitch.lossEnabled) {
      const limit = killSwitch.lossType === '%'
        ? -startingBalance * killSwitch.lossValue / 100
        : -killSwitch.lossValue;
      if (dayPnl <= limit) { skippedSignals.push({ ...sig, skipReason: 'kill_loss' }); continue; }
    }

    // Check schedule
    if (!isInSchedule(sig.signal_time, schedule)) {
      skippedSignals.push({ ...sig, skipReason: 'schedule' }); continue;
    }

    // Check market event skip days
    if (isSkipDay(dateStr, skipMarketEvents)) {
      skippedSignals.push({ ...sig, skipReason: 'market_event' }); continue;
    }

    // Check max trades per day
    if (dailyTradeCount[dateStr] >= maxTradesPerDay) {
      skippedSignals.push({ ...sig, skipReason: 'max_trades' }); continue;
    }

    // Skip signals with no entry price (webhook_signal_log uses option_ask)
    const rawAsk = parseFloat(sig.option_ask ?? sig.ask_price);
    if (!rawAsk || isNaN(rawAsk) || rawAsk <= 0) {
      skippedSignals.push({ ...sig, skipReason: 'missing_ask' }); continue;
    }

    // Skip signals with no Polygon bars — can't simulate TP/SL without price path
    if (!sig._bars || !sig._bars.length) {
      skippedSignals.push({ ...sig, skipReason: 'no_price_data' }); continue;
    }
    const entryPrice = parseFloat((rawAsk * (1 + slippage / 100)).toFixed(4));

    // Check contract cost limits
    if (entryPrice > maxContractCost || entryPrice < minContractCost) {
      skippedSignals.push({ ...sig, skipReason: 'contract_cost' }); continue;
    }

    // Position sizing: use % of current balance, capped by max capital
    const capital   = Math.min(riskAllocation / 100 * balance, maxCapitalPerTrade);
    const contracts = Math.floor(capital / (entryPrice * 100));
    if (contracts <= 0) {
      skippedSignals.push({ ...sig, skipReason: 'insufficient_capital' }); continue;
    }

    // Determine session end (3:44 PM ET) and optional time limit
    const d = new Date(signalTime);
    const sessionEndMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 19, 44, 0);
    const timeLimitMs  = activeTimeLimitMin
      ? signalTime.getTime() + activeTimeLimitMin * 60000
      : null;
    const maxExitMs = timeLimitMs ? Math.min(timeLimitMs, sessionEndMs) : sessionEndMs;

    // Resolve outcome NOW from Polygon bars so exit time is accurate
    const resolved = resolveFromBars(sig._bars, entryPrice, takeProfitPct, stopLossPct, maxExitMs);
    const outcome  = timeLimitMs && timeLimitMs < sessionEndMs && resolved.outcome === 'market_close'
      ? 'time_limit'
      : resolved.outcome;

    // Open trade with the actual exit time (when TP/SL bar fired, not blindly 3:44 PM)
    openTrades.push({
      signal:     sig,
      contracts,
      entryPrice,
      entryTime:  sig.signal_time,
      exitTime:   new Date(resolved.exitTimeMs ?? maxExitMs).toISOString(),
      outcome,
      cost:       contracts * entryPrice * 100,
      _resolved:  resolved,
    });

    dailyTradeCount[dateStr]++;
  }

  // Close all remaining open trades
  for (const t of openTrades) {
    let exitPrice, pnlPct, grossPnl;

    exitPrice = t._resolved.exitPrice;
    pnlPct    = t._resolved.pnlPct;
    grossPnl  = t.contracts * t.entryPrice * 100 * pnlPct;

    const fees   = includeBrokerFees ? t.contracts * TASTY_FEE_PER_CONTRACT : 0;
    const netPnl = grossPnl - fees;
    balance += netPnl;
    totalFees += fees;

    const date = toDateStr(t.entryTime);
    dailyRealizedPnl[date] = (dailyRealizedPnl[date] || 0) + netPnl;

    closedTrades.push({
      id:          t.signal.id,
      result:      grossPnl >= 0 ? 'win' : 'loss',
      date:        date,
      strategy:    t.signal.strategy_slug,
      ticker:      t.signal.ticker,
      direction:   t.signal.direction,
      optionSymbol:t.signal.option_symbol,
      qty:         t.contracts,
      entryPrice:  t.entryPrice,
      exitPrice:   exitPrice,
      entryTime:   t.entryTime,
      exitTime:    t.exitTime,
      pnlPct:      parseFloat((pnlPct * 100).toFixed(1)),
      grossPnl:    parseFloat(grossPnl.toFixed(2)),
      fees:        parseFloat(fees.toFixed(2)),
      netPnl:      parseFloat(netPnl.toFixed(2)),
      exitReason:  t.outcome,
      durationMin: Math.round((new Date(t.exitTime) - new Date(t.entryTime)) / 60000),
    });
  }

  // ── Compute stats ─────────────────────────────────────────────
  const wins   = closedTrades.filter(t => t.result === 'win');
  const losses = closedTrades.filter(t => t.result === 'loss');
  const totalPnl = balance - startingBalance;

  const totalWon  = wins.reduce((s, t)   => s + t.netPnl, 0);
  const totalLost = losses.reduce((s, t) => s + t.netPnl, 0);

  const avgWinPct  = wins.length   ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length   : 0;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  const profitFactor = Math.abs(totalLost) > 0
    ? Math.abs(totalWon / totalLost)
    : totalWon > 0 ? Infinity : 0;

  const avgDuration = closedTrades.length
    ? closedTrades.reduce((s, t) => s + t.durationMin, 0) / closedTrades.length
    : 0;

  // Max drawdown
  let peak = startingBalance, maxDrawdown = 0, maxDrawdownPct = 0;
  let runningBal = startingBalance;
  const sortedTrades = [...closedTrades].sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  for (const t of sortedTrades) {
    runningBal += t.netPnl;
    if (runningBal > peak) peak = runningBal;
    const dd = peak - runningBal;
    if (dd > maxDrawdown) {
      maxDrawdown    = dd;
      maxDrawdownPct = peak > 0 ? dd / peak : 0;
    }
  }

  // Streaks
  const tradesByTime = [...closedTrades].sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime));
  let winStreak = 0, lossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of tradesByTime) {
    if (t.result === 'win')  { curWin++; curLoss = 0; winStreak  = Math.max(winStreak,  curWin); }
    else                     { curLoss++; curWin = 0; lossStreak = Math.max(lossStreak, curLoss); }
  }

  // Day streaks
  const dayMap = {};
  for (const t of closedTrades) {
    if (!dayMap[t.date]) dayMap[t.date] = 0;
    dayMap[t.date] += t.netPnl;
  }
  const dayDates = Object.keys(dayMap).sort();
  let greenStreak = 0, redStreak = 0, curGreen = 0, curRed = 0;
  for (const d of dayDates) {
    if (dayMap[d] >= 0) { curGreen++; curRed = 0;   greenStreak = Math.max(greenStreak, curGreen); }
    else                { curRed++;   curGreen = 0;  redStreak   = Math.max(redStreak,   curRed); }
  }

  // Best / worst trade
  const bestTrade  = closedTrades.reduce((b, t) => (!b || t.netPnl > b.netPnl) ? t : b, null);
  const worstTrade = closedTrades.reduce((b, t) => (!b || t.netPnl < b.netPnl) ? t : b, null);

  // Best / worst day
  const bestDay  = dayDates.reduce((b, d) => (!b || dayMap[d] > dayMap[b]) ? d : b, null);
  const worstDay = dayDates.reduce((b, d) => (!b || dayMap[d] < dayMap[b]) ? d : b, null);
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const bestDayName  = bestDay  ? dayNames[new Date(bestDay  + 'T12:00:00Z').getUTCDay()] : null;
  const worstDayName = worstDay ? dayNames[new Date(worstDay + 'T12:00:00Z').getUTCDay()] : null;

  // Best/worst day totals by day-of-week
  const dowPnl = {};
  for (const d of dayDates) {
    const dow = dayNames[new Date(d + 'T12:00:00Z').getUTCDay()];
    if (!dowPnl[dow]) dowPnl[dow] = { pnl: 0, count: 0 };
    dowPnl[dow].pnl   += dayMap[d];
    dowPnl[dow].count += Object.values(closedTrades.filter(t => t.date === d)).length;
  }
  const dowEntries   = Object.entries(dowPnl);
  const bestDayOfWeek  = dowEntries.reduce((b, e) => (!b || e[1].pnl > b[1].pnl) ? e : b, null);
  const worstDayOfWeek = dowEntries.reduce((b, e) => (!b || e[1].pnl < b[1].pnl) ? e : b, null);

  return {
    summary: {
      startingBalance,
      finalBalance:    parseFloat(balance.toFixed(2)),
      totalPnl:        parseFloat(totalPnl.toFixed(2)),
      totalPnlPct:     parseFloat((totalPnl / startingBalance * 100).toFixed(1)),
      totalFees:       parseFloat(totalFees.toFixed(2)),
      totalTrades:     closedTrades.length,
      skippedTrades:   skippedSignals.length,
      skipReasons: skippedSignals.reduce((acc, s) => {
        acc[s.skipReason] = (acc[s.skipReason] || 0) + 1; return acc;
      }, {}),
      winningTrades:   wins.length,
      losingTrades:    losses.length,
      winRate:         closedTrades.length ? parseFloat((wins.length / closedTrades.length * 100).toFixed(1)) : 0,
      profitFactor:    parseFloat(Math.min(profitFactor, 999).toFixed(2)),
      avgWinPct:       parseFloat(avgWinPct.toFixed(1)),
      avgLossPct:      parseFloat(avgLossPct.toFixed(1)),
      totalWon:        parseFloat(totalWon.toFixed(2)),
      totalLost:       parseFloat(totalLost.toFixed(2)),
      avgDurationMin:  Math.round(avgDuration),
      maxDrawdown:     parseFloat((-maxDrawdown).toFixed(2)),
      maxDrawdownPct:  parseFloat((-maxDrawdownPct * 100).toFixed(1)),
      winStreak,
      lossStreak,
      greenDayStreak:  greenStreak,
      redDayStreak:    redStreak,
      bestTrade:       bestTrade  ? { pnl: bestTrade.netPnl,  pnlPct: bestTrade.pnlPct,  ticker: bestTrade.ticker,  optionSymbol: bestTrade.optionSymbol }  : null,
      worstTrade:      worstTrade ? { pnl: worstTrade.netPnl, pnlPct: worstTrade.pnlPct, ticker: worstTrade.ticker, optionSymbol: worstTrade.optionSymbol } : null,
      bestDayOfWeek:   bestDayOfWeek  ? { day: bestDayOfWeek[0],  pnl: parseFloat(bestDayOfWeek[1].pnl.toFixed(2)),  trades: bestDayOfWeek[1].count }  : null,
      worstDayOfWeek:  worstDayOfWeek ? { day: worstDayOfWeek[0], pnl: parseFloat(worstDayOfWeek[1].pnl.toFixed(2)), trades: worstDayOfWeek[1].count } : null,
    },
    trades: closedTrades.sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime)),
  };
}

module.exports = { runBacktest };
