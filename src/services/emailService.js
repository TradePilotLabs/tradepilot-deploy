/**
 * Email service using Resend
 * When RESEND_API_KEY is not set, emails are logged to console only
 * Drop in your key and emails start sending automatically
 */

const FROM = process.env.RESEND_FROM || 'TradePilot <hello@tradepilotlabs.com>';
const APP_URL = process.env.DASHBOARD_URL || 'https://app.tradepilotlabs.com';

async function sendEmail({ to, subject, html, type, userId }) {
  // Log to email_log table regardless of whether Resend is configured
  try {
    const { getPool } = require('../data/db');
    await getPool().query(
      `INSERT INTO email_log (user_id, type, to_email, subject, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId || null, type || 'general', to, subject, 'pending']
    );
  } catch (e) {
    console.error('Email log failed:', e.message);
  }

  // If no Resend key, just log and return
  if (!process.env.RESEND_API_KEY) {
    console.log(`[EMAIL] Would send "${subject}" to ${to} (RESEND_API_KEY not set)`);
    return { id: 'mock-' + Date.now() };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Resend error');

    // Update log with provider ID
    try {
      const { getPool } = require('../data/db');
      await getPool().query(
        `UPDATE email_log SET status = 'sent', provider_id = $1
         WHERE to_email = $2 AND type = $3
         ORDER BY created_at DESC LIMIT 1`,
        [data.id, to, type || 'general']
      );
    } catch (e) {}

    console.log(`[EMAIL] Sent "${subject}" to ${to} (${data.id})`);
    return data;
  } catch (err) {
    console.error(`[EMAIL] Failed to send "${subject}" to ${to}:`, err.message);
    throw err;
  }
}

// ─── Email templates ──────────────────────────────────────────

async function sendWelcomeEmail(user) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body { font-family: -apple-system, sans-serif; background: #0a0b14; color: #eeeef5; margin: 0; padding: 40px 20px; }
.container { max-width: 560px; margin: 0 auto; }
.logo { font-size: 24px; font-weight: 800; color: #7b93ff; margin-bottom: 32px; }
.card { background: #161820; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 32px; margin-bottom: 24px; }
h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
p { color: #8b8fa8; line-height: 1.6; margin: 0 0 16px; }
.license { font-family: monospace; font-size: 20px; font-weight: 700; color: #7b93ff; background: rgba(79,110,247,0.1); border: 1px solid rgba(79,110,247,0.3); border-radius: 8px; padding: 16px 24px; text-align: center; letter-spacing: 2px; margin: 20px 0; }
.btn { display: inline-block; background: #4f6ef7; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 8px 0; }
.footer { font-size: 12px; color: #4a4e6a; text-align: center; margin-top: 32px; }
</style></head>
<body>
<div class="container">
  <div class="logo">✈ TradePilot</div>
  <div class="card">
    <h1>Welcome to TradePilot, ${user.name || 'Trader'}!</h1>
    <p>Your Elite subscription is active and your account is ready. Here's your license key — keep it safe.</p>
    <div class="license">${user.license_key}</div>
    <p>This key is tied to your account and confirms your subscription status. You'll need it if you ever contact support.</p>
    <a href="${APP_URL}" class="btn">Open TradePilot Dashboard →</a>
  </div>
  <div class="card">
    <h1 style="font-size:16px">Get started in 3 steps</h1>
    <p>1. <strong style="color:#eeeef5">Connect TastyTrade</strong> — Click "Connect Broker" and authorize with your TastyTrade account</p>
    <p>2. <strong style="color:#eeeef5">Choose a strategy</strong> — Pick a managed strategy or connect your own TradingView signals</p>
    <p style="margin:0">3. <strong style="color:#eeeef5">Enable trading</strong> — Toggle trading on and TradePilot handles the rest</p>
  </div>
  <div class="footer">
    TradePilot Labs · <a href="mailto:hello@tradepilotlabs.com" style="color:#4a4e6a">hello@tradepilotlabs.com</a><br>
    You're receiving this because you signed up for TradePilot.
  </div>
</div>
</body>
</html>`;
  return sendEmail({
    to: user.email, subject: 'Welcome to TradePilot — your license key inside',
    html, type: 'welcome', userId: user.id,
  });
}

async function sendPasswordResetEmail(user, resetToken) {
  const resetUrl = `${APP_URL}/reset-password?token=${resetToken}`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body { font-family: -apple-system, sans-serif; background: #0a0b14; color: #eeeef5; margin: 0; padding: 40px 20px; }
.container { max-width: 560px; margin: 0 auto; }
.logo { font-size: 24px; font-weight: 800; color: #7b93ff; margin-bottom: 32px; }
.card { background: #161820; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 32px; margin-bottom: 24px; }
h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
p { color: #8b8fa8; line-height: 1.6; margin: 0 0 16px; }
.btn { display: inline-block; background: #4f6ef7; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; }
.warning { background: rgba(240,82,82,0.1); border: 1px solid rgba(240,82,82,0.2); border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #f05252; margin-top: 16px; }
.footer { font-size: 12px; color: #4a4e6a; text-align: center; margin-top: 32px; }
</style></head>
<body>
<div class="container">
  <div class="logo">✈ TradePilot</div>
  <div class="card">
    <h1>Reset your password</h1>
    <p>We received a request to reset the password for your TradePilot account. Click the button below to set a new password.</p>
    <a href="${resetUrl}" class="btn">Reset Password →</a>
    <p style="margin-top:20px;font-size:13px">This link expires in <strong style="color:#eeeef5">1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>
    <div class="warning">If you did not request a password reset, please contact us immediately at hello@tradepilotlabs.com</div>
  </div>
  <div class="footer">
    TradePilot Labs · <a href="mailto:hello@tradepilotlabs.com" style="color:#4a4e6a">hello@tradepilotlabs.com</a>
  </div>
</div>
</body>
</html>`;
  return sendEmail({
    to: user.email, subject: 'Reset your TradePilot password',
    html, type: 'password_reset', userId: user.id,
  });
}

async function sendPaymentFailedEmail(user) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body { font-family: -apple-system, sans-serif; background: #0a0b14; color: #eeeef5; margin: 0; padding: 40px 20px; }
.container { max-width: 560px; margin: 0 auto; }
.logo { font-size: 24px; font-weight: 800; color: #7b93ff; margin-bottom: 32px; }
.card { background: #161820; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 32px; }
h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; color: #f05252; }
p { color: #8b8fa8; line-height: 1.6; margin: 0 0 16px; }
.btn { display: inline-block; background: #4f6ef7; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; }
.footer { font-size: 12px; color: #4a4e6a; text-align: center; margin-top: 32px; }
</style></head>
<body>
<div class="container">
  <div class="logo">✈ TradePilot</div>
  <div class="card">
    <h1>Payment failed</h1>
    <p>Hi ${user.name || 'there'}, we were unable to process your TradePilot subscription payment.</p>
    <p>Your account will remain active for 3 days. Please update your payment method to avoid any interruption to your trading.</p>
    <a href="${APP_URL}/billing" class="btn">Update Payment Method →</a>
    <p style="margin-top:20px;font-size:13px">If you need help, reply to this email or contact us at hello@tradepilotlabs.com</p>
  </div>
  <div class="footer">TradePilot Labs</div>
</div>
</body>
</html>`;
  return sendEmail({
    to: user.email, subject: 'Action required: TradePilot payment failed',
    html, type: 'payment_failed', userId: user.id,
  });
}

async function sendAccountDeactivatedEmail(user) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body { font-family: -apple-system, sans-serif; background: #0a0b14; color: #eeeef5; margin: 0; padding: 40px 20px; }
.container { max-width: 560px; margin: 0 auto; }
.logo { font-size: 24px; font-weight: 800; color: #7b93ff; margin-bottom: 32px; }
.card { background: #161820; border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 32px; }
h1 { font-size: 22px; font-weight: 700; margin: 0 0 12px; }
p { color: #8b8fa8; line-height: 1.6; margin: 0 0 16px; }
.btn { display: inline-block; background: #4f6ef7; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; }
.footer { font-size: 12px; color: #4a4e6a; text-align: center; margin-top: 32px; }
</style></head>
<body>
<div class="container">
  <div class="logo">✈ TradePilot</div>
  <div class="card">
    <h1>Your account has been deactivated</h1>
    <p>Hi ${user.name || 'there'}, your TradePilot subscription has ended and automated trading has been disabled.</p>
    <p>Your trade history and settings are preserved. Reactivate any time to pick up where you left off.</p>
    <a href="${APP_URL}/billing" class="btn">Reactivate Account →</a>
  </div>
  <div class="footer">TradePilot Labs</div>
</div>
</body>
</html>`;
  return sendEmail({
    to: user.email, subject: 'Your TradePilot account has been deactivated',
    html, type: 'account_deactivated', userId: user.id,
  });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPaymentFailedEmail,
  sendAccountDeactivatedEmail,
};
