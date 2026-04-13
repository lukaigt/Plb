const WebSocket = require('ws');
const logger = require('./logger');

const KRAKEN_WS_URL = 'wss://ws.kraken.com/v2';
const PAIR = 'BTC/USD';

let ws = null;
let isConnected = false;
let reconnectTimer = null;
let heartbeatTimer = null;

let latestPrice = null;
let latestBid = null;
let latestAsk = null;
let lastUpdateTime = null;

const priceHistory = [];
const MAX_HISTORY = 600;

const windowOpenPrices = {};
const MAX_WINDOW_ENTRIES = 50;

function get5MinWindowKey(timestamp) {
  const ts = Math.floor(timestamp / 1000);
  return Math.floor(ts / 300) * 300;
}

function trackWindowOpenPrice(price, timestamp) {
  const windowKey = get5MinWindowKey(timestamp);

  if (!windowOpenPrices[windowKey]) {
    windowOpenPrices[windowKey] = {
      openPrice: price,
      openTime: timestamp,
      windowKey
    };

    const keys = Object.keys(windowOpenPrices).map(Number).sort();
    while (keys.length > MAX_WINDOW_ENTRIES) {
      delete windowOpenPrices[keys.shift()];
    }
  }
}

function getCurrentWindowOpen() {
  const now = Date.now();
  const windowKey = get5MinWindowKey(now);
  return windowOpenPrices[windowKey] || null;
}

function getWindowOpenPrice(windowKey) {
  return windowOpenPrices[windowKey] || null;
}

