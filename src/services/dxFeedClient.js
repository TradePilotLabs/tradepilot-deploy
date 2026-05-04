/**
 * DXFeed/DXLink real-time option quote streaming via TastyTrade.
 *
 * TastyTrade exposes a DXLink WebSocket endpoint at
 * wss://tasty-openapi-ws.dxfeed.com/realtime
 * Token is fetched from GET /api-quote-tokens (works with read scope).
 *
 * Each user has their own token. The client is per-user and subscribes
 * to Quote events for each open option symbol.
 */

const WebSocket    = require('ws');
const EventEmitter = require('events');

/**
 * priceHub — emits price ticks from DXFeed to any subscribers.
 * The SSE endpoint in api.js listens here and pushes to the browser.
 */
const priceHub = new EventEmitter();
priceHub.setMaxListeners(200); // many simultaneous browser tabs

// OCC "SPY   260501C00724000" → DXFeed ".SPY260501C724"
function occToDxFeed(occSym) {
  if (!occSym) return null;
  const m = occSym.trim().match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/i);
  if (!m) return null;
  const [, root, date, type, strikeRaw] = m;
  const strike = parseInt(strikeRaw, 10) / 1000;
  const strikeStr = Number.isInteger(strike) ? String(strike) : strike.toFixed(1);
  return `.${root}${date}${type.toUpperCase()}${strikeStr}`;
}

class DXFeedUserClient {
  constructor(userId) {
    this.userId    = userId;
    this.ws        = null;
    this.prices    = {}; // { dxSymbol: mid }
    this.subs      = new Set();
    this.channelOpen = false;
    this.token     = null;
    this.wsUrl     = null;
    this._closing  = false;
    // Field index map per event type, populated from FEED_CONFIG (compact format).
    // e.g. { Quote: { eventSymbol: 1, bidPrice: 2, askPrice: 3 } }
    this.schema    = {};
  }

  async start() {
    const { getTastyTokens } = require('../data/db');
    const axios = require('axios');
    const tokens = await getTastyTokens(this.userId);
    if (!tokens?.access_token) throw new Error('No TastyTrade access token');

    const r = await axios.get('https://api.tastytrade.com/api-quote-tokens', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    this.token = r.data?.data?.token;
    this.wsUrl = r.data?.data?.['dxlink-url'];
    if (!this.token || !this.wsUrl) throw new Error('Missing DXFeed token or URL');

    this._connect();
  }

  _connect() {
    if (this._closing) return;
    console.log(`[DXFEED] Connecting for user ${this.userId}`);
    this.channelOpen = false;
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this._send({ type: 'SETUP', channel: 0,
        keepaliveTimeout: 60, acceptKeepaliveTimeout: 60,
        version: '0.1-DXF-JS/0.3.0' });
    });

    this.ws.on('message', data => {
      try { this._handle(JSON.parse(data)); } catch { /* ignore bad frames */ }
    });

    this.ws.on('close', () => {
      console.log(`[DXFEED] Disconnected for user ${this.userId} — reconnecting in 5s`);
      setTimeout(() => this._connect(), 5000);
    });

