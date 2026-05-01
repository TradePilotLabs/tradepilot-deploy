const jwt = require('jsonwebtoken');
const { getUserById } = require('../data/db');

// Verifies the JWT on protected dashboard API routes.
// Also accepts ?token= query param for SSE endpoints (EventSource
// doesn't support custom headers, so the token is passed in the URL).
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const queryToken = req.query.token;

  let rawToken;
  if (header?.startsWith('Bearer ')) {
    rawToken = header.slice(7);
  } else if (queryToken) {
    rawToken = queryToken;
  } else {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = rawToken;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Issues a signed JWT for a user
function issueToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

module.exports = { requireAuth, issueToken };
