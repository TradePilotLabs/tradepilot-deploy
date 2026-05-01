const { connectDB, getPool, getTastyTokens, updateTastyAccessToken } = require('../src/data/db');
const { connectRedis } = require('../src/data/redis');
const { decrypt }      = require('../src/services/encryption');
const axios            = require('axios');

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

  const tokens = await getTastyTokens(USER_ID);
  const accountNumber = tokens.account_number;
  let accessToken = tokens.access_token;

  // Refresh if expired
  if (tokens.expires_at && new Date(tokens.expires_at) < new Date(Date.now() + 60000)) {
    const clientId     = decrypt(tokens.client_id_encrypted);
    const clientSecret = decrypt(tokens.client_secret_encrypted);
    const r = await axios.post('https://api.tastytrade.com/oauth/token',
      new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
        client_secret: clientSecret, refresh_token: tokens.refresh_token }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    accessToken = r.data.access_token;
    await updateTastyAccessToken(USER_ID, accessToken, new Date(Date.now() + r.data.expires_in * 1000));
    console.log('Token refreshed');
  }

  for (const { tradeId, orderId } of TRADES) {
    try {
      const res = await axios.get(
        `https://api.tastytrade.com/accounts/${accountNumber}/orders/${orderId}`,
        { headers: { Authorization: `Bearer ${accessToken}` }, validateStatus: () => true }
      );
      const order     = res.data?.data;
      const status    = order?.status;
      const fillPrice = parseFloat(order?.['avg-fill-price'] || 0);

      // Also check fills array for actual fill price
      const fills = order?.legs?.[0]?.fills || order?.fills || [];
      const legFill = fills[0]?.['fill-price'] ? parseFloat(fills[0]['fill-price']) : null;

      console.log(`Order ${orderId}: status=${status} avg-fill=${order?.['avg-fill-price']} leg-fill=${legFill}`);
      console.log(`  Full order keys:`, Object.keys(order || {}).join(', '));

      const price = fillPrice || legFill;
      if (price > 0) {
        await pool.query('UPDATE trades SET entry_price=$1 WHERE id=$2 AND entry_price IS NULL',
          [price, tradeId]);
        console.log(`  ✓ Updated entry_price=$${price} for ${tradeId}`);
      } else {
        console.log(`  No fill price found for ${orderId}`);
      }
    } catch (e) {
      console.error(`Order ${orderId}:`, e.message);
    }
  }

  await pool.end();
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
