const { getUserById } = require('../data/db');

/**
 * Checks that the authenticated user has an active subscription.
 * Attach after requireAuth middleware.
 * Allows admin users through regardless of subscription status.
 */
async function requireActiveSubscription(req, res, next) {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Admins always pass through
    if (user.is_admin) return next();

    // Check account is active
    if (!user.is_active) {
      return res.status(403).json({
        error: 'Account deactivated',
        code:  'ACCOUNT_DEACTIVATED',
        message: 'Your account has been deactivated. Please reactivate your subscription.',
      });
    }

    // Check subscription status
    const active = ['active', 'trialing'].includes(user.subscription_status);
    if (!active) {
      return res.status(403).json({
        error: 'Subscription required',
        code:  'SUBSCRIPTION_INACTIVE',
        status: user.subscription_status,
        message: 'Your subscription is not active. Please visit the billing page.',
      });
    }

    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Soft subscription check — attaches subscription info to req
 * but doesn't block. Use for routes where non-subscribers
 * should see limited data.
 */
async function attachSubscription(req, res, next) {
  try {
    if (!req.user) return next();
    const user = await getUserById(req.user.id);
    req.subscription = {
      status:   user?.subscription_status || 'inactive',
      plan:     user?.plan || 'elite',
      isActive: ['active', 'trialing'].includes(user?.subscription_status),
      isAdmin:  user?.is_admin || false,
    };
    next();
  } catch (err) {
    next();
  }
}

module.exports = { requireActiveSubscription, attachSubscription };
