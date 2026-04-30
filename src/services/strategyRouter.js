const { getUsersOnStrategy, getTastyTokens,
        getTodayTradeCount, getTodayRealizedPnl, logSignal, getOpenTrades } = require('../data/db');
const { parseSignal }                    = require('./signalParser');
const { selectContract, calcQuantity }   = require('./contractSelector');
const { openPosition }                   = require('./orderPlacer');
const { checkKillSwitch, isInTradingWindow } = require('./killSwitch');
const { addPosition }                    = require('../data/redis');

/**
 * Called when a managed strategy webhook fires.
 * Fans the signal out to every user subscribed to that strategy.
 * Each user's own settings (capital, risk, schedule) are applied individually.
 */
async function processStrategySignal(strategy, rawPayload) {
  const signal = parseSignal(rawPayload);
  if (!signal) {
    console.warn(`[STRATEGY] Invalid signal for ${strategy.slug}:`, rawPayload);
    return { error: 'invalid_signal' };
  }

  console.log(`[STRATEGY] ${strategy.name} fired: ${signal.action} ${signal.ticker}`);

  // Get all users subscribed to this strategy with trading enabled
  const users = await getUsersOnStrategy(strategy.slug);
  console.log(`[STRATEGY] Broadcasting to ${users.length} subscriber(s)`);

  const results = [];

  for (const user of users) {
    const result = await processForUser(user, strategy, signal, rawPayload);
    results.push({ userId: user.id, ...result });
  }

  return results;
}

async function processForUser(user, strategy, signal, rawPayload) {
  const userId   = user.id;
  const settings = user; // getUsersOnStrategy already joins settings columns

  try {
    // Load TastyTrade tokens
    const tokens = await getTastyTokens(userId);
    if (!tokens?.account_number) {
      await logSignal({ userId, strategySlug: strategy.slug, ...signalMeta(signal, rawPayload),
        outcome: 'skipped', outcomeDetail: 'no_tastytrade_account' });
      return { skipped: 'no_tastytrade_account' };
    }
    const accountNumber = tokens.account_number;

    // Ticker filter
    const tickerFilter = settings.ticker_filter || 'all';
    if (tickerFilter !== 'all') {
      const allowed = tickerFilter === 'spyqqq' ? ['SPY','QQQ'] : [tickerFilter.toUpperCase()];
      if (!allowed.includes(signal.ticker)) {
        return { skipped: 'ticker_filtered' };
      }
    }

    // Trading window
    if (!isInTradingWindow(settings.schedule)) {
      await logSignal({ userId, strategySlug: strategy.slug, ...signalMeta(signal, rawPayload),
        outcome: 'skipped', outcomeDetail: 'outside_trading_hours' });
      return { skipped: 'outside_trading_hours' };
    }

    // Max trades per day
    const todayCount = await getTodayTradeCount(userId);
    if (todayCount >= (settings.max_trades_per_day || 4)) {
      await logSignal({ userId, strategySlug: strategy.slug, ...signalMeta(signal, rawPayload),
        outcome: 'skipped', outcomeDetail: 'max_trades_reached' });
      return { skipped: 'max_trades_reached' };
    }

    // Max active (concurrent) trades
    if (settings.max_active_trades) {
      const openTrades = await getOpenTrades(userId);
      if (openTrades.length >= settings.max_active_trades) {
        await logSignal({ userId, strategySlug: strategy.slug, ...signalMeta(signal, rawPayload),
          outcome: 'skipped', outcomeDetail: 'max_active_trades' });
        return { skipped: 'max_active_trades' };
      }
    }

    // Kill switch
    const realizedPnl = await getTodayRealizedPnl(userId);
    const killCheck   = checkKillSwitch(settings, realizedPnl);
    if (killCheck.tripped) {
      await logSignal({ userId, strategySlug: strategy.slug, ...signalMeta(signal, rawPayload),
        outcome: 'skipped', outcomeDetail: `kill_switch:${killCheck.type}` });
      return { skipped: 'kill_switch', reason: killCheck.reason };
    }

    // Find 0DTE contract
    const contract = await selectContract(userId, {
      ticker:          signal.ticker,
      direction:       signal.direction,
      maxContractCost: settings.max_contract_cost || 2.50,
      minContractCost: settings.min_contract_cost || 0.25,
    });

    // Calculate quantity
    const quantity = calcQuantity(contract.mid, settings.max_capital_per_trade || 250);

    // Place order
    const trade = await openPosition({
      userId, accountNumber, contract, quantity, signal, settings,
    });

    // Track in Redis
    await addPosition(userId, trade.id, {
      tradeId:       trade.id,
      optionSymbol:  contract.symbol,
      symbol:        signal.ticker,
      direction:     signal.direction,
      quantity,
      entryPrice:    contract.mid,
      peakPrice:     contract.mid,
      accountNumber,
      openedAt:      new Date().toISOString(),
      stopPct:       signal.stopPct || settings.stop_loss_pct || 40,
      tpPct:         signal.tpPct   || strategy.default_tp_pct || null,
    });

    // Log success
    await logSignal({ userId, strategySlug: strategy.slug, ...signalMeta(signal, rawPayload),
      outcome: 'trade_opened', outcomeDetail: trade.id, tradeId: trade.id });

    return { success: true, tradeId: trade.id, symbol: contract.symbol };

  } catch (err) {
    console.error(`[STRATEGY] Failed for user ${userId}:`, err.message);
    await logSignal({ userId, strategySlug: strategy.slug, ...signalMeta(signal, rawPayload),
      outcome: 'error', outcomeDetail: err.message });
    return { error: err.message };
  }
}

function signalMeta(signal, rawPayload) {
  return {
    signalType:  signal.signalType,
    ticker:      signal.ticker,
    action:      signal.action,
    rawPayload,
  };
}

module.exports = { processStrategySignal };
