const { connectDB, getPool, getTastyTokens } = require('../src/data/db');
const { connectRedis } = require('../src/data/redis');
const axios = require('axios');

const USER_ID = '185c2872-2ab4-4865-b3df-84fe88fa80ff';

async function run() {
  connectDB();
  connectRedis();
  await new Promise(r => setTimeout(r, 1500));

  const tokens = await getTastyTokens(USER_ID);
  const { access_token, account_number } = tokens;
  console.log('Account:', account_number);

  const r = await axios.get(
    `https://api.tastytrade.com/accounts/${account_number}/positions`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );
  const items = r.data?.data?.items || [];
  console.log(`\nFound ${items.length} position(s):\n`);
  items.forEach(pos => {
    console.log('Symbol:          ', pos.symbol);
    console.log('Mark:            ', pos['mark']);
    console.log('Mark-price:      ', pos['mark-price']);
    console.log('Close-price:     ', pos['close-price']);
    console.log('Market-value:    ', pos['market-value']);
    console.log('Average-open:    ', pos['average-open-price']);
    console.log('Multiplier:      ', pos['multiplier']);
    console.log('All keys:        ', Object.keys(pos).join(', '));
    console.log('---');
  });

  // Also try quote streamer token endpoint
  try {
    const qr = await axios.get(
      'https://api.tastytrade.com/quote-streamer-tokens',
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    console.log('\nQuote streamer token response:', JSON.stringify(qr.data).slice(0, 300));
  } catch (e) {
    console.log('\nQuote streamer tokens:', e.response?.status, e.message);
  }

  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
