const logger = require('./logger');

const GAMMA_API       = 'https://gamma-api.polymarket.com';
const TAG_SLUGS       = ['soccer', 'football'];
const WINDOW_HOURS    = 12;

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

async function fetchTagEvents(tagSlug) {
  try {
    const url = `${GAMMA_API}/events?tag_slug=${tagSlug}&active=true&closed=false&limit=100&order=volume24hr&ascending=false`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.addActivity('soccer_scan_error', { message: `Gamma API error (${tagSlug}): ${err.message?.slice(0, 60)}` });
    return [];
  }
}

function isInWindow(endDateStr) {
  if (!endDateStr) return false;
  const end  = new Date(endDateStr);
  const now  = new Date();
  const maxFutureMs = WINDOW_HOURS * 60 * 60 * 1000;
  const maxPastMs   = 3 * 60 * 60 * 1000;
  const diff = end - now;
  return diff >= -maxPastMs && diff <= maxFutureMs;
}

async function scanLiveSoccerMarkets(minVolume = 5000) {
  const seenIds    = new Set();
  const liveMarkets = [];

  const allEvents = [];
  for (const tag of TAG_SLUGS) {
    const events = await fetchTagEvents(tag);
    allEvents.push(...events);
  }

  for (const event of allEvents) {
    if (!event.active || event.closed) continue;
    if (!isInWindow(event.endDate)) continue;
    if (!Array.isArray(event.markets)) continue;

    for (const market of event.markets) {
      const marketKey = market.conditionId || market.id;
      if (!marketKey || seenIds.has(marketKey)) continue;
      if (!market.active || market.closed) continue;
      if (market.acceptingOrders === false) continue;

      let tokenIds = [];
      try {
        tokenIds = typeof market.clobTokenIds === 'string'
          ? JSON.parse(market.clobTokenIds)
          : (Array.isArray(market.clobTokenIds) ? market.clobTokenIds : []);
      } catch {}
      if (tokenIds.length < 2) continue;

      let outcomes = ['Yes', 'No'];
      try {
        const raw = typeof market.outcomes === 'string'
          ? JSON.parse(market.outcomes)
          : (Array.isArray(market.outcomes) ? market.outcomes : []);
        if (raw.length >= 2) outcomes = raw;
      } catch {}

      const vol24h = parseFloat(market.volume24hr || market.volumeNum || 0);
      const volTotal = parseFloat(market.volume || 0);
      if (vol24h < minVolume && volTotal < minVolume) continue;

      seenIds.add(marketKey);
      liveMarkets.push({
        id:          marketKey,
        conditionId: market.conditionId || null,
        question:    market.question || event.title,
        eventTitle:  event.title || market.question,
        yesTokenId:  tokenIds[0],
        noTokenId:   tokenIds[1],
        yesOutcome:  outcomes[0] || 'Yes',
        endDate:     market.endDate || event.endDate,
        volume24hr:  vol24h,
        negRisk:     market.negRisk === true || market.negRisk === 'true' || event.negRisk === true,
        tickSize:    market.orderPriceMinTickSize || market.minimumTickSize || '0.01'
      });
    }
  }

  if (liveMarkets.length > 0) {
    logger.addActivity('soccer_scan', {
      message: `Found ${liveMarkets.length} live/imminent soccer market(s) in window`
    });
  }

  return liveMarkets;
}

module.exports = { scanLiveSoccerMarkets };
