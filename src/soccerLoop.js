const { scanLiveSoccerMarkets } = require('./soccerScanner');
const { scanLiveSportsMarkets, SPORTS_TAG_SLUGS } = require('./sportsScanner');
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
// Uses the Polymarket Data API (NOT CLOB order history) to find actual token
// holdings in the wallet. This is the authoritative source — it reflects the
// real on-chain ERC-1155 balance, not an approximation from order history.
//
// Wallet used: EOA (0xe82dEec5...) — the address that actually holds the
// ERC-1155 conditional tokens after fills. The Data API returns positions
// keyed by proxyWallet which maps to the EOA for this bot setup.
async function recoverOpenPositions() {
  const { getEoaAddress } = require('./trader');
  const config = getBondConfig();

  try {
    // getEoaAddress() is set by initClient() which is async — may not be ready yet
    // at startup. Fall back to RELAYER_API_KEY_ADDRESS env var (same EOA, always available).
    const eoaAddress = getEoaAddress()
      || process.env.RELAYER_API_KEY_ADDRESS
      || null;

    if (!eoaAddress) {
      logger.addActivity('bot', { message: '[Recovery] No EOA address available (RELAYER_API_KEY_ADDRESS not set?) — skipping. Set it in .env and restart.' });
      return;
    }

    logger.addActivity('bot', {
      message: `[Recovery] Querying Data API for wallet holdings: ${eoaAddress.slice(0, 10)}...`
    });

    // Data API returns ACTUAL wallet token balances — the source of truth.
    // sizeThreshold=0.1 filters dust. outcomeIndex=0 = YES side.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const url = `https://data-api.polymarket.com/positions?user=${eoaAddress}&sizeThreshold=0.1`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      logger.addActivity('bot', { message: `[Recovery] Data API error ${res.status} — cannot recover positions` });
      return;
    }

    const positions = await res.json();
    if (!Array.isArray(positions) || positions.length === 0) {
      logger.addActivity('bot', { message: '[Recovery] No open positions in wallet — nothing to recover' });
      return;
    }

    // YES side = outcomeIndex 0. Skip already-redeemable (resolved) positions.
    const candidates = positions.filter(p =>
      parseFloat(p.size) > 0.01 &&
      p.redeemable !== true &&
      (p.outcomeIndex === 0 || p.outcomeIndex === '0')
    );

    logger.addActivity('bot', {
      message: `[Recovery] Data API: ${positions.length} total position(s), ${candidates.length} YES-side unresolved — rebuilding sessions...`
    });

    if (candidates.length === 0) return;

    const POSITION_PHASES = new Set(['holding', 'liquidating', 'redeeming']);
    let recovered = 0;

    for (const pos of candidates) {
      try {
        const tokenId    = String(pos.asset);
        const condId     = pos.conditionId  || null;
        const size       = parseFloat(pos.size);
        // avgPrice is the true average cost basis — no more guessing
        const entryPrice = parseFloat(pos.avgPrice) || 0.95;
        const curPrice   = parseFloat(pos.curPrice)  || null;

        if (!tokenId || size <= 0.01) continue;

        // Canonical session key: conditionId preferred (matches scanner keying)
        const marketId = condId || tokenId;

        // Skip if already tracked in a position phase by canonical key
        const existing = activeSessions[marketId];
        if (existing && POSITION_PHASES.has(existing.phase)) {
          logger.addActivity('bot', {
            message: `[Recovery] Already tracked: "${(pos.title || '').slice(0, 50)}" (${existing.phase})`
          });
          continue;
        }

        // Secondary guard: same token tracked under a different key
        const tokenAlreadyHeld = Object.values(activeSessions)
          .some(s => s.market?.yesTokenId === tokenId && POSITION_PHASES.has(s.phase));
        if (tokenAlreadyHeld) continue;

        // STRICT FILTER: only attach if Gamma confirms this is a live, active sports market.
        // Holdings != bot positions. We cross-check every recovered token against Gamma metadata
        // and reject anything that isn't on the supported sports list (SPORTS_TAG_SLUGS).
        let tickSize  = '0.01';
        let negRisk   = pos.negativeRisk === true;
        let question  = pos.title || 'Recovered position';
        let endDate   = pos.endDate || null;
        let startDate = null;

        if (!condId) {
          logger.addActivity('bot', {
            message: `[RECOVERY] skipped tokenId=${tokenId.slice(0, 14)}… reason=unsupported_market (no conditionId)`
          });
          continue;
        }

        let gm = null;
        try {
          const gmRes = await fetch(
            `https://gamma-api.polymarket.com/markets?conditionId=${condId}`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (gmRes.ok) gm = (await gmRes.json())[0] || null;
        } catch {}

        if (!gm) {
          logger.addActivity('bot', {
            message: `[RECOVERY] skipped tokenId=${tokenId.slice(0, 14)}… reason=unsupported_market (gamma lookup failed)`
          });
          continue;
        }

        if (gm.closed === true || gm.resolved === true || gm.hasResolved === true || gm.active === false) {
          logger.addActivity('bot', {
            message: `[RECOVERY] skipped tokenId=${tokenId.slice(0, 14)}… reason=resolved ("${(gm.question || question).slice(0, 40)}")`
          });
          continue;
        }

        // Sports validation: collect every tag slug attached to this market or its parent event(s)
        const tagSlugs = new Set();
        const collect = (arr) => {
          if (!Array.isArray(arr)) return;
          for (const t of arr) {
            const slug = (t?.slug || t?.label || '').toLowerCase();
            if (slug) tagSlugs.add(slug);
          }
        };
        collect(gm.tags);
        if (Array.isArray(gm.events)) {
          for (const ev of gm.events) collect(ev.tags);
        }

        const sportsSet = new Set(SPORTS_TAG_SLUGS);
        const matchedSport = [...tagSlugs].find(s => sportsSet.has(s));

        if (!matchedSport) {
          logger.addActivity('bot', {
            message: `[RECOVERY] skipped tokenId=${tokenId.slice(0, 14)}… reason=not_sports ("${(gm.question || question).slice(0, 40)}" tags=[${[...tagSlugs].slice(0, 4).join(',') || 'none'}])`
          });
          continue;
        }

        tickSize  = gm.minimumTickSize  ? String(gm.minimumTickSize) : (gm.orderPriceMinTickSize ? String(gm.orderPriceMinTickSize) : '0.01');
        negRisk   = negRisk || gm.negRisk === true || gm.enableNegRisk === true;
        question  = gm.question  || question;
        endDate   = gm.endDate   || endDate || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
        startDate = gm.startDate || null;

        const market = {
          id:          marketId,
          question,
          eventTitle:  question.slice(0, 40),
          conditionId: condId,
          yesTokenId:  tokenId,
          negRisk,
          endDate,
          startDate,
          tickSize,
        };

        const session            = new BondSession(market, config);
        session.phase            = 'holding';
        session.entryPrice       = entryPrice;
        session.filledTokens     = size;
        session._remainingTokens = size;
        session.filledAmount     = parseFloat((size * entryPrice).toFixed(4));
        session.orderId          = null;
        session.createdAt        = new Date();
        if (curPrice !== null) session.lastMid = curPrice;

        // Upgrade a stale watching/buying session that doesn't know about the fill
        if (existing) {
          logger.addActivity('bot', {
            message: `[Recovery] Upgrading "${question.slice(0, 50)}" from ${existing.phase} → holding`
          });
        }

        activeSessions[marketId] = session;
        enteredMarkets.add(marketId);
        marketWatcher.subscribe(tokenId);

        recovered++;
        logger.addActivity('bot', {
          message: `[RECOVERY] attached tokenId=${tokenId.slice(0, 14)}… reason=live_sports_position sport=${matchedSport} "${question.slice(0, 48)}" size=${size.toFixed(4)} avg=$${entryPrice.toFixed(3)} cur=$${curPrice?.toFixed(3) ?? '--'}`
        });

      } catch (err) {
        logger.addActivity('bot', {
          message: `[Recovery] Error on ${pos.title?.slice(0, 30) || pos.asset?.slice(0, 16)}: ${err.message?.slice(0, 60)}`
        });
      }
    }

    logger.addActivity('bot', {
      message: `[Recovery] Complete — ${recovered}/${candidates.length} recovered | exit engine protecting all positions`
    });

  } catch (err) {
    logger.addActivity('bot', {
      message: `[Recovery] Fatal error: ${err.message?.slice(0, 80)}`
    });
  }
}

