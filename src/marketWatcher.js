const WebSocket = require('ws');
const https     = require('https');
const logger    = require('./logger');

const WS_URL          = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RECONNECT_DELAY = 5000;
const PING_INTERVAL   = 30000;
const STALE_MS        = 15000;

// tokenId → { best_bid, best_ask, spread, updatedAt }
const _bookData   = {};
const _subscribed = new Set();

let _ws             = null;
let _connected      = false;
let _reconnectTimer = null;
let _pingInterval   = null;

function getBestBid(tokenId)  { return _bookData[tokenId]?.best_bid ?? null; }
function getBestAsk(tokenId)  { return _bookData[tokenId]?.best_ask ?? null; }
function getBookData(tokenId) { return _bookData[tokenId] || null; }
function isConnected()        { return _connected; }
function isFresh(tokenId) {
  const d = _bookData[tokenId];
  return !!(d && d.updatedAt && (Date.now() - d.updatedAt < STALE_MS));
}

function _sendJson(payload) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
  try { _ws.send(JSON.stringify(payload)); } catch {}
}

function subscribe(tokenId) {
  if (_subscribed.has(tokenId)) return;
  _subscribed.add(tokenId);
  if (_connected) _sendJson({ assets_ids: [tokenId], type: 'Market' });
}

function unsubscribe(tokenId) {
  _subscribed.delete(tokenId);
  delete _bookData[tokenId];
}

function _handleMessage(raw) {
  try {
    const events = JSON.parse(raw);
    const arr = Array.isArray(events) ? events : [events];
    for (const ev of arr) {
      const tokenId = ev.asset_id;
      if (!tokenId) continue;
      if (!_bookData[tokenId]) _bookData[tokenId] = {};

      const bid   = ev.best_bid != null ? parseFloat(ev.best_bid) : null;
      const ask   = ev.best_ask != null ? parseFloat(ev.best_ask) : null;
      const price = ev.price    != null ? parseFloat(ev.price)    : null;

      if (bid !== null) _bookData[tokenId].best_bid = bid;
      if (ask !== null) _bookData[tokenId].best_ask = ask;
      if (bid !== null && ask !== null) {
        _bookData[tokenId].spread = parseFloat((ask - bid).toFixed(4));
      }
      // Fallback: use mid price as approximate best_bid if no explicit bid
      if (bid === null && price !== null && _bookData[tokenId].best_bid == null) {
        _bookData[tokenId].best_bid = price;
      }
      _bookData[tokenId].updatedAt = Date.now();
    }
  } catch {}
}

function connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

  try {
    // Fresh agent — bypass global proxy. Market data is public, direct VPS connection only.
    const directAgent = new https.Agent();
    _ws = new WebSocket(WS_URL, { agent: directAgent });

    _ws.on('open', () => {
      _connected = true;
      logger.addActivity('market_watcher', {
        message: `Market WebSocket connected (direct/no-proxy) — ${_subscribed.size} token(s) subscribed`
      });
      if (_subscribed.size > 0) {
        _sendJson({ assets_ids: [..._subscribed], type: 'Market' });
      }
      if (_pingInterval) clearInterval(_pingInterval);
      _pingInterval = setInterval(() => {
        if (_ws && _ws.readyState === WebSocket.OPEN) { try { _ws.ping(); } catch {} }
      }, PING_INTERVAL);
    });

    _ws.on('message', (data) => _handleMessage(data.toString()));

    _ws.on('close', (code) => {
      _connected = false;
      if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
      logger.addActivity('market_watcher', {
        message: `Market WebSocket closed (${code}) — reconnecting in ${RECONNECT_DELAY / 1000}s`
      });
      if (_reconnectTimer) clearTimeout(_reconnectTimer);
      _reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
    });

    _ws.on('error', (err) => {
      _connected = false;
      logger.addActivity('market_watcher', {
        message: `Market WebSocket error: ${err.message?.slice(0, 80)}`
      });
    });

  } catch (err) {
    logger.addActivity('market_watcher', {
      message: `WebSocket init failed: ${err.message?.slice(0, 80)} — retry in ${RECONNECT_DELAY / 1000}s`
    });
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
  }
}

function disconnect() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_pingInterval)   { clearInterval(_pingInterval);  _pingInterval = null; }
  if (_ws) { try { _ws.terminate(); } catch {} _ws = null; }
  _connected = false;
}

module.exports = {
  connect, disconnect,
  subscribe, unsubscribe,
  getBestBid, getBestAsk, getBookData,
  isConnected, isFresh
};
