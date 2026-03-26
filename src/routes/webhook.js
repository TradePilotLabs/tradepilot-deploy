const router = require('express').Router();
const { validateWebhookToken }        = require('../middleware/webhookToken');
const { parseSignal }                 = require('../services/signalParser');
const { selectContract, calcQuantity } = require('../services/contractSelector');
const { openPosition, closeAllPositions } = require('../services/orderPlacer');
const { checkKillSwitch, isInTradingWindow } = require('../services/killSwitch');
const { addPosition }                 = require('../data/redis');
const { getTodayTradeCount, getTodayRealizedPnl, getTastyTokens, getOpenTrades } = require('../data/db');

/**
 * POST /webhook/:token
 *
 * TradingView alert message format (set this in TradingView alert):
 * {
 *   "ticker":  "{{ticker}}",
 *   "action":  "BUY_CALLS",
 *   "signal":  "A1",
 *   "price":   {{close}},
 *   "stopPct": 40,
 *   "tpPct":   80
 * }
 */
router.post('/:token', validateWebhookToken, async (req, res) => {
  const { userId, settings, tastyTokens } = req;
  const accountNumber = tastyTokens.account_number;

  if (!accountNumber) {
    return res.status(200).json({ skipped: 'no_account_number' });
  }

  // ── Parse and validate signal ───────────────────────────────
  const signal = parseSignal(req.body);
  if (!signal) {
    console.warn(`[WEBHOOK] Invalid signal from user ${userId}:`, req.body);
    return res.status(400).json({ error: 'Invalid signal payload' });
  }

  console.log(`[WEBHOOK] Signal received: ${signal.action} ${signal.ticker} | User: ${userId}`);

  // ── CLOSE_ALL action ────────────────────────────────────────
  if (signal.action === 'CLOSE_ALL') {
    const { getOpenPositionsForUser } = require('../data/redis');
    const positions = await getOpenPositionsForUser(userId);
    if (positions.length) {
      await closeAllPositions({ userId, accountNumber, positions, exitReason: 'signal_close' });
      return res.json({ success: true, action: 'closed_all', count: positions.length });
    }
    return res.json({ success: true, action: 'close_all', count: 0 });
  }

  // ── Ticker filter check ─────────────────────────────────────
  const tickerFilter = settings.ticker_filter;
  if (tickerFilter !== 'all') {
    const allowed = tickerFilter === 'spyqqq'
      ? ['SPY', 'QQQ']
      : [tickerFilter.toUpperCase()];
    if (!allowed.includes(signal.ticker)) {
      return res.json({ skipped: 'ticker_filtered', ticker: signal.ticker });
    }
  }

  // ── Trading window check ────────────────────────────────────
  if (!isInTradingWindow(settings.schedule)) {
    console.log(`[WEBHOOK] Outside trading hours for user ${userId}`);
    return res.json({ skipped: 'outside_trading_hours' });
  }

  // ── Max trades per day check ────────────────────────────────
  const todayCount = await getTodayTradeCount(userId);
  if (todayCount >= settings.max_trades_per_day) {
    console.log(`[WEBHOOK] Max trades reached (${todayCount}) for user ${userId}`);
    return res.json({ skipped: 'max_trades_reached', count: todayCount });
  }

  // ── Kill switch check ───────────────────────────────────────
  const realizedPnl = await getTodayRealizedPnl(userId);
  const killCheck   = checkKillSwitch(settings, realizedPnl);
  if (killCheck.tripped) {
    console.log(`[WEBHOOK] Kill switch active for user ${userId}: ${killCheck.reason}`);
    return res.json({ skipped: 'kill_switch', reason: killCheck.reason });
  }

  // ── Find 0DTE contract ──────────────────────────────────────
  let contract;
  try {
    contract = await selectContract(userId, {
      ticker:          signal.ticker,
      direction:       signal.direction,
      maxContractCost: settings.max_contract_cost,
      minContractCost: settings.min_contract_cost,
    });
  } catch (err) {
    console.error(`[WEBHOOK] Contract selection failed:`, err.message);
    return res.status(200).json({ skipped: 'no_contract', reason: err.message });
  }

  // ── Calculate quantity ──────────────────────────────────────
  const quantity = calcQuantity(contract.mid, settings.max_capital_per_trade);

  // ── Place opening order ─────────────────────────────────────
  let trade;
  try {
    trade = await openPosition({ userId, accountNumber, contract, quantity, signal, settings });
  } catch (err) {
    console.error(`[WEBHOOK] Order placement failed:`, err.message);
    return res.status(200).json({ skipped: 'order_failed', reason: err.message });
  }

  // ── Track in Redis for exit monitoring ──────────────────────
  await addPosition(userId, trade.id, {
    tradeId:       trade.id,
    optionSymbol:  contract.symbol,
    symbol:        signal.ticker,
    direction:     signal.direction,
    quantity,
    entryPrice:    contract.mid,
    peakPrice:     contract.mid,
    accountNumber,
    // Exit params — signal overrides settings if provided
    stopPct:       signal.stopPct || settings.stop_loss_pct,
    tpPct:         signal.tpPct   || null,
  });

  console.log(`[WEBHOOK] Trade opened successfully: ${trade.id}`);

  res.json({
    success:      true,
    tradeId:      trade.id,
    symbol:       contract.symbol,
    strike:       contract.strikePrice,
    direction:    signal.direction,
    quantity,
    entryPrice:   contract.mid,
    stopPct:      signal.stopPct || settings.stop_loss_pct,
  });
});

module.exports = router;
