const { getUserByWebhookToken, getOrCreateSettings, getTastyTokens } = require('../data/db');

// Attached to POST /webhook/:token
// Validates the token, loads the user + settings, attaches to req
async function validateWebhookToken(req, res, next) {
  const { token } = req.params;
  if (!token) return res.status(400).json({ error: 'Missing webhook token' });

  const user = await getUserByWebhookToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid webhook token' });

  const settings = await getOrCreateSettings(user.id);
  if (!settings.trading_enabled) {
    return res.status(200).json({ skipped: 'trading_disabled' });
  }

  const tasty = await getTastyTokens(user.id);
  if (!tasty) {
    return res.status(200).json({ skipped: 'tastytrade_not_connected' });
  }

  req.userId = user.id;
  req.user = user;
  req.settings = settings;
  req.tastyTokens = tasty;
  next();
}

module.exports = { validateWebhookToken };
