const { scanLiveSoccerMarkets } = require('./soccerScanner');
const { scanLiveSportsMarkets } = require('./sportsScanner');
const { BondSession, getBondConfig } = require('./bondStrategy');
const { initClient } = require('./trader');
const safety        = require('./safety');
const logger        = require('./logger');
const marketWatcher = require('./marketWatcher');

function isAllSportsMode() {
  const v = (process.env.ALL_SPORTS_ENABLED || '').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

async function scanMarkets(minVolume) {
  if (isAllSportsMode()) {
    return scanLiveSportsMarkets(minVolume);
  }
  return scanLiveSoccerMarkets(minVolume);
}

let isRunning       = false;
let isScanRunning   = false;
let isFastRunning   = false;
let scanInterval    = null;
let fastInterval    = null;
let soccerDailySpent    = 0;
let soccerWinsToday     = 0;
let soccerLossesToday   = 0;
let soccerYieldCollected = 0;
let lastResetDate   = new Date().toDateString();
let lastWatchSummaryAt  = 0;

const activeSessions = {};
// Once a market has been entered (or attempted), never re-enter it this session —
// even if the order failed and the session was cleaned up.
const enteredMarkets = new Set();

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    soccerDailySpent     = 0;
    soccerWinsToday      = 0;
    soccerLossesToday    = 0;
    soccerYieldCollected = 0;
    lastResetDate        = today;
    enteredMarkets.clear(); // new day — allow fresh entries on recurring events
  }
}

function recordSessionOutcome(session) {
  if (session.pnl === null || session.filledAmount <= 0) return;
  if (session.pnl > 0) {
    soccerWinsToday++;
    soccerYieldCollected += session.pnl;
  } else {
    soccerLossesToday++;
  }
}
async function getClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) return null;
  return initClient(key);
}

