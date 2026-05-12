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