function getWindowStatus() {
  const now = Date.now();
  const windowKey = get5MinWindowKey(now);
  const windowEndMs = (windowKey + 300) * 1000;
  const secondsLeft = Math.max(0, (windowEndMs - now) / 1000);
  const windowOpen = windowOpenPrices[windowKey];

  let btcVsOpen = null;
  let btcVsOpenDollars = null;
  let btcVsOpenRaw = null;
  let btcLeadingSide = null;

  if (windowOpen && latestPrice) {
    btcVsOpenRaw = latestPrice - windowOpen.openPrice;
    btcVsOpenDollars = Math.abs(btcVsOpenRaw);
    btcVsOpen = btcVsOpenRaw >= 0 ? 'ABOVE' : 'BELOW';
    btcLeadingSide = btcVsOpenRaw >= 0 ? 'UP' : 'DOWN';
  }

  return {
    windowKey,
    windowEndMs,
    secondsLeft: Math.round(secondsLeft * 10) / 10,
    openPrice: windowOpen?.openPrice || null,
    currentPrice: latestPrice,
    btcVsOpen,
    btcVsOpenDollars: btcVsOpenDollars !== null ? btcVsOpenDollars : null,
    btcVsOpenRaw: btcVsOpenRaw,
    btcLeadingSide
  };
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(KRAKEN_WS_URL);

    ws.on('open', () => {
      isConnected = true;
      logger.addActivity('kraken', { message: 'Connected to Kraken WebSocket v2' });

      ws.send(JSON.stringify({
        method: 'subscribe',
        params: {
          channel: 'ticker',
          symbol: [PAIR]
        }
      }));

      startHeartbeat();
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.channel === 'ticker' && msg.data && msg.data.length > 0) {
          const ticker = msg.data[0];
          const now = Date.now();

          latestPrice = parseFloat(ticker.last);
          latestBid = parseFloat(ticker.bid);
          latestAsk = parseFloat(ticker.ask);
          lastUpdateTime = now;

          priceHistory.push({
            price: latestPrice,
            bid: latestBid,
            ask: latestAsk,
            time: now
          });

          while (priceHistory.length > MAX_HISTORY) {
            priceHistory.shift();
          }

          trackWindowOpenPrice(latestPrice, now);
        }

        if (msg.channel === 'heartbeat') {
          resetHeartbeat();
        }
      } catch (err) {}
    });

    ws.on('error', (err) => {
      logger.addActivity('kraken_error', { message: `WebSocket error: ${err.message?.substring(0, 60)}` });
    });

    ws.on('close', (code, reason) => {
      isConnected = false;
      stopHeartbeat();
      logger.addActivity('kraken', { message: `Disconnected (code: ${code}). Reconnecting in 5s...` });
      scheduleReconnect();
    });
  } catch (err) {
    logger.addActivity('kraken_error', { message: `Connection failed: ${err.message?.substring(0, 60)}` });
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 5000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function resetHeartbeat() {
  startHeartbeat();
}

function getLatestPrice() {
  return {
    price: latestPrice,
    bid: latestBid,
    ask: latestAsk,
    lastUpdate: lastUpdateTime,
    connected: isConnected,
    stale: lastUpdateTime ? (Date.now() - lastUpdateTime > 30000) : true
  };
}

function getPriceContext() {
  const now = Date.now();

  if (!latestPrice || priceHistory.length === 0) {
    return {
      available: false,
      reason: 'No BTC price data from Kraken yet'
    };
  }

  if (lastUpdateTime && (now - lastUpdateTime > 60000)) {
    return {
      available: false,
      reason: 'BTC price data is stale (>60s old)'
    };
  }

  const currentPrice = latestPrice;

  const getChangeFromAgo = (secondsAgo) => {
    const cutoff = now - (secondsAgo * 1000);
    const older = priceHistory.filter(p => p.time <= cutoff);
    if (older.length === 0) return null;
    const ref = older[older.length - 1];
    return {
      priceAtTime: ref.price,
      change: currentPrice - ref.price,
      changePct: ((currentPrice - ref.price) / ref.price * 100)
    };
  };

  const change1m = getChangeFromAgo(60);
  const change3m = getChangeFromAgo(180);
  const change5m = getChangeFromAgo(300);

  const recent30s = priceHistory.filter(p => p.time >= now - 30000);
  let recentHigh = currentPrice;
  let recentLow = currentPrice;
  for (const p of recent30s) {
    if (p.price > recentHigh) recentHigh = p.price;
    if (p.price < recentLow) recentLow = p.price;
  }
  const recentVolatility = recentHigh - recentLow;

  let direction = 'FLAT';
  if (change1m && change1m.changePct > 0.05) direction = 'RISING';
  else if (change1m && change1m.changePct < -0.05) direction = 'FALLING';

  return {
    available: true,
    currentPrice,
    bid: latestBid,
    ask: latestAsk,
    direction,
    change1m: change1m ? { dollars: change1m.change.toFixed(2), percent: change1m.changePct.toFixed(3) } : null,
    change3m: change3m ? { dollars: change3m.change.toFixed(2), percent: change3m.changePct.toFixed(3) } : null,
    change5m: change5m ? { dollars: change5m.change.toFixed(2), percent: change5m.changePct.toFixed(3) } : null,
    recentVolatility: recentVolatility.toFixed(2),
    historyLength: priceHistory.length,
    connected: isConnected
  };
}

function isChoppyMarket() {
  const ctx = getPriceContext();
  if (!ctx.available || !ctx.change1m || !ctx.change3m) return false;

  const pct1m = parseFloat(ctx.change1m.percent);
  const pct3m = parseFloat(ctx.change3m.percent);

  const sameDirection = (pct1m > 0 && pct3m > 0) || (pct1m < 0 && pct3m < 0);
  return !sameDirection;
}

function buildPriceText() {
  const ctx = getPriceContext();

  if (!ctx.available) {
    return `REAL BTC PRICE: Not available (${ctx.reason})`;
  }

  let text = `REAL BTC PRICE (Kraken, live):\n`;
  text += `  Current: $${ctx.currentPrice.toLocaleString()}\n`;
  text += `  Direction: ${ctx.direction}\n`;

  if (ctx.change1m) text += `  1-min change: $${ctx.change1m.dollars} (${ctx.change1m.percent}%)\n`;
  if (ctx.change3m) text += `  3-min change: $${ctx.change3m.dollars} (${ctx.change3m.percent}%)\n`;
  if (ctx.change5m) text += `  5-min change: $${ctx.change5m.dollars} (${ctx.change5m.percent}%)\n`;

  text += `  30s volatility: $${ctx.recentVolatility}`;

  return text;
}

module.exports = {
  connect,
  getLatestPrice,
  getPriceContext,
  buildPriceText,
  getCurrentWindowOpen,
  getWindowOpenPrice,
  getWindowStatus,
  get5MinWindowKey,
  isChoppyMarket
};
