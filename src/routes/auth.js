const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { createUser, getUserByEmail, createWebhookToken, getWebhookToken } = require('../data/db');
const { issueToken, requireAuth } = require('../middleware/auth');

// POST /auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser({ email, passwordHash, name: name || email.split('@')[0] });

    // Generate their unique webhook token immediately on signup
    const webhookToken = await createWebhookToken(user.id);

    const jwt = issueToken(user.id);
    res.status(201).json({
      token: jwt,
      user: { id: user.id, email: user.email, name: user.name },
      webhookToken,
      webhookUrl: `${process.env.ATS_URL || 'https://ats.tradepilot.io'}/webhook/${webhookToken}`,
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const webhookToken = await getWebhookToken(user.id);
    const jwt = issueToken(user.id);

    res.json({
      token: jwt,
      user: { id: user.id, email: user.email, name: user.name },
      webhookToken,
      webhookUrl: `${process.env.ATS_URL || 'https://ats.tradepilot.io'}/webhook/${webhookToken}`,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /auth/me  — returns current user info (requires JWT)
router.get('/me', requireAuth, async (req, res) => {
  const webhookToken = await getWebhookToken(req.user.id);
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name },
    webhookToken,
    webhookUrl: `${process.env.ATS_URL || 'https://ats.tradepilot.io'}/webhook/${webhookToken}`,
  });
});

module.exports = router;
