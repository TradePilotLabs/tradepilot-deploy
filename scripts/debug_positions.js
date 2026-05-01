const { connectDB, getTastyTokens } = require('../src/data/db');
const { connectRedis } = require('../src/data/redis');
const axios = require('axios');

const USER_ID = '185c2872-2ab4-4865-b3df-84fe88fa80ff';
const BASE    = 'https://api.tastytrade.com';

async function run() {
  connectDB();
  connectRedis();
  await new Promise(r => setTimeout(r, 1500));

  const tokens = await getTastyTokens(USER_ID);
  const { access_token, account_number } = tokens;
  console.log('Account:', account_number);
  console.log('Token scopes (from JWT):', (() => {
    try { return JSON.parse(Buffer.from(access_token.split('.')[1], 'base64').toString()).scope; }
    catch { return 'unknown'; }
  })());

  const endpoints = [
    '/quote-streamer-tokens',
    '/api-quote-tokens',
    '/market-data/quote-streamer-tokens',
    '/market-data/quote-tokens',
  ];

  for (const ep of endpoints) {
    try {
      const r = await axios.get(BASE + ep, { headers: { Authorization: `Bearer ${access_token}` }, validateStatus: () => true });
      console.log(`\n${ep}: HTTP ${r.status}`);
      if (r.status === 200) console.log('  Data:', JSON.stringify(r.data).slice(0, 300));
    } catch (e) {
      console.log(`${ep}: ERROR ${e.message}`);
    }
  }

  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
