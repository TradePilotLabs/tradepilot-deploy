const router = require('express').Router();
const { updateUserSubscription, getUserByStripeCustomer,
        getUserByEmail, createUser, createWebhookToken } = require('../data/db');
const { sendWelcomeEmail, sendPaymentFailedEmail, sendAccountDeactivatedEmail } = require('../services/emailService');
const { generateLicenseKey } = require('../services/encryption');
const bcrypt = require('bcryptjs');

/**
 * POST /stripe/webhook
 *
 * Handles all Stripe subscription events.
 * Requires raw body (not JSON parsed) for signature verification.
 *
 * To activate: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET env vars.
 */
router.post('/', async (req, res) => {
  // If Stripe not configured, acknowledge and skip
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.log('[STRIPE] Webhook received but Stripe not configured — skipping');
    return res.json({ received: true });
  }

  let event;
  try {
    const stripe    = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      req.rawBody || req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[STRIPE] Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  console.log(`[STRIPE] Event: ${event.type}`);

  try {
    switch (event.type) {

      // ── New subscription created (after checkout) ─────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email   = session.customer_details?.email || session.customer_email;
        if (!email) break;

        let user = await getUserByEmail(email);
        if (!user) {
          // Auto-create account for new subscriber
          const licenseKey   = generateLicenseKey();
          const tempPassword = require('crypto').randomBytes(12).toString('hex');
          const passwordHash = await bcrypt.hash(tempPassword, 12);
          user = await createUser({ email, passwordHash, name: email.split('@')[0], licenseKey });
          await createWebhookToken(user.id);
        }

        await updateUserSubscription(user.id, {
          stripeCustomerId:   session.customer,
          subscriptionId:     session.subscription,
          subscriptionStatus: 'active',
          isActive:           true,
        });

        sendWelcomeEmail({ ...user, license_key: user.license_key }).catch(e =>
          console.error('Welcome email failed:', e.message)
        );
        break;
      }

      // ── Subscription updated (upgrade/downgrade/renewal) ──
      case 'customer.subscription.updated': {
        const sub  = event.data.object;
        const user = await getUserByStripeCustomer(sub.customer);
        if (!user) break;
        await updateUserSubscription(user.id, {
          subscriptionStatus: sub.status,
          subscriptionId:     sub.id,
          isActive:           ['active', 'trialing'].includes(sub.status),
        });
        break;
      }

      // ── Subscription cancelled ────────────────────────────
      case 'customer.subscription.deleted': {
        const sub  = event.data.object;
        const user = await getUserByStripeCustomer(sub.customer);
        if (!user) break;
        await updateUserSubscription(user.id, {
          subscriptionStatus: 'canceled',
          isActive:           false,
        });
        sendAccountDeactivatedEmail(user).catch(console.error);
        break;
      }

      // ── Payment succeeded ─────────────────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const user    = await getUserByStripeCustomer(invoice.customer);
        if (!user) break;
        await updateUserSubscription(user.id, {
          subscriptionStatus: 'active',
          isActive:           true,
        });
        break;
      }

      // ── Payment failed ────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user    = await getUserByStripeCustomer(invoice.customer);
        if (!user) break;
        await updateUserSubscription(user.id, {
          subscriptionStatus: 'past_due',
        });
        sendPaymentFailedEmail(user).catch(console.error);
        break;
      }

      default:
        console.log(`[STRIPE] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[STRIPE] Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
