const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { getUserById } = require('../data/db');

router.use(requireAuth);

// GET /billing — get current subscription status
router.get('/', async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    res.json({
      subscriptionStatus: user.subscription_status || 'inactive',
      plan:               user.plan || 'elite',
      licenseKey:         user.license_key,
      isActive:           user.is_active,
      trialEndsAt:        user.trial_ends_at,
      stripeConnected:    !!user.stripe_customer_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/portal — redirect to Stripe customer portal
// (drop in STRIPE_SECRET_KEY and this works automatically)
router.post('/portal', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(200).json({
        url: null,
        message: 'Stripe not yet configured — contact hello@tradepilotlabs.com to manage your subscription',
      });
    }
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const user   = await getUserById(req.user.id);
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer found' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: `${process.env.DASHBOARD_URL}/billing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/checkout — create Stripe checkout session
// (drop in STRIPE_SECRET_KEY and STRIPE_PRICE_ELITE and this works)
router.post('/checkout', async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ELITE) {
      return res.status(200).json({
        url: null,
        message: 'Payments not yet configured',
      });
    }
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const user   = await getUserById(req.user.id);
    const session = await stripe.checkout.sessions.create({
      mode:               'subscription',
      payment_method_types: ['card'],
      customer_email:     user.email,
      line_items: [{ price: process.env.STRIPE_PRICE_ELITE, quantity: 1 }],
      subscription_data:  { trial_period_days: 7 },
      success_url: `${process.env.DASHBOARD_URL}/billing?success=true`,
      cancel_url:  `${process.env.DASHBOARD_URL}/billing?canceled=true`,
      metadata:    { userId: user.id },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
