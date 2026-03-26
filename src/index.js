require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { connectDB }    = require('./data/db');
const { connectRedis } = require('./data/redis');

const app = express();

// ─── CORS ─────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.DASHBOARD_URL,
    'http://localhost:5173',
    'http://localhost:3001',
  ].filter(Boolean),
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────
app.use('/auth',             require('./routes/auth'));
app.use('/auth/tastytrade',  require('./routes/tastytrade'));
app.use('/api',              require('./routes/api'));

// Phase 3 — strategy webhook MUST be before /webhook
// so /webhook/strategy/:slug is matched correctly
app.use('/webhook/strategy', require('./routes/strategyWebhook'));
app.use('/webhook',          require('./routes/webhook'));

// Phase 3 — admin panel API
app.use('/admin',            require('./routes/admin'));

// Phase 4 — morning mode / market condition
app.use('/api/market-condition', require('./routes/marketCondition'));

// ─── Health ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'TradePilot ATS', ts: new Date().toISOString() });
});

// ─── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Startup ──────────────────────────────────────────────────
async function start() {
  await connectDB();
  await connectRedis();

  const { startPositionMonitor } = require('./services/positionMonitor');
  const { scheduleMarketClose }  = require('./jobs/marketClose');
  startPositionMonitor();
  scheduleMarketClose();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n✈  TradePilot ATS running on port ${PORT}`);
    console.log(`   Environment  : ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Dashboard    : ${process.env.DASHBOARD_URL}`);
    console.log(`   Strategy hook: ${process.env.ATS_URL}/webhook/strategy/<slug>?secret=<key>`);
    console.log(`   Admin API    : ${process.env.ATS_URL}/admin`);
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
