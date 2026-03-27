const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { createUser, getUserByEmail, getUserById, createWebhookToken, getWebhookToken,
        createPasswordResetToken, getPasswordResetToken, markPasswordResetTokenUsed,
        updateUserPassword, updateUserLastLogin } = require('../data/db');
const { issueToken, requireAuth } = require('../middleware/auth');
const { loginLimiter, signupLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../services/emailService');
const { generateLicenseKey, generateToken } = require('../services/encryption');

// POST /auth/signup
router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });
    const passwordHash = await bcrypt.hash(password, 12);
    const licenseKey   = generateLicenseKey();
    const user = await createUser({ email, passwordHash, name: name || email.split('@')[0], licenseKey });
    const webhookToken = await createWebhookToken(user.id);
    sendWelcomeEmail({ ...user, license_key: licenseKey }).catch(e =>
      console.error('Welcome email failed:', e.message)
    );
    const jwt = issueToken(user.id);
    res.status(201).json({
      token: jwt,
      user:  { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin, licenseKey },
      webhookUrl: `${process.env.ATS_URL}/webhook/${webhookToken}`,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// POST /auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account deactivated', code: 'ACCOUNT_DEACTIVATED' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    await updateUserLastLogin(user.id, req.ip).catch(() => {});
    const webhookToken = await getWebhookToken(user.id);
    const jwt = issueToken(user.id);
    res.json({
      token: jwt,
      user: {
        id: user.id, email: user.email, name: user.name,
        is_admin: user.is_admin, licenseKey: user.license_key,
        subscriptionStatus: user.subscription_status, plan: user.plan,
      },
      webhookUrl: `${process.env.ATS_URL}/webhook/${webhookToken}`,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    const webhookToken = await getWebhookToken(req.user.id);
    res.json({
      user: {
        id: user.id, email: user.email, name: user.name,
        is_admin: user.is_admin, licenseKey: user.license_key,
        subscriptionStatus: user.subscription_status, plan: user.plan,
      },
      webhookUrl: `${process.env.ATS_URL}/webhook/${webhookToken}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/forgot-password
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    // Always return success — prevents email enumeration attacks
    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
    const user = await getUserByEmail(email);
    if (!user) return;
    const token    = generateToken(32);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await createPasswordResetToken(user.id, token, expiresAt);
    sendPasswordResetEmail(user, token).catch(e =>
      console.error('Reset email failed:', e.message)
    );
  } catch (err) {
    console.error('Forgot password error:', err);
  }
});

// POST /auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const record = await getPasswordResetToken(token);
    if (!record) return res.status(400).json({ error: 'Invalid or expired reset link' });
    if (record.used) return res.status(400).json({ error: 'This reset link has already been used' });
    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Reset link has expired — please request a new one' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await updateUserPassword(record.user_id, passwordHash);
    await markPasswordResetTokenUsed(token);
    res.json({ message: 'Password updated successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

module.exports = router;
