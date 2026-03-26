const { getOptionChain, getEquityQuote } = require('./tastyClient');

/**
 * Finds the best 0DTE option contract for a given ticker + direction.
 *
 * Strategy:
 * - Find today's expiration in the chain
 * - Get current equity price to find ATM strike
 * - Filter by min/max contract cost from user settings
 * - Return the ATM-nearest contract that fits the price filter
 */
async function selectContract(userId, { ticker, direction, maxContractCost, minContractCost }) {
  const today = getTodayExpiration();

  // Get the option chain
  const chain = await getOptionChain(userId, ticker);
  if (!chain) throw new Error(`No option chain found for ${ticker}`);

  // Find today's expiration
  const expirations = chain.expirations || [];
  const expiration  = expirations.find(e => e['expiration-date'] === today);
  if (!expiration) {
    throw new Error(`No 0DTE expiration found for ${ticker} on ${today}`);
  }

  // Get current equity price for ATM calculation
  const quote        = await getEquityQuote(userId, ticker);
  const currentPrice = parseFloat(quote?.['last-price'] || quote?.['mark'] || 0);
  if (!currentPrice) throw new Error(`Could not get current price for ${ticker}`);

  // Get strikes for the right option type
  const optionType = direction === 'calls' ? 'call' : 'put';
  const strikes    = expiration.strikes || [];

  // Build candidate list
  const candidates = [];
  for (const strike of strikes) {
    const option = strike[optionType];
    if (!option) continue;

    const ask = parseFloat(option['ask-price'] || 0);
    const bid = parseFloat(option['bid-price'] || 0);
    const mid = (ask + bid) / 2;

    // Skip if outside price filter
    if (minContractCost && mid < minContractCost) continue;
    if (maxContractCost && mid > maxContractCost) continue;

    const strikePrice = parseFloat(strike['strike-price']);
    const distFromAtm = Math.abs(strikePrice - currentPrice);

    candidates.push({
      symbol:      option['symbol'],
      strikePrice,
      distFromAtm,
      bid,
      ask,
      mid:         parseFloat(mid.toFixed(2)),
      expiration:  today,
      optionType,
    });
  }

  if (!candidates.length) {
    throw new Error(
      `No ${direction} contracts found for ${ticker} between $${minContractCost} and $${maxContractCost}`
    );
  }

  // Sort by closest to ATM, return the best fit
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
