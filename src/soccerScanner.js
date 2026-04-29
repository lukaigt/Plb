const logger = require('./logger');

const GAMMA_API    = 'https://gamma-api.polymarket.com';
const TAG_SLUGS    = ['soccer', 'football'];
const WINDOW_HOURS = 3;
const PAGE_LIMIT   = 100;
const MAX_PAGES    = 5;

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
  const allEvents = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const url = `${GAMMA_API}/events?tag_slug=${tagSlug}&active=true&closed=false&limit=${PAGE_LIMIT}&offset=${offset}&order=volume24hr&ascending=false`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) break;
      const data = await res.json();
      const batch = Array.isArray(data) ? data : [];
      allEvents.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
      offset += PAGE_LIMIT;
    } catch (err) {
      logger.addActivity('soccer_scan_error', { message: `Gamma API error (${tagSlug} page ${page + 1}): ${err.message?.slice(0, 60)}` });
      break;
    }
  }

  return allEvents;
}

async function scanLiveSoccerMarkets(minVolume = 500) {
  const seenEventIds = new Set();
  const allEvents    = [];

  for (const tag of TAG_SLUGS) {
    const events = await fetchTagEvents(tag);
    for (const e of events) {
      const key = e.id || e.slug || JSON.stringify(e);
      if (!seenEventIds.has(key)) {
        seenEventIds.add(key);
        allEvents.push(e);
      }
    }
  }

  const now = new Date();

  const seenMarketIds  = new Set();
  const liveMarkets    = [];
  let   cntFuture      = 0;
  let   cntExpired     = 0;
  let   cntLowVol      = 0;
  let   cntNoAccept    = 0;
  let   cntPreKickoff  = 0;

  for (const event of allEvents) {
    if (!event.active || event.closed) continue;
    if (!Array.isArray(event.markets)) continue;

    const endDiff = event.endDate ? (new Date(event.endDate) - now) : null;

    if (endDiff !== null && endDiff > WINDOW_HOURS * 60 * 60 * 1000) {
      cntFuture++;
      continue;
    }
    if (endDiff !== null && endDiff < -3 * 60 * 60 * 1000) {
      cntExpired++;
      continue;
    }

    // Require a startDate and require the game to have already kicked off
    if (!event.startDate) {
      cntPreKickoff++;
      continue;
    }
    const kickoff = new Date(event.startDate);
    if (kickoff > now) {
      cntPreKickoff++;
      continue;
    }

    for (const market of event.markets) {
      const marketKey = market.conditionId || market.id;
      if (!marketKey || seenMarketIds.has(marketKey)) continue;
      if (!market.active || market.closed) continue;
      if (market.acceptingOrders === false) { cntNoAccept++; continue; }

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

      const vol24h   = parseFloat(market.volume24hr || market.volumeNum || 0);
      const volTotal = parseFloat(market.volume || 0);
      if (vol24h < minVolume && volTotal < minVolume) { cntLowVol++; continue; }

      seenMarketIds.add(marketKey);
      liveMarkets.push({
        id:          marketKey,
        conditionId: market.conditionId || null,
        question:    market.question || event.title,
        eventTitle:  event.title || market.question,
        yesTokenId:  tokenIds[0],
        noTokenId:   tokenIds[1],
        yesOutcome:  outcomes[0] || 'Yes',
        startDate:   event.startDate || market.startDate || null,
        endDate:     market.endDate || event.endDate,
        volume24hr:  vol24h,
        negRisk:     market.negRisk === true || market.negRisk === 'true' || event.negRisk === true,
        tickSize:    market.orderPriceMinTickSize || market.minimumTickSize || '0.01'
      });
    }
  }

  logger.addActivity('soccer_scan', {
    message: `Scan: ${allEvents.length} events fetched → ${liveMarkets.length} live market(s) found | skipped: ${cntFuture} future, ${cntExpired} expired, ${cntPreKickoff} pre-kickoff, ${cntLowVol} low-vol, ${cntNoAccept} not-accepting-orders`
  });

  return liveMarkets;
}

module.exports = { scanLiveSoccerMarkets };
