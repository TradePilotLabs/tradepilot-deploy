const { getOptionChain } = require('./tastyClient');

/**
 * Finds the best 0DTE option contract for a given ticker + direction.
 *
 * ATM detection uses put-call parity instead of a live equity quote:
 * for 0DTE options, the strike where call_mid ≈ put_mid is approximately
 * the current spot price. This avoids a separate /market-data/quotes call
 * which is not available in TastyTrade's REST API (streaming-only).
 */
async function selectContract(userId, { ticker, direction, maxContractCost, minContractCost }) {
  const today = getTodayExpiration();

  const chain = await getOptionChain(userId, ticker);
  if (!chain) throw new Error(`No option chain found for ${ticker}`);

  const expirations = chain.expirations || [];
  const expiration  = expirations.find(e => e['expiration-date'] === today);
  if (!expiration) {
    throw new Error(`No 0DTE expiration found for ${ticker} on ${today}`);
  }

  const strikes    = expiration.strikes || [];
  const optionType = direction === 'calls' ? 'call' : 'put';

  // ── Derive ATM via put-call parity ────────────────────────────
  // At ATM the call and put mid prices are approximately equal (0DTE).
  // Find the strike with the smallest |call_mid - put_mid| — that's spot.
  let atmStrike = null;
  let minParity = Infinity;
  for (const strike of strikes) {
    const c = strike['call']; const p = strike['put'];
    if (!c || !p) continue;
    const cMid = (parseFloat(c['ask-price'] || 0) + parseFloat(c['bid-price'] || 0)) / 2;
    const pMid = (parseFloat(p['ask-price'] || 0) + parseFloat(p['bid-price'] || 0)) / 2;
    if (cMid <= 0 || pMid <= 0) continue;
    const diff = Math.abs(cMid - pMid);
    if (diff < minParity) { minParity = diff; atmStrike = parseFloat(strike['strike-price']); }
  }
  if (!atmStrike) throw new Error(`Could not determine ATM strike for ${ticker}`);

  // ── Build candidate list ──────────────────────────────────────
  const candidates = [];
  for (const strike of strikes) {
    const option = strike[optionType];
    if (!option) continue;
    const ask = parseFloat(option['ask-price'] || 0);
    const bid = parseFloat(option['bid-price'] || 0);
    const mid = (ask + bid) / 2;
    if (minContractCost && mid < minContractCost) continue;
    if (maxContractCost && mid > maxContractCost) continue;
    const strikePrice = parseFloat(strike['strike-price']);
    candidates.push({
      symbol:      option['symbol'],
      strikePrice,
      distFromAtm: Math.abs(strikePrice - atmStrike),
      bid, ask,
      mid:         parseFloat(mid.toFixed(2)),
      expiration:  today,
      optionType,
    });
  }

  if (!candidates.length) {
    throw new Error(
      `No ${direction} contracts found for ${ticker} between $${minContractCost} and $${maxContractCost} ` +
      `(ATM inferred at ${atmStrike})`
    );
  }

  candidates.sort((a, b) => a.distFromAtm - b.distFromAtm);
  return candidates[0];
}

/**
 * Calculate how many contracts to buy based on user's capital settings.
 * Uses the lower of: (maxCapital / contractPrice*100) or 1 contract minimum.
 */
function calcQuantity(contractMidPrice, maxCapitalPerTrade) {
  if (!contractMidPrice || contractMidPrice <= 0) return 1;
  const costPerContract = contractMidPrice * 100; // options are per 100 shares
  const qty = Math.floor(maxCapitalPerTrade / costPerContract);
  return Math.max(1, qty);
}

/**
 * Returns today's date in YYYY-MM-DD format (ET timezone aware).
 * Markets run on Eastern Time so we use ET for expiration matching.
 */
function getTodayExpiration() {
  const now = new Date();
  // Convert to ET
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y  = et.getFullYear();
  const m  = String(et.getMonth() + 1).padStart(2, '0');
  const d  = String(et.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { selectContract, calcQuantity, getTodayExpiration };
