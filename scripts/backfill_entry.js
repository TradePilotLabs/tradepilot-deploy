const { connectDB, getPool, getTastyTokens, updateTastyAccessToken } = require('../src/data/db');
const { connectRedis } = require('../src/data/redis');
const { decrypt }      = require('../src/services/encryption');
const axios            = require('axios');

const USER_ID = '185c2872-2ab4-4865-b3df-84fe88fa80ff';

async function run() {
  connectDB();
  connectRedis();
  await new Promise(r => setTimeout(r, 1500));
  const pool = getPool();

  const tokens = await getTastyTokens(USER_ID);
  const accountNumber = tokens.account_number;
  let accessToken = tokens.access_token;

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

  const headers = { Authorization: `Bearer ${accessToken}` };

  // ── Fetch all orders for the account on April 30 ──────────────
  console.log('\n=== Fetching all orders for 2026-04-30 ===');
  const ordersRes = await axios.get(
    `https://api.tastytrade.com/accounts/${accountNumber}/orders`,
    {
      headers,
      params: { 'start-date': '2026-04-30', 'end-date': '2026-04-30', 'per-page': 50 },
      validateStatus: () => true,
    }
  );
  console.log(`HTTP ${ordersRes.status}`);

  const orders = ordersRes.data?.data?.items || [];
  console.log(`Found ${orders.length} orders\n`);

  for (const o of orders) {
    const sym    = o.legs?.[0]?.symbol || '—';
    const action = o.legs?.[0]?.action || '—';
    const fills  = o.legs?.[0]?.fills  || [];
    const fill   = fills[0]?.['fill-price'] || '—';
    console.log(`  [${o.id}] ${o.status} ${o['order-type']} ${action} ${sym} fill=${fill} at=${o['terminal-at']}`);
  }

  // ── Find BTO and STC orders for SPY   260430C00715000 ─────────
  const sym715 = 'SPY   260430C00715000';
  const bto = orders.find(o =>
    o.id == 461951610 ||
    (o.legs?.[0]?.symbol === sym715 && o.legs?.[0]?.action === 'Buy to Open' && o.status === 'Filled')
  );
  const stc = orders.find(o =>
    o.id !== (bto?.id) &&
    o.legs?.[0]?.symbol === sym715 && o.legs?.[0]?.action === 'Sell to Close' && o.status === 'Filled'
  );

  console.log('\n=== SPY715 BTO ===', bto ? `id=${bto.id}` : 'not found');
  if (bto) {
    const fills = bto.legs?.[0]?.fills || [];
    console.log('  fills:', JSON.stringify(fills));
    console.log('  avg-fill-price:', bto['avg-fill-price']);
  }

  console.log('\n=== SPY715 STC ===', stc ? `id=${stc.id}` : 'not found');
  if (stc) {
    const fills = stc.legs?.[0]?.fills || [];
    console.log('  fills:', JSON.stringify(fills));
    console.log('  avg-fill-price:', stc['avg-fill-price']);
    console.log('  terminal-at:', stc['terminal-at']);
  }

  // ── Update DB with real prices ────────────────────────────────
  const entryFill = parseFloat(bto?.legs?.[0]?.fills?.[0]?.['fill-price'] || bto?.['avg-fill-price'] || 0);
  const exitFill  = parseFloat(stc?.legs?.[0]?.fills?.[0]?.['fill-price'] || stc?.['avg-fill-price'] || 0);
  const exitTime  = stc?.['terminal-at'] || null;
  const pnl       = entryFill && exitFill ? (exitFill - entryFill) * 1 * 100 : null;

  console.log(`\nEntry fill: $${entryFill}  Exit fill: $${exitFill}  P&L: $${pnl}  ExitTime: ${exitTime}`);

  if (entryFill > 0) {
    await pool.query('UPDATE trades SET entry_price=$1 WHERE id=$2',
      [entryFill, '30111bf3-b1bc-498b-959f-f06e6ef03cec']);
    console.log(`✓ entry_price updated to $${entryFill}`);
  }
  if (exitFill > 0 && pnl !== null) {
    await pool.query(
      "UPDATE trades SET exit_price=$1, pnl=$2, exit_reason='manual_close', exit_time=$3 WHERE id=$4",
      [exitFill, pnl, exitTime, '30111bf3-b1bc-498b-959f-f06e6ef03cec']
    );
    console.log(`✓ exit_price=$${exitFill} pnl=$${pnl} exit_time=${exitTime}`);
  }

  // ── Confirm SPY720 status ─────────────────────────────────────
  const ord720 = orders.find(o => o.id == 461985725);
  console.log('\nSPY720 order status:', ord720?.status || 'not found in list');

  await pool.end();
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
