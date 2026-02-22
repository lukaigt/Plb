const logger = require('./logger');

const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function get5MinSlotTimestamps() {
  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const slotSeconds = 300;
  const currentSlot = Math.floor(nowUnix / slotSeconds) * slotSeconds;
  const timestamps = [];

  for (let offset = -2; offset <= 3; offset++) {
    timestamps.push(currentSlot + offset * slotSeconds);
  }

  return timestamps;
}

function getSecondsLeftInWindow(endTimestamp) {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, endTimestamp - now);
}

async function scanMarkets() {
  logger.addActivity('scan', { message: 'Scanning for BTC 5-min Up/Down market...' });

  const markets = [];
  const timestamps = get5MinSlotTimestamps();

  const slugsToTry = timestamps.map(ts => ({
    slug: `btc-updown-5m-${ts}`,
    timestamp: ts
  }));

  const fetchPromises = slugsToTry.map(async ({ slug, timestamp }) => {
    try {
      const res = await fetchWithTimeout(`${GAMMA_API}/events?slug=${slug}`);
      if (!res.ok) return null;
      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) return null;

      const event = events[0];
      if (!event.active || event.closed) return null;

      const market = event.markets?.[0];
      if (!market) return null;

      const windowEnd = (timestamp + 300) * 1000;
      const now = Date.now();
      const secondsLeft = Math.max(0, (windowEnd - now) / 1000);

      if (secondsLeft <= 0) return null;

      let tokenIds = [];
      if (market.clobTokenIds) {
        tokenIds = typeof market.clobTokenIds === 'string'
          ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
      }

      let outcomes = ['Up', 'Down'];
      if (market.outcomes) {
        outcomes = typeof market.outcomes === 'string'
          ? JSON.parse(market.outcomes) : market.outcomes;
      }

      let outcomePrices = null;
      if (market.outcomePrices) {
        outcomePrices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      }

      if (tokenIds.length < 2) return null;

      const tokens = tokenIds.map((id, i) => ({
        token_id: id,
        outcome: outcomes[i] || (i === 0 ? 'Up' : 'Down'),
        price: outcomePrices ? parseFloat(outcomePrices[i]) : null
      }));

      return {
        id: market.conditionId || market.id,
        question: market.question || event.title,
        coin: 'BTC',
        endTime: new Date(windowEnd),
        windowStartTs: timestamp,
        windowEndTs: timestamp + 300,
        secondsLeft: Math.round(secondsLeft),
        tokens,
        outcomePrices,
        slug: market.slug || slug,
        description: market.description || event.description || '',
        liquidity: parseFloat(market.liquidity || event.liquidity || 0),
        volume: parseFloat(market.volume || event.volume || 0),
        negRisk: market.negRisk === true || market.negRisk === 'true' || event.negRisk === true,
        tickSize: market.minimum_tick_size || market.minimumTickSize || '0.01',
        active: true
      };
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(fetchPromises);
  for (const result of results) {
    if (result) markets.push(result);
  }

  const activeMarkets = markets
    .filter(m => m.secondsLeft > 0 && m.secondsLeft <= 300)
    .sort((a, b) => a.secondsLeft - b.secondsLeft);

  const best = activeMarkets[0] || null;

  logger.addActivity('scan_result', {
    message: best
      ? `Found 5-min market: ${best.question} (${best.secondsLeft}s left)`
      : 'No active BTC 5-min market found',
    count: activeMarkets.length
  });

  return best;
}

module.exports = { scanMarkets, get5MinSlotTimestamps };