async function runScan() {
  if (!isRunning) return;
  if (isScanRunning) return; // skip if previous scan still in progress

  const config   = getBondConfig();
  const canTrade = safety.canTrade();
  if (!canTrade.allowed) {
    const s = safety.getStatus();
    logger.addActivity('safety_block', {
      message: `[SCAN] New entries blocked — ${canTrade.reason} | losses: ${s.dailyLossCount}/${s.maxDailyLosses} | $${s.dailyLoss}/$${s.dailyLossLimit} | Use "Reset Counters" on dashboard to resume`
    });
    return;
  }

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
            if (!canTrade.allowed) {
              const s = safety.getStatus();
              logger.addActivity('safety_block', {
                message: `[BLOCKED] "${session.market.question.slice(0, 50)}" YES=${session.lastMid?.toFixed(3)} — ${canTrade.reason} | losing trades: ${s.dailyLossCount}/${s.maxDailyLosses} | $${s.dailyLoss} lost today`
              });
              continue;
            }
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

  // Recover any open positions from previous sessions.
  // 30s delay — gives initClient() time to complete and set eoaAddress.
  // Falls back to RELAYER_API_KEY_ADDRESS env var so it works even if client is still initialising.
  setTimeout(() => recoverOpenPositions().catch(() => {}), 30 * 1000);

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
      `  Loss limit:     $${process.env.DAILY_LOSS_LIMIT || 50} daily OR ${process.env.MAX_DAILY_LOSSES || 50} losing trades (whichever hits first)`,
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

module.exports = { start, stop, getPositions, getSoccerRunning, getSoccerStats, recoverOpenPositions };
