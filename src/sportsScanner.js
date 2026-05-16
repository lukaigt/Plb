const logger = require('./logger');

const GAMMA_API  = 'https://gamma-api.polymarket.com';
const PAGE_LIMIT = 100;
const MAX_PAGES  = 5;

// All Polymarket sports tag slugs.
// Duplicates across slugs are deduplicated by conditionId before returning.
const SPORTS_TAG_SLUGS = [
  'soccer', 'football',
  'nfl', 'nba', 'mlb', 'nhl',
  'basketball', 'baseball', 'hockey',
  'tennis', 'golf',
  'ufc', 'mma', 'boxing',
  'cricket', 'rugby',
  'formula-1', 'f1'
  // esports removed — CS2/Valorant/Mobile Legends/LoL markets move too fast
  // for stop-loss to protect (97¢ → 0 in one teamfight/round)
];

// Maximum minutes since kickoff/start — generous upper bound to cover long events
// (NFL ~210 min, tennis can run 3+ hours). Scanner checks acceptingOrders too.
const MAX_ELAPSED_MINUTES = 300;

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
      logger.addActivity('sports_scan_error', {
        message: `Gamma API error (${tagSlug} page ${page + 1}): ${err.message?.slice(0, 60)}`
      });
      break;
    }
  }

  return allEvents;
}

async function scanLiveSportsMarkets(minVolume = 500) {
  const seenEventIds = new Set();
  const allEvents    = [];

  for (const tag of SPORTS_TAG_SLUGS) {
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

  const seenMarketIds = new Set();
  const liveMarkets   = [];
  let cntExpired      = 0;
  let cntLowVol       = 0;
  let cntNoAccept     = 0;
  let cntPreStart     = 0;

  for (const event of allEvents) {
    if (!event.active || event.closed) continue;
    if (!Array.isArray(event.markets)) continue;

    for (const market of event.markets) {
      const marketKey = market.conditionId || market.id;
      if (!marketKey || seenMarketIds.has(marketKey)) continue;
      if (!market.active || market.closed) continue;
      if (market.acceptingOrders === false) { cntNoAccept++; continue; }

      // Resolve the game/event start time.
      // gameStartTime is the actual kickoff/tip-off; startTime on event is fallback.
      const startRaw = market.gameStartTime || event.startTime || null;
      if (!startRaw) {
        cntPreStart++;
        continue;
      }
      const startStr     = String(startRaw).replace(' ', 'T').replace(/\+00$/, '+00:00');
      const startTime    = new Date(startStr);
      if (isNaN(startTime.getTime())) { cntPreStart++; continue; }
      const minutesElapsed = (now - startTime) / 60000;

      if (minutesElapsed < 0) {
        // Event hasn't started yet — not live
        cntPreStart++;
        continue;
      }
      if (minutesElapsed > MAX_ELAPSED_MINUTES) {
        // Started more than MAX_ELAPSED_MINUTES ago — almost certainly finished
        cntExpired++;
        continue;
      }

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
        id:              marketKey,
        conditionId:     market.conditionId || null,
        question:        market.question || event.title,
        eventTitle:      event.title || market.question,
        yesTokenId:      tokenIds[0],
        noTokenId:       tokenIds[1],
        yesOutcome:      outcomes[0] || 'Yes',
        startDate:       startTime.toISOString(),
        endDate:         market.endDate || event.endDate,
        volume24hr:      vol24h,
        negRisk:         market.negRisk === true || market.negRisk === 'true' || event.negRisk === true,
        tickSize:        market.orderPriceMinTickSize || market.minimumTickSize || '0.01',
        marketCreatedAt: market.createdAt || null
      });
    }
  }

  logger.addActivity('sports_scan', {
    message: `Sports scan: ${allEvents.length} events → ${liveMarkets.length} live market(s) | skipped: ${cntPreStart} pre-start, ${cntExpired} expired, ${cntLowVol} low-vol, ${cntNoAccept} not-accepting-orders`
  });

  return liveMarkets;
}

module.exports = { scanLiveSportsMarkets, SPORTS_TAG_SLUGS };
