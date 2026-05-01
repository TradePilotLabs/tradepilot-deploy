const { connectDB, getPool } = require('../src/data/db');
const { connectRedis }       = require('../src/data/redis');
const { getOrder }           = require('../src/services/tastyClient');

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

  const { rows } = await pool.query(
    'SELECT account_number FROM tastytrade_tokens WHERE user_id=$1', [USER_ID]);
  const accountNumber = rows[0]?.account_number;
  console.log('Account:', accountNumber);

  for (const { tradeId, orderId } of TRADES) {
    try {
      const order     = await getOrder(USER_ID, accountNumber, orderId);
      console.log(`Order ${orderId} raw:`, JSON.stringify(order, null, 2).slice(0, 500));
      const status    = order?.status || 'unknown';
      const fillPrice = parseFloat(order?.['avg-fill-price'] || order?.price || 0);
      console.log(`Order ${orderId}: status=${status} fill=$${fillPrice}`);

      if (fillPrice > 0) {
        await pool.query('UPDATE trades SET entry_price=$1 WHERE id=$2 AND entry_price IS NULL',
          [fillPrice, tradeId]);
        console.log(`  Updated entry_price=$${fillPrice}`);
      }
    } catch (e) {
      console.error(`Order ${orderId}:`, e.message);
    }
  }
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
