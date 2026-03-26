const { CronJob }                    = require('cron');
const { getAllOpenPositions }         = require('../data/redis');
const { closeAllPositions } = require('../services/orderPlacer');
const { getTastyTokens }             = require('../data/db');

function scheduleMarketClose() {
  // 3:45 PM ET = 20:45 UTC (handles EST, adjust for EDT = 19:45 UTC)
  // Running at both times covers daylight saving automatically
  // Cron: minute hour * * day-of-week (1-5 = Mon-Fri)
  const job = new CronJob(
    '45 20 * * 1-5',          // 3:45 PM EST (winter)
    runMarketClose,
    null,
    true,
    'America/New_York'        // cron runs in ET — no UTC math needed
  );

  // Also run at 3:44 PM ET as a safety net
  const earlyJob = new CronJob(
    '44 15 * * 1-5',
    runMarketClose,
    null,
    true,
    'America/New_York'
  );

  console.log('✓ Market close job scheduled (3:44 PM ET daily, Mon-Fri)');
  return { job, earlyJob };
}

async function runMarketClose() {
  console.log('[MARKET CLOSE] Running 3:44 PM ET close — closing all 0DTE positions');

  const positions = await getAllOpenPositions();
  if (!positions.length) {
    console.log('[MARKET CLOSE] No open positions to close');
    return;
  }

  console.log(`[MARKET CLOSE] Found ${positions.length} open position(s) to close`);

  // Group by user
  const byUser = {};
  for (const pos of positions) {
    if (!byUser[pos.userId]) byUser[pos.userId] = [];
    byUser[pos.userId].push(pos);
  }

  for (const [userId, userPositions] of Object.entries(byUser)) {
    try {
      const tokens = await getTastyTokens(userId);
      if (!tokens?.account_number) {
        console.warn(`[MARKET CLOSE] No account number for user ${userId}`);
        continue;
      }
      const results = await closeAllPositions({
        userId,
        accountNumber: tokens.account_number,
        positions:     userPositions,
        exitReason:    'market_close',
      });
      console.log(`[MARKET CLOSE] User ${userId}: closed ${results.length} position(s)`);
    } catch (err) {
      console.error(`[MARKET CLOSE] Failed for user ${userId}:`, err.message);
    }
  }
}

module.exports = { scheduleMarketClose, runMarketClose };