// ─── POSITION RECOVERY ON STARTUP ───────────────────────────────────────────
// On restart, in-memory sessions are wiped. This scans the CLOB for open
// MATCHED orders and reconstructs BondSessions so the exit engine immediately
// protects any positions that were entered before the restart.
async function recoverOpenPositions() {
  const { buildClobAuthHeaders } = require('./trader');
  const config = getBondConfig();

  try {
    const headers = buildClobAuthHeaders('GET', '/orders');
    if (!headers) {
      logger.addActivity('bot', { message: '[Recovery] No auth headers — skipping position recovery' });
      return;
    }

    // Fetch last 500 matched orders (no status filter — CLOB returns all states)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const url = 'https://clob.polymarket.com/orders?status=MATCHED&next_cursor=&limit=500';
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      logger.addActivity('bot', { message: `[Recovery] CLOB orders fetch failed: ${res.status}` });
      return;
    }

    const data  = await res.json();
    const orders = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);

    if (orders.length === 0) {
      logger.addActivity('bot', { message: '[Recovery] No matched orders found on startup' });
      return;
    }

    // Filter to YES-side orders that still have unresolved tokens
    // Deduplicate by asset_id (YES token) — one session per market
    const seenTokens = new Set();
    const candidates = [];

    for (const order of orders) {
      const tokenId     = order.asset_id || order.assetId || order.token_id;
      const sizeMatched = parseFloat(order.size_matched || order.sizeMatched || 0);
      const outcome     = (order.outcome || order.side || '').toUpperCase();
      const status      = (order.status  || order.orderStatus || '').toUpperCase();

      if (!tokenId)                       continue;
      if (sizeMatched <= 0)               continue;
      if (status !== 'MATCHED')           continue;
      if (outcome !== 'YES' && outcome !== 'BUY') continue;
      if (seenTokens.has(tokenId))        continue;
      seenTokens.add(tokenId);

      candidates.push({
        tokenId,
        filledTokens: sizeMatched,
        entryPrice:   parseFloat(order.price || order.average_price || 0.9),
        filledAmount: parseFloat(order.original_size || order.originalSize || sizeMatched * parseFloat(order.price || 0.9)),
        orderId:      order.id || order.order_id
      });
    }

    if (candidates.length === 0) {
      logger.addActivity('bot', { message: '[Recovery] No open YES positions to recover' });
      return;
    }

    logger.addActivity('bot', {
      message: `[Recovery] Found ${candidates.length} filled YES order(s) — checking markets...`
    });

    let recovered = 0;

    for (const cand of candidates) {
      try {
        // Look up the Gamma market by YES token ID
        const mRes = await fetch(
          `https://gamma-api.polymarket.com/markets?clob_token_ids=${cand.tokenId}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!mRes.ok) continue;

        const markets = await mRes.json();
        const gm = Array.isArray(markets) ? markets[0] : null;
        if (!gm) continue;

        // Skip already resolved markets — no position to protect
        if (gm.resolved === true || gm.hasResolved === true) continue;

        const marketId = gm.id || gm.conditionId || cand.tokenId;

        // Skip if we already have a live session for this market
        if (activeSessions[marketId]) continue;
        // Skip if already in the entered-markets blacklist (entered this session)
        if (enteredMarkets.has(marketId)) continue;

        // Parse token IDs — YES is first
        let yesTokenId = cand.tokenId;
        try {
          const tokens = typeof gm.clobTokenIds === 'string'
            ? JSON.parse(gm.clobTokenIds)
            : (Array.isArray(gm.clobTokenIds) ? gm.clobTokenIds : []);
          if (tokens.length >= 1) yesTokenId = tokens[0];
        } catch {}

        const market = {
          id:          marketId,
          question:    gm.question     || gm.title || 'Recovered position',
          eventTitle:  gm.eventTitle   || gm.groupItemTitle || gm.question?.slice(0, 40) || '',
          conditionId: gm.conditionId  || gm.id,
          yesTokenId,
          negRisk:     gm.negRisk === true || gm.enableNegRisk === true,
          endDate:     gm.endDate      || gm.expirationDate || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
          startDate:   gm.startDate    || null,
          tickSize:    gm.minimumTickSize ? String(gm.minimumTickSize) : '0.01',
        };

        const session            = new BondSession(market, config);
        session.phase            = 'holding';
        session.entryPrice       = cand.entryPrice;
        session.filledTokens     = cand.filledTokens;
        session._remainingTokens = cand.filledTokens;
        session.filledAmount     = cand.filledAmount > 0 ? cand.filledAmount : cand.filledTokens * cand.entryPrice;
        session.orderId          = cand.orderId;
        session.createdAt        = new Date();

        activeSessions[marketId] = session;
        enteredMarkets.add(marketId);

        // Subscribe to live best_bid tracking immediately
        marketWatcher.subscribe(yesTokenId);

        recovered++;
        logger.addActivity('bot', {
          message: `[Recovery] Restored position: "${market.question.slice(0, 55)}" | ${cand.filledTokens.toFixed(4)} tokens @ $${cand.entryPrice.toFixed(3)} | exit engine now active`
        });

      } catch (err) {
        logger.addActivity('bot', {
          message: `[Recovery] Error recovering token ${cand.tokenId.slice(0, 16)}...: ${err.message?.slice(0, 60)}`
        });
      }
    }

    logger.addActivity('bot', {
      message: `[Recovery] Complete — ${recovered} position(s) recovered and protected by exit engine`
    });

  } catch (err) {
    logger.addActivity('bot', {
      message: `[Recovery] Error: ${err.message?.slice(0, 80)}`
    });
  }
}

async function runScan() {
  if (!isRunning) return;
  if (isScanRunning) return; // skip if previous scan still in progress

  const config   = getBondConfig();
  const canTrade = safety.canTrade();
  if (!canTrade.allowed) return; // bail before locking — no async work started

  isScanRunning = true;
  try {
    const markets = await scanMarkets(config.minVolume);

    for (const id of Object.keys(activeSessions)) {
      const session = activeSessions[id];
      if (session.phase === 'done') {
        recordSessionOutcome(session);
        delete activeSessions[id];
        continue;
      }
      const stillLive = markets.find(m => m.id === id);
      if (!stillLive && session.phase === 'watching') {
        delete activeSessions[id];
      }
    }

    const activeHolding = Object.values(activeSessions)
      .filter(s => ['buying', 'holding', 'liquidating', 'redeeming'].includes(s.phase)).length;

    const minElapsedMs = (parseInt(process.env.BOND_MIN_ELAPSED_MINUTES) || 30) * 60 * 1000;
    const now = Date.now();

    for (const market of markets) {
      // Never create a second session for a market we've already acted on
      if (activeSessions[market.id]) continue;
      if (enteredMarkets.has(market.id)) continue;
      if (activeHolding >= config.maxPositions) continue;

      // Skip O/U, spread, and BTTS markets — price collapses instantly on a
      // goal/score change, so stop-loss cannot protect these positions.
      // Controlled by BOND_SKIP_OU env var (default: true).
      if ((process.env.BOND_SKIP_OU || 'true').toLowerCase() !== 'false') {
        const q = market.question.toLowerCase();
        if (
          q.includes('o/u') ||
          q.includes('over/under') ||
          q.includes('btts') ||
          q.includes('both teams to score') ||
          q.includes('spread')
        ) {
          logger.addActivity(isAllSportsMode() ? 'sports_scan' : 'soccer_scan', {
            message: `Skipping spread/O/U market: "${market.question.slice(0, 55)}"`
          });
          continue;
        }
      }

      // Block all esports markets — CS2/Valorant/Mobile Legends/LoL/Dota etc.
      // can move from 97¢ to 0 in a single round/teamfight (seconds), far faster
      // than any 15s poll + stop-loss can react. Never tradeable with this strategy.
      {
        const q = market.question.toLowerCase();
        const et = (market.eventTitle || '').toLowerCase();
        const combined = q + ' ' + et;
        if (
          combined.includes('counter-strike') ||
          combined.includes('cs2') ||
          combined.includes('csgo') ||
          combined.includes('valorant') ||
          combined.includes('mobile legends') ||
          combined.includes('league of legends') ||
          combined.includes('dota') ||
          combined.includes('overwatch') ||
          combined.includes('rocket league') ||
          combined.includes('rainbow six') ||
          combined.includes('starcraft') ||
          combined.includes('hearthstone') ||
          combined.includes('king of glory') ||
          combined.includes('pubg') ||
          combined.includes('fortnite') ||
          combined.includes('esport')
        ) {
          logger.addActivity(isAllSportsMode() ? 'sports_scan' : 'soccer_scan', {
            message: `Skipping esports market: "${market.question.slice(0, 55)}"`
          });
          continue;
        }
      }

      // Skip markets where the game started less than BOND_MIN_ELAPSED_MINUTES ago
      if (market.startDate) {
        const elapsed = now - new Date(market.startDate).getTime();
        if (elapsed < minElapsedMs) {
          const minsElapsed = Math.floor(elapsed / 60000);
          const minsNeeded  = Math.floor(minElapsedMs / 60000);
          logger.addActivity(isAllSportsMode() ? 'sports_scan' : 'soccer_scan', {
            message: `Skipping "${market.question.slice(0, 50)}" — only ${minsElapsed}min into game (need ${minsNeeded}min)`
          });
          continue;
        }
      }

      activeSessions[market.id] = new BondSession(market, config);
    }

  } catch (err) {
    logger.addActivity('bond_error', {
      message: `Soccer scan loop error: ${err.message?.slice(0, 80)}`
    });
  } finally {
    isScanRunning = false;
  }
}

async function runFast() {
  if (!isRunning) return;
  if (isFastRunning) return;
  isFastRunning = true;

  try {
    const config = getBondConfig();
    const client = await getClient();
    let activeCount = Object.values(activeSessions)
      .filter(s => ['buying', 'holding', 'liquidating', 'redeeming'].includes(s.phase)).length;

    for (const session of Object.values(activeSessions)) {
      try {
        if (session.phase === 'done') {
          recordSessionOutcome(session);
          delete activeSessions[session.id];
          continue;
        }

        if (session.phase === 'watching') {
          await session.pollPrice();

          // Log if this market is near or at the threshold
          if (session.lastMid !== null && session.lastMid >= config.threshold - 0.03) {
            logger.addActivity(isAllSportsMode() ? 'sports_scan' : 'soccer_scan', {
              message: `NEAR THRESHOLD: "${session.market.question.slice(0, 55)}" YES=${session.lastMid.toFixed(3)} (threshold=${config.threshold})`
            });
          }
          if (session.shouldEnter()) {
            const canTrade = safety.canTrade();
            if (!canTrade.allowed) continue;
            if (activeCount < config.maxPositions) {
              const entered = await session.enter(client);
              if (entered) {
                // Only blacklist the market after a confirmed successful entry.
                // If the order failed (e.g. allowance/balance error), leave the
                // market unblacklisted so it can be retried on the next scan.
                enteredMarkets.add(session.id);
                activeCount++;
              }
            }
          }

        } else if (session.phase === 'buying') {
          await session.checkFill(client);
          await session.checkResolutionWhileBuying();

        } else if (session.phase === 'holding') {
          await session.pollPrice();
          await session.checkExitTriggers();
          await session.checkResolution();

        } else if (session.phase === 'liquidating') {
          // Background liquidation loop is running — just keep best_bid fresh
          // and add a hard timeout in case the loop stalls
          await session.pollPrice();
          if (session._liquidationStartedAt &&
              Date.now() - session._liquidationStartedAt > 10 * 60 * 1000 &&
              !session._liquidating) {
            logger.addActivity('bond_error', {
              message: `[EXIT] liquidation timeout (10min) — forcing done for "${session.market?.question?.slice(0, 40)}"`
            });
            marketWatcher.unsubscribe(session.market.yesTokenId);
            session.phase = 'done';
          }

        } else if (session.phase === 'redeeming') {
          await session.tryRedeem();
        }

      } catch (err) {
        logger.addActivity('bond_error', {
          message: `Fast loop error (${session.market?.question?.slice(0, 40)}): ${err.message?.slice(0, 60)}`
        });
      }
    }
    // Periodic summary every 2 minutes so the user can see the bot is actively watching
    const now = Date.now();
    if (now - lastWatchSummaryAt > 2 * 60 * 1000) {
      lastWatchSummaryAt = now;
      const sessions = Object.values(activeSessions);
      const watching  = sessions.filter(s => s.phase === 'watching');
      const active    = sessions.filter(s => ['buying','holding','liquidating','redeeming'].includes(s.phase));

      // Find top 5 markets by YES price
      const byPrice = watching
        .filter(s => s.lastMid !== null)
        .sort((a, b) => b.lastMid - a.lastMid)
        .slice(0, 5);

      const topStr = byPrice.length > 0
        ? byPrice.map(s => `${s.lastMid.toFixed(3)} ${s.market.question.slice(0, 30)}`).join(' | ')
        : 'prices not yet fetched';

      const scanType = isAllSportsMode() ? 'sports_scan' : 'soccer_scan';
      logger.addActivity(scanType, {
        message: `Watching ${watching.length} markets | ${active.length} active position(s) | Top YES prices: ${topStr}`
      });
    }

  } finally {
    isFastRunning = false;
  }
}

function start() {
  if (isRunning) return;
  isRunning = true;

  // Connect public market WebSocket (direct VPS, no proxy) for real-time best_bid tracking
  marketWatcher.connect();

  // Recover any open positions from previous sessions (10s delay — let CLOB client init)
  setTimeout(() => recoverOpenPositions().catch(() => {}), 10 * 1000);

  const config     = getBondConfig();
  const minElapsed = parseInt(process.env.BOND_MIN_ELAPSED_MINUTES) || 30;
  const allSports  = isAllSportsMode();
  logger.addActivity('bot', {
    message: [
      allSports
        ? 'Sports Bond Bot started — monitoring ALL live sports markets (soccer, NFL, NBA, MLB, NHL, tennis, golf, UFC, cricket, rugby, F1 + more)'
        : 'Soccer Bond Bot started — monitoring live soccer markets',
      `  Threshold:      ${(config.threshold * 100).toFixed(0)}¢ (buy when YES token reaches this)`,
      `  Order size:     $${config.orderSize} per trade`,
      `  Max positions:  ${config.maxPositions} concurrent open bets`,
      `  Min volume:     $${config.minVolume.toLocaleString()} 24hr volume`,
      `  Min elapsed:    ${minElapsed}min into game before entry`,
      `  Hard stop-loss: ${((parseFloat(process.env.BOND_STOP_LOSS) || 0.20) * 100).toFixed(0)}% drop triggers FAK exit`,
      `  Trailing stop:  ${((config.trailingStop) * 100).toFixed(0)}¢ drop from peak best_bid triggers FAK exit`,
      `  Spread exit:    if spread > ${(config.maxSpread * 100).toFixed(0)}¢ (broken book) triggers FAK exit`,
      `  Exit engine:    FAK orders | ${config.fakRetries} retries | ${config.exitRetrySecs}s between attempts`,
      `  Max threshold:  ${(config.maxThreshold * 100).toFixed(0)}¢ ceiling (won't enter above this)`,
      `  O/U filter:     ${(process.env.BOND_SKIP_OU || 'true').toLowerCase() !== 'false' ? 'ON — skipping O/U, BTTS, spread, esports markets' : 'OFF'}`,
      `  Loss limit:     $${process.env.DAILY_LOSS_LIMIT || 30} daily (bot stops if hit)`,
      `  Scan interval:  every 2 min | price poll: every 15s | best_bid: real-time WebSocket`,
      `  Mode:           ${allSports ? 'ALL_SPORTS' : 'SOCCER_ONLY'}`
    ].join('\n')
  });

  runScan();
  scanInterval = setInterval(runScan, 2 * 60 * 1000);
  fastInterval = setInterval(runFast, 15 * 1000);
}

