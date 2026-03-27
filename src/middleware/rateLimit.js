/**
 * Simple rate limiter using Postgres
 * No external dependency needed
 * Limits by IP or by key (email etc)
 */

const { getPool } = require('../data/db');

/**
 * Rate limit middleware factory
 * @param {object} options
 * @param {number} options.maxHits - max requests in window
 * @param {number} options.windowMs - window in milliseconds
 * @param {function} options.keyFn - function(req) => string key
 * @param {string} options.message - error message
 */
function rateLimit({ maxHits = 5, windowMs = 15 * 60 * 1000, keyFn, message }) {
  return async (req, res, next) => {
    try {
      const ip  = req.ip || req.connection.remoteAddress || 'unknown';
      const key = keyFn ? keyFn(req) : `ip:${ip}`;
      const windowStart = new Date(Date.now() - windowMs);

      // Upsert rate limit record
      const { rows } = await getPool().query(
        `INSERT INTO rate_limits (key, hits, window_start)
         VALUES ($1, 1, NOW())
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE
             WHEN rate_limits.window_start < $2 THEN 1
             ELSE rate_limits.hits + 1
           END,
           window_start = CASE
             WHEN rate_limits.window_start < $2 THEN NOW()
             ELSE rate_limits.window_start
           END
         RETURNING hits, window_start`,
        [key, windowStart]
      );

      const { hits } = rows[0];

      // Set headers
      res.set('X-RateLimit-Limit', maxHits);
      res.set('X-RateLimit-Remaining', Math.max(0, maxHits - hits));

      if (hits > maxHits) {
        return res.status(429).json({
          error: message || 'Too many requests — please try again later',
          retryAfter: Math.ceil(windowMs / 1000),
        });
      }

      next();
    } catch (err) {
      // Don't block requests if rate limiter fails
      console.error('Rate limiter error:', err.message);
      next();
    }
  };
}

// Pre-configured limiters
const loginLimiter = rateLimit({
  maxHits:  10,
  windowMs: 15 * 60 * 1000, // 15 minutes
  keyFn:    (req) => `login:${req.ip}`,
  message:  'Too many login attempts — please wait 15 minutes',
});

const signupLimiter = rateLimit({
  maxHits:  5,
  windowMs: 60 * 60 * 1000, // 1 hour
  keyFn:    (req) => `signup:${req.ip}`,
  message:  'Too many signup attempts — please wait an hour',
});

const passwordResetLimiter = rateLimit({
  maxHits:  3,
  windowMs: 60 * 60 * 1000, // 1 hour
  keyFn:    (req) => `reset:${req.body?.email || req.ip}`,
  message:  'Too many password reset attempts — please wait an hour',
});

const webhookLimiter = rateLimit({
  maxHits:  60,
  windowMs: 60 * 1000, // 1 minute
  keyFn:    (req) => `webhook:${req.params.token}`,
  message:  'Webhook rate limit exceeded',
});

module.exports = { rateLimit, loginLimiter, signupLimiter, passwordResetLimiter, webhookLimiter };