    this.ws.on('error', err => {
      console.error(`[DXFEED] Error for user ${this.userId}:`, err.message);
    });
  }

  _handle(msg) {
    switch (msg.type) {
      case 'SETUP':
        this._send({ type: 'AUTH', channel: 0, token: this.token });
        break;

      case 'AUTH_STATE':
        if (msg.state === 'AUTHORIZED') {
          this._send({ type: 'CHANNEL_REQUEST', channel: 1, service: 'FEED',
            parameters: { contract: 'AUTO' } });
        }
        break;

      case 'CHANNEL_OPENED':
        this.channelOpen = true;
        if (this.subs.size > 0) this._resubscribeAll();
        break;

      case 'FEED_CONFIG':
        // Build a { fieldName → arrayIndex } map for each event type so we can
        // decode the compact array format used in FEED_DATA.
        // Server sends: { acceptEventFields: { Quote: ["eventSymbol","bidPrice","askPrice",...] } }
        if (msg.acceptEventFields) {
          for (const [evType, fields] of Object.entries(msg.acceptEventFields)) {
            const idx = {};
            fields.forEach((f, i) => { idx[f] = i; });
            this.schema[evType] = idx;
          }
          console.log(`[DXFEED] Schema for user ${this.userId}:`, JSON.stringify(this.schema));
        }
        break;

      case 'FEED_DATA':
        if (msg.channel === 1 && Array.isArray(msg.data)) {
          for (const ev of msg.data) {
            let eventType, eventSymbol, bid, ask;

            if (Array.isArray(ev)) {
              // Compact format: [eventType, field0_value, field1_value, ...]
              // Field order comes from FEED_CONFIG → this.schema.
              eventType = ev[0];
              const idx = this.schema[eventType];
              if (!idx) continue;
              // eventSymbol is always the first field in the schema (index 0 → ev[1])
              eventSymbol = ev[(idx.eventSymbol ?? 0) + 1];
              bid = parseFloat(ev[(idx.bidPrice  ?? -1) + 1] || 0);
              ask = parseFloat(ev[(idx.askPrice  ?? -1) + 1] || 0);
            } else {
              // Full/object format (fallback)
              eventType   = ev.eventType;
              eventSymbol = ev.eventSymbol;
              bid = parseFloat(ev.bidPrice || 0);
              ask = parseFloat(ev.askPrice || 0);
            }

            if (eventType === 'Quote' && (bid > 0 || ask > 0)) {
              const mid = bid && ask ? (bid + ask) / 2 : (bid || ask);
              this.prices[eventSymbol] = mid;
              const occSym = this._dxToOcc(eventSymbol);
              if (occSym) priceHub.emit(this.userId, occSym, mid);
            }
          }
        }
        break;

      case 'KEEPALIVE':
        this._send({ type: 'KEEPALIVE', channel: 0 });
        break;
    }
  }

  _send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _resubscribeAll() {
    if (!this.channelOpen || this.subs.size === 0) return;
    this._send({
      type: 'FEED_SUBSCRIPTION', channel: 1,
      add: [...this.subs].map(s => ({ type: 'Quote', symbol: s })),
    });
  }

  // ".SPY260501C724" → "SPY   260501C00724000"
  _dxToOcc(dxSym) {
    if (!dxSym) return null;
    const m = dxSym.match(/^\.([A-Z]+)(\d{6})([CP])(\d+(?:\.\d+)?)$/i);
    if (!m) return null;
    const [, root, date, type, strikeStr] = m;
    const strike = Math.round(parseFloat(strikeStr) * 1000);
    return `${root.padEnd(6, ' ')}${date}${type.toUpperCase()}${String(strike).padStart(8, '0')}`;
  }

  subscribe(occSymbol) {
    const sym = occToDxFeed(occSymbol);
    if (!sym || this.subs.has(sym)) return;
    this.subs.add(sym);
    if (this.channelOpen) {
      this._send({ type: 'FEED_SUBSCRIPTION', channel: 1,
        add: [{ type: 'Quote', symbol: sym }] });
      console.log(`[DXFEED] Subscribed to ${sym}`);
    }
  }

  unsubscribe(occSymbol) {
    const sym = occToDxFeed(occSymbol);
    if (!sym || !this.subs.has(sym)) return;
    this.subs.delete(sym);
    delete this.prices[sym];
    if (this.channelOpen) {
      this._send({ type: 'FEED_SUBSCRIPTION', channel: 1,
        remove: [{ type: 'Quote', symbol: sym }] });
    }
  }

  getPrice(occSymbol) {
    const sym = occToDxFeed(occSymbol);
    return sym ? (this.prices[sym] ?? null) : null;
  }

  stop() {
    this._closing = true;
    this.ws?.close();
  }
}

// ── Per-user client registry ───────────────────────────────────
const clients = new Map(); // userId → DXFeedUserClient

async function getClient(userId) {
  if (!clients.has(userId)) {
    const c = new DXFeedUserClient(userId);
    clients.set(userId, c);
    await c.start();
  }
  return clients.get(userId);
}

function removeClient(userId) {
  const c = clients.get(userId);
  if (c) { c.stop(); clients.delete(userId); }
}

module.exports = { getClient, removeClient, occToDxFeed, priceHub };
