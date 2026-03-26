const jwt = require('jsonwebtoken');
const { getUserById } = require('../data/db');

// Requires valid JWT AND is_admin = true
async function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await getUserById(payload.sub);
    if (!user)          return res.status(401).json({ error: 'User not found' });
    if (!user.is_admin) return res.status(403).json({ error: 'Admin access required' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAdmin };
