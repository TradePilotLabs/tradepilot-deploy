const Redis = require('ioredis');

let client;

function connectRedis() {
  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    tls: process.env.REDIS_URL?.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  });
  client.on('connect', () => console.log('✓ Redis connected'));
  client.on('error', (err) => console.error('Redis error:', err.message));
  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis not initialised — call connectRedis() first');
  return client;
}

// ─── Position state ───────────────────────────────────────────
// Key pattern: position:{userId}:{tradeId}
// Index key:   positions:{userId}  (SET of tradeIds)

async function addPosition(userId, tradeId, positionData) {
  const key = `position:${userId}:${tradeId}`;
  const indexKey = `positions:${userId}`;
  await getRedis().set(key, JSON.stringify({ ...positionData, userId, tradeId }));
  await getRedis().sadd(indexKey, tradeId);
  // Auto-expire at midnight ET (safety net — market close job handles this first)
  await getRedis().expireat(key, endOfDayUnix());
}

async function getPosition(userId, tradeId) {
  const key = `position:${userId}:${tradeId}`;
  const raw = await getRedis().get(key);
  return raw ? JSON.parse(raw) : null;
}

async function updatePosition(userId, tradeId, updates) {
  const pos = await getPosition(userId, tradeId);
  if (!pos) return;
  const key = `position:${userId}:${tradeId}`;
  await getRedis().set(key, JSON.stringify({ ...pos, ...updates }));
}

async function removePosition(userId, tradeId) {
  const key = `position:${userId}:${tradeId}`;
  const indexKey = `positions:${userId}`;
  await getRedis().del(key);
  await getRedis().srem(indexKey, tradeId);
}

async function getOpenPositionsForUser(userId) {
  const indexKey = `positions:${userId}`;
  const tradeIds = await getRedis().smembers(indexKey);
  if (!tradeIds.length) return [];
  const positions = await Promise.all(
    tradeIds.map((id) => getPosition(userId, id))
  );
  return positions.filter(Boolean);
}

// Returns ALL open positions across ALL users (for monitor loop)
async function getAllOpenPositions() {
  const keys = await getRedis().keys('position:*:*');
  if (!keys.length) return [];
  const raws = await getRedis().mget(...keys);
  return raws.filter(Boolean).map((r) => JSON.parse(r));
}

// ─── Daily P&L cache (fast kill-switch check) ────────────────
// Mirrors DB but cached in Redis for sub-millisecond reads

async function incrDailyPnl(userId, amount) {
  const key = `dailypnl:${userId}:${today()}`;
  await getRedis().incrbyfloat(key, amount);
  await getRedis().expireat(key, endOfDayUnix() + 3600);
}

async function getDailyPnlCache(userId) {
  const key = `dailypnl:${userId}:${today()}`;
  const val = await getRedis().get(key);
  return val ? parseFloat(val) : 0;
}

// ─── Helpers ──────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function endOfDayUnix() {
  const d = new Date();
  d.setHours(23, 59, 59, 0);
  return Math.floor(d.getTime() / 1000);
}

module.exports = {
  connectRedis, getRedis,
  addPosition, getPosition, updatePosition, removePosition,
  getOpenPositionsForUser, getAllOpenPositions,
  incrDailyPnl, getDailyPnlCache,
};
