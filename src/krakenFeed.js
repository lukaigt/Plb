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
  const change10m = getChangeFromAgo(600);

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

  let momentum = 'STABLE';
  if (change1m && change3m) {
    const speed1m = Math.abs(change1m.changePct);
    const speed3m = Math.abs(change3m.changePct / 3);
    if (speed1m > speed3m * 2) momentum = 'ACCELERATING';
    else if (speed1m < speed3m * 0.3) momentum = 'DECELERATING';
  }

  return {
    available: true,
    currentPrice,
    bid: latestBid,
    ask: latestAsk,
    direction,
    momentum,
    change1m: change1m ? { dollars: change1m.change.toFixed(2), percent: change1m.changePct.toFixed(3) } : null,
    change3m: change3m ? { dollars: change3m.change.toFixed(2), percent: change3m.changePct.toFixed(3) } : null,
    change5m: change5m ? { dollars: change5m.change.toFixed(2), percent: change5m.changePct.toFixed(3) } : null,
    change10m: change10m ? { dollars: change10m.change.toFixed(2), percent: change10m.changePct.toFixed(3) } : null,
    recentVolatility: recentVolatility.toFixed(2),
    historyLength: priceHistory.length,
    connected: isConnected
  };
}

function buildPriceText() {
  const ctx = getPriceContext();

  if (!ctx.available) {
    return `REAL BTC PRICE: Not available (${ctx.reason})`;
  }

  let text = `REAL BTC PRICE (Kraken, live):\n`;
  text += `  Current: $${ctx.currentPrice.toLocaleString()}\n`;
  text += `  Direction: ${ctx.direction} | Momentum: ${ctx.momentum}\n`;

  if (ctx.change1m) text += `  1-min change: $${ctx.change1m.dollars} (${ctx.change1m.percent}%)\n`;
  if (ctx.change3m) text += `  3-min change: $${ctx.change3m.dollars} (${ctx.change3m.percent}%)\n`;
  if (ctx.change5m) text += `  5-min change: $${ctx.change5m.dollars} (${ctx.change5m.percent}%)\n`;
  if (ctx.change10m) text += `  10-min change: $${ctx.change10m.dollars} (${ctx.change10m.percent}%)\n`;

  text += `  30s volatility: $${ctx.recentVolatility}`;

  return text;
}

module.exports = {
  connect,
  getLatestPrice,
  getPriceContext,
  buildPriceText
};
