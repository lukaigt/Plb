const logger = require('./logger');

const GAMMA_API = 'https://gamma-api.polymarket.com';

const COINS = ['btc'];
const COIN_NAMES = { btc: 'BTC' };

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

function get15MinSlotTimestamps() {
  const now = new Date();
  const timestamps = [];

  for (let offset = -2; offset <= 2; offset++) {
    const t = new Date(now);
    const totalMinutes = t.getUTCHours() * 60 + t.getUTCMinutes();
    const slotMinutes = Math.floor(totalMinutes / 15) * 15 + offset * 15;

    const slotDate = new Date(t);
    slotDate.setUTCHours(Math.floor(slotMinutes / 60) % 24, slotMinutes % 60, 0, 0);
    if (slotMinutes < 0) slotDate.setUTCDate(slotDate.getUTCDate() - 1);
    if (slotMinutes >= 1440) slotDate.setUTCDate(slotDate.getUTCDate() + 1);

    timestamps.push(Math.floor(slotDate.getTime() / 1000));
  }

  return timestamps;
}

async function scanMarkets() {
  logger.addActivity('scan', { message: 'Scanning for BTC 15-min Up/Down market...' });

  const markets = [];
  const timestamps = get15MinSlotTimestamps();

  const slugsToTry = [];
  for (const coin of COINS) {
    for (const ts of timestamps) {
      slugsToTry.push({ coin, slug: `${coin}-updown-15m-${ts}`, timestamp: ts });
    }
  }

  const fetchPromises = slugsToTry.map(async ({ coin, slug, timestamp }) => {
    try {
      const res = await fetchWithTimeout(`${GAMMA_API}/events?slug=${slug}`);
      if (!res.ok) return null;
      const events = await res.json();
      if (!Array.isArray(events) || events.length === 0) return null;

      const event = events[0];
      if (!event.active || event.closed) return null;

      const market = event.markets?.[0];
      if (!market) return null;

      const endDate = new Date(market.endDate || event.endDate);
      const now = new Date();
      const minutesLeft = (endDate - now) / (1000 * 60);

      if (minutesLeft <= 0) return null;

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
        coin: COIN_NAMES[coin],
        endTime: endDate,
        minutesLeft: Math.round(minutesLeft),
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

  const bestPerCoin = {};
  for (const market of markets) {
    const existing = bestPerCoin[market.coin];
    if (!existing || (market.minutesLeft < existing.minutesLeft && market.minutesLeft > 1)) {
      bestPerCoin[market.coin] = market;
    }
  }

  const finalMarkets = Object.values(bestPerCoin).filter(m => m.minutesLeft >= 3 && m.minutesLeft <= 12);

  logger.addActivity('scan_result', {
    message: finalMarkets.length > 0
      ? `Found BTC market: ${finalMarkets[0].question} (${finalMarkets[0].minutesLeft}min left)`
      : 'No active BTC 15-min market in the 3-12 minute window',
    count: finalMarkets.length
  });

  return finalMarkets;
}

module.exports = { scanMarkets, get15MinSlotTimestamps };