function stop() {
  isRunning = false;
  if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
  if (fastInterval) { clearInterval(fastInterval); fastInterval = null; }
  marketWatcher.disconnect();
  logger.addActivity('bot', { message: 'Soccer Bond Bot stopped' });
}

function getPositions() {
  return Object.values(activeSessions).map(s => s.getStatus());
}

function getSoccerRunning() { return isRunning; }

function getSoccerStats() {
  resetDailyIfNeeded();
  const config          = getBondConfig();
  const positions       = Object.values(activeSessions);
  const activePositions = positions.filter(s => ['buying', 'holding', 'liquidating', 'redeeming'].includes(s.phase)).length;
  const watchingCount   = positions.filter(s => s.phase === 'watching').length;
  const totalResolved   = soccerWinsToday + soccerLossesToday;
  const winRate         = totalResolved > 0
    ? parseFloat(((soccerWinsToday / totalResolved) * 100).toFixed(1))
    : null;

  return {
    isRunning,
    activePositions,
    watchingCount,
    winsToday:      soccerWinsToday,
    lossesToday:    soccerLossesToday,
    yieldCollected: parseFloat(soccerYieldCollected.toFixed(3)),
    winRate
  };
}

module.exports = { start, stop, getPositions, getSoccerRunning, getSoccerStats };
