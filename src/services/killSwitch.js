/**
 * Kill switch checks.
 * Returns { tripped: true, reason: '...' } if trading should stop,
 * or { tripped: false } if trading is allowed to continue.
 */

function checkKillSwitch(settings, realizedPnl, unrealizedPnl = 0) {
  const totalPnl = realizedPnl + unrealizedPnl;

  // ─── Realized profit target ──────────────────────────────
  if (settings.kill_profit_enabled) {
    const limit = resolveLimit(settings.kill_profit_type, settings.kill_profit_value, realizedPnl);
    if (realizedPnl >= limit) {
      return {
        tripped: true,
        reason:  `Daily profit target reached ($${realizedPnl.toFixed(2)} >= $${limit.toFixed(2)})`,
        type:    'profit_target',
      };
    }
  }

  // ─── Realized loss limit ─────────────────────────────────
  if (settings.kill_loss_enabled) {
    const limit = resolveLimit(settings.kill_loss_type, settings.kill_loss_value, realizedPnl);
    if (realizedPnl <= -Math.abs(limit)) {
      return {
        tripped: true,
        reason:  `Daily loss limit reached ($${realizedPnl.toFixed(2)} <= -$${Math.abs(limit).toFixed(2)})`,
        type:    'loss_limit',
      };
    }
  }

  // ─── Unrealized profit target (flatten all) ───────────────
  if (settings.unreal_profit_enabled && unrealizedPnl > 0) {
    const limit = resolveLimit(settings.unreal_profit_type, settings.unreal_profit_value, totalPnl);
    if (totalPnl >= limit) {
      return {
        tripped:  true,
        reason:   `Unrealized profit target reached ($${totalPnl.toFixed(2)} >= $${limit.toFixed(2)})`,
        type:     'unreal_profit',
        flatten:  true,   // signal to close all open positions
      };
    }
  }

  // ─── Unrealized loss limit (flatten all) ─────────────────
  if (settings.unreal_loss_enabled && unrealizedPnl < 0) {
    const limit = resolveLimit(settings.unreal_loss_type, settings.unreal_loss_value, totalPnl);
    if (totalPnl <= -Math.abs(limit)) {
      return {
        tripped:  true,
        reason:   `Unrealized loss limit reached ($${totalPnl.toFixed(2)} <= -$${Math.abs(limit).toFixed(2)})`,
        type:     'unreal_loss',
        flatten:  true,
      };
    }
  }

  return { tripped: false };
}

/**
 * Resolve a limit value — supports both $ (absolute) and % (of some base).
 * For simplicity, % is treated as % of $10,000 account baseline.
 * You can make this dynamic later by passing account balance.
 */
function resolveLimit(type, value, _currentPnl) {
  if (type === '%') {
    return (value / 100) * 10000; // e.g. 1% of $10k = $100
  }
  return parseFloat(value);
}

/**
 * Check if current time is within the user's configured trading schedule.
 * schedule format: { Monday: { enabled, sessions: [{from, to}] }, ... }
 */
function isInTradingWindow(schedule) {
  if (!schedule) return true; // no schedule = always allowed

  const now  = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const days  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day   = days[etNow.getDay()];

  const dayConfig = schedule[day];
  if (!dayConfig || !dayConfig.enabled) return false;

  const sessions = dayConfig.sessions || [];
  for (const session of sessions) {
    if (isTimeInSession(etNow, session.from, session.to)) return true;
  }
  return false;
}

function isTimeInSession(etNow, fromStr, toStr) {
  const [fromTime, fromPeriod] = parseTime(fromStr);
  const [toTime,   toPeriod]   = parseTime(toStr);

  const fromMins = toMinutes(fromTime, fromPeriod);
  const toMins   = toMinutes(toTime, toPeriod);
  const nowMins  = etNow.getHours() * 60 + etNow.getMinutes();

  return nowMins >= fromMins && nowMins <= toMins;
}

function parseTime(str) {
  // e.g. "08:40 AM" → [["08", "40"], "AM"]
  const [time, period] = str.trim().split(' ');
  return [time.split(':'), period];
}

function toMinutes([hours, mins], period) {
  let h = parseInt(hours, 10);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return h * 60 + parseInt(mins, 10);
}

module.exports = { checkKillSwitch, isInTradingWindow };
