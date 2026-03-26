const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { getRedis }    = require('../data/redis');

const DAY_SCORES = {
  Monday: -0.1, Tuesday: 0, Wednesday: 0.1, Thursday: 0.05, Friday: -0.05,
};

// GET /api/market-condition
router.get('/', requireAuth, async (req, res) => {
  try {
    const redis = getRedis();
    const today = new Date().toISOString().split('T')[0];
    const key   = `morning_mode:${req.user.id}:${today}`;
    const mode  = (await redis.get(key)) || 'auto';
    const preMarket = await getPreMarketCondition();
    res.json({ mode, preMarket });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/market-condition
router.post('/', requireAuth, async (req, res) => {
  try {
    const { mode } = req.body;
    if (!['trending','range','auto','off'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    const redis = getRedis();
    const today = new Date().toISOString().split('T')[0];
    const key   = `morning_mode:${req.user.id}:${today}`;
    await redis.set(key, mode, 'EX', 86400);
    res.json({ mode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function getPreMarketCondition() {
  const etNow   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const days    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const dayName = days[etNow.getDay()];

  // Placeholder values — wire to a real data provider (Polygon.io, Alpha Vantage, etc.)
  // when ready. Replace these two lines:
  const vix    = 18.5;
  const gapPct = 0.12;

  let score = 0;
  if (vix > 25)            score += 2;
  else if (vix > 18)       score += 1;
  else                     score -= 1;

  const absGap = Math.abs(gapPct);
  if (absGap > 0.5)        score += 2;
  else if (absGap > 0.25)  score += 1;
  else                     score -= 1;

  score += (DAY_SCORES[dayName] || 0) * 10;

  const suggestion = score >= 2 ? 'Trending' : 'Range';

  return { vix, gapPct, dayOfWeek: dayName, suggestion, score: parseFloat(score.toFixed(2)) };
}

module.exports = router;
