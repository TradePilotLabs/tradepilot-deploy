const { getOptionChain } = require('./tastyClient');
const { getOptionAsk }   = require('./polygonClient');

/**
 * Selects the best 0DTE option contract to trade.
 *
 * Priority:
 *  1. If the signal already specifies an option (unmodifiedTicker from PineScript),
 *     convert it to OCC format and use it directly — TradingView already chose ATM.
 *  2. Otherwise fall back to walking the option chain using the underlying price
 *     (signal.price) to find the nearest ATM strike.
 *
 * Price (bid/ask/mid) is fetched from Polygon.io for quantity calculation.
 * If Polygon is unavailable we fall back to a single-contract default.
 *
 * TastyTrade REST does not expose a working market-data/quotes endpoint —
 * all pricing comes from Polygon.
 */
async function selectContract(userId, {
  ticker,
  direction,
  maxContractCost,
  minContractCost,
  signalOptionSymbol,  // e.g. "SPY260430C715.0" from unmodifiedTicker
  currentPrice,        // underlying price from signal.price
}) {
  const today      = getTodayExpiration();
  const optionType = direction === 'calls' ? 'call' : 'put';

  // ── Path 1: signal carries explicit option symbol ──────────────
  if (signalOptionSymbol) {
    const occ   = toOCCSymbol(signalOptionSymbol);
    const price = await fetchOptionPrice(signalOptionSymbol);

    if (occ) {
      const mid = price || null;

      // Price filter — if we have a price, enforce limits
      if (mid !== null) {
        if (minContractCost && mid < minContractCost) {
          throw new Error(
            `Option ${signalOptionSymbol} mid=$${mid} is below minContractCost $${minContractCost}`
          );
        }
        if (maxContractCost && mid > maxContractCost) {
          throw new Error(
            `Option ${signalOptionSymbol} mid=$${mid} exceeds maxContractCost $${maxContractCost}`
          );
        }
      }

      const safeAsk = mid ? mid * 1.02 : null;
      const safeBid = mid ? mid * 0.98 : null;

      console.log(`[CONTRACT] Using signal option ${occ} mid=$${mid ?? 'unknown'}`);
      return {
        symbol:      occ,
        strikePrice: parseStrikeFromTv(signalOptionSymbol),
        bid:         safeBid,
        ask:         safeAsk,
        mid,
        expiration:  today,
        optionType,
      };
    }
  }

  // ── Path 2: walk option chain + underlying price ────────────────
  if (!currentPrice) {
    throw new Error(
      'Cannot select contract: no option symbol or underlying price in signal'
    );
  }

  const chain = await getOptionChain(userId, ticker);
  if (!chain) throw new Error(`No option chain found for ${ticker}`);

  const expirations = chain.expirations || [];
  const expiration  = expirations.find(e => e['expiration-date'] === today);
  if (!expiration) {
    throw new Error(`No 0DTE expiration found for ${ticker} on ${today}`);
  }

  const strikes = expiration.strikes || [];
  if (!strikes.length) throw new Error(`Empty strike list for ${ticker}`);

  // Find the strike closest to current underlying price
  let best = null, bestDist = Infinity;
  for (const strike of strikes) {
    const sym = strike[optionType === 'call' ? 'call' : 'put'];
    if (!sym) continue;
    const sp   = parseFloat(strike['strike-price']);
    const dist = Math.abs(sp - currentPrice);
    if (dist < bestDist) { bestDist = dist; best = { sp, sym }; }
  }
  if (!best) throw new Error(`No ${direction} strikes found for ${ticker}`);

  // sym here is the OCC symbol string from the chain
  const tvSym = occToTv(best.sym);
  const mid   = tvSym ? await fetchOptionPrice(tvSym) : null;

  if (mid !== null) {
    if (minContractCost && mid < minContractCost)
      throw new Error(`ATM contract mid=$${mid} below minContractCost $${minContractCost}`);
    if (maxContractCost && mid > maxContractCost)
      throw new Error(`ATM contract mid=$${mid} exceeds maxContractCost $${maxContractCost}`);
  }

  console.log(`[CONTRACT] Chain selection ${best.sym} mid=$${mid ?? 'unknown'}`);
  return {
    symbol:      best.sym,
    strikePrice: best.sp,
    bid:         mid ? mid * 0.98 : null,
    ask:         mid ? mid * 1.02 : null,
    mid,
    expiration:  today,
    optionType,
  };
}

/**
 * Calculate how many contracts to buy.
 * If mid price is unknown, fall back to 1 contract (safe default for market orders).
 */
function calcQuantity(contractMidPrice, maxCapitalPerTrade) {
  if (!contractMidPrice || contractMidPrice <= 0) {
    console.warn('[CONTRACT] No price for quantity calc — defaulting to 1 contract');
    return 1;
  }
  return Math.max(1, Math.floor(maxCapitalPerTrade / (contractMidPrice * 100)));
}

// ── Helpers ────────────────────────────────────────────────────────

async function fetchOptionPrice(tvSymbol) {
  try {
    const price = await getOptionAsk(tvSymbol);
    return price && price > 0 ? price : null;
  } catch {
    return null;
  }
}

// "SPY260430C715.0" → "SPY   260430C00715000"
function toOCCSymbol(tvSymbol) {
  if (!tvSymbol) return null;
  const m = tvSymbol.match(/^([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const [, root, date, type, strikeStr] = m;
  const strike = Math.round(parseFloat(strikeStr) * 1000);
  return `${root.padEnd(6, ' ')}${date}${type.toUpperCase()}${String(strike).padStart(8, '0')}`;
}

// "SPY   260430C00715000" → "SPY260430C715.0"  (for Polygon lookup)
function occToTv(occSym) {
  if (!occSym) return null;
  const m = occSym.trim().match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/i);
  if (!m) return null;
  const [, root, date, type, strikeStr] = m;
  const strike = parseInt(strikeStr, 10) / 1000;
  return `${root}${date}${type.toUpperCase()}${strike}`;
}

function parseStrikeFromTv(tvSymbol) {
  const m = tvSymbol?.match(/^[A-Z]+\d{6}[CP](\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

function getTodayExpiration() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y  = et.getFullYear();
  const m  = String(et.getMonth() + 1).padStart(2, '0');
  const d  = String(et.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { selectContract, calcQuantity, getTodayExpiration };
