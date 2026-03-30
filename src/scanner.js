const logger = require('./logger');

const GAMMA_API = 'https://gamma-api.polymarket.com';

const MARKETS_CONFIG = [
  { coin: 'BTC', type: '15m', slugPrefix: 'btc-updown-15m', intervalSeconds: 900 }
];

async function fetchWithTimeout(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function getSlotTimestamps(intervalSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const currentSlot = Math.floor(now / intervalSeconds) * intervalSeconds;
  return [-1, 0, 1, 2].map(offset => currentSlot + offset * intervalSeconds);
}

async function scanSingleMarket(config) {
  const { coin, type, slugPrefix, intervalSeconds } = config;
  const timestamps = getSlotTimestamps(intervalSeconds);

  const results = await Promise.all(timestamps.map(async (timestamp) => {
    const slug = `${slugPrefix}-${timestamp}`;
    try {
      const res = await fetchWithTimeout(`${GAMMA_API}/events?slug=${slug}`);
      if (!res.ok) return null;
      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) return null;

      const event = events[0];
      if (!event.active || event.closed) return null;

      const market = event.markets?.[0];
      if (!market) return null;

      const windowEndMs = (timestamp + intervalSeconds) * 1000;
      const secondsLeft = Math.max(0, (windowEndMs - Date.now()) / 1000);
      if (secondsLeft <= 0 || secondsLeft > intervalSeconds) return null;

      let tokenIds = [];
      if (market.clobTokenIds) {
        tokenIds = typeof market.clobTokenIds === 'string'
          ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
      }
      if (tokenIds.length < 2) return null;

      let outcomes = ['Up', 'Down'];
      if (market.outcomes) {
        outcomes = typeof market.outcomes === 'string'
          ? JSON.parse(market.outcomes) : market.outcomes;
      }

      const upTokenId   = tokenIds[0];
      const downTokenId = tokenIds[1];

      return {
        id: market.conditionId || market.id,
        conditionId: market.conditionId || null,
        question: market.question || event.title,
        coin,
        type,
        intervalSeconds,
        endTime: new Date(windowEndMs),
        windowStartTs: timestamp,
        windowEndTs: timestamp + intervalSeconds,
        secondsLeft: Math.round(secondsLeft),
        upTokenId,
        downTokenId,
        upOutcome: outcomes[0] || 'Up',
        downOutcome: outcomes[1] || 'Down',
        negRisk: market.negRisk === true || market.negRisk === 'true' || event.negRisk === true,
        tickSize: market.minimum_tick_size || market.minimumTickSize || '0.01',
        liquidity: parseFloat(market.liquidity || event.liquidity || 0),
        volume: parseFloat(market.volume || event.volume || 0),
        slug: market.slug || slug
      };
    } catch {
      return null;
    }
  }));

  const found = results.filter(Boolean);
  found.sort((a, b) => a.secondsLeft - b.secondsLeft);
  return found[0] || null;
}

async function scanAllMarkets() {
  const results = await Promise.all(MARKETS_CONFIG.map(c => scanSingleMarket(c)));
  const active = results.filter(Boolean);

  if (active.length > 0) {
    const summary = active.map(m => `${m.coin}-${m.type}(${m.secondsLeft}s)`).join(', ');
    logger.addActivity('scan', { message: `Found ${active.length} active market(s): ${summary}` });
  } else {
    logger.addActivity('scan', { message: 'No active BTC markets found' });
  }

  return active;
}

module.exports = { scanAllMarkets, MARKETS_CONFIG };
