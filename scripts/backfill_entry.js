const { connectDB, getPool } = require('../src/data/db');
const { connectRedis }       = require('../src/data/redis');
const axios                  = require('axios');

const USER_ID = '185c2872-2ab4-4865-b3df-84fe88fa80ff';
const TRADES  = [
  { tradeId: '30111bf3-b1bc-498b-959f-f06e6ef03cec', orderId: '461951610' },
  { tradeId: '458f9a23-e7ae-41da-ae9c-e4bd3c225ab3', orderId: '461985725' },
];

async function run() {
  connectDB();
  connectRedis();
  await new Promise(r => setTimeout(r, 1500));
  const pool = getPool();

  // Get fresh token (app handles refresh internally via tastyClient)
  const { getTastyTokens, updateTastyAccessToken } = require('../src/data/db');
  const { decrypt } = require('../src/services/encryption');
  const tokens = await getTastyTokens(USER_ID);
  const accountNumber = tokens.account_number;
  console.log('Account:', accountNumber);
  console.log('Token expires:', tokens.expires_at);

  // Refresh token if needed
  let accessToken = tokens.access_token;
  if (tokens.expires_at && new Date(tokens.expires_at) < new Date(Date.now() + 60000)) {
    console.log('Token expired, refreshing...');
    try {
      const clientId     = decrypt(tokens.client_id_encrypted);
      const clientSecret = decrypt(tokens.client_secret_encrypted);
      const res = await axios.post('https://api.tastytrade.com/oauth/token',
        new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
          client_secret: clientSecret, refresh_token: tokens.refresh_token }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      accessToken = res.data.access_token;
      const expiresAt = new Date(Date.now() + res.data.expires_in * 1000);
      await updateTastyAccessToken(USER_ID, accessToken, expiresAt);
      console.log('Token refreshed');
    } catch (e) {
      console.error('Token refresh failed:', e.response?.data || e.message);
    }
  }

  for (const { tradeId, orderId } of TRADES) {
    try {
      const url = `https://api.tastytrade.com/accounts/${accountNumber}/orders/${orderId}`;
      console.log(`\nFetching ${url}`);
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        validateStatus: () => true,
      });
      console.log(`  HTTP ${res.status}:`, JSON.stringify(res.data).slice(0, 400));

      const order     = res.data?.data?.order || res.data?.data || res.data;
      const status    = order?.status;
      const fillPrice = parseFloat(order?.['avg-fill-price'] || 0);
      console.log(`  status=${status} fill=$${fillPrice}`);

      if (fillPrice > 0) {
        await pool.query('UPDATE trades SET entry_price=$1 WHERE id=$2 AND entry_price IS NULL',
          [fillPrice, tradeId]);
        console.log(`  ✓ Updated entry_price=$${fillPrice}`);
      }
    } catch (e) {
      console.error(`Order ${orderId}:`, e.message);
    }
  }
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
