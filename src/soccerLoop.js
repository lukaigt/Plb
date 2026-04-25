const { scanLiveSoccerMarkets } = require('./soccerScanner');
const { BondSession, getBondConfig } = require('./bondStrategy');
const { initClient } = require('./trader');
const safety = require('./safety');
const logger = require('./logger');

let isRunning       = false;
let scanInterval    = null;
let fastInterval    = null;
let soccerDailySpent    = 0;
let soccerWinsToday     = 0;
let soccerLossesToday   = 0;
let soccerYieldCollected = 0;
let lastResetDate   = new Date().toDateString();

const activeSessions = {};

function resetDailyIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    soccerDailySpent     = 0;
    soccerWinsToday      = 0;
    soccerLossesToday    = 0;
    soccerYieldCollected = 0;
    lastResetDate        = today;
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

  const config   = getBondConfig();
  const canTrade = safety.canTrade();
  if (!canTrade.allowed) return;

  try {
    const markets = await scanLiveSoccerMarkets(config.minVolume);

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
      .filter(s => ['buying', 'holding', 'redeeming'].includes(s.phase)).length;

    for (const market of markets) {
      if (activeSessions[market.id]) continue;
      if (activeHolding >= config.maxPositions) continue;

      activeSessions[market.id] = new BondSession(market, config);
    }

  } catch (err) {
    logger.addActivity('bond_error', {
      message: `Soccer scan loop error: ${err.message?.slice(0, 80)}`
    });
  }
}

async function runFast() {
  if (!isRunning) return;

  const config = getBondConfig();
  const client = await getClient();

  let activeCount = Object.values(activeSessions)
    .filter(s => ['buying', 'holding', 'redeeming'].includes(s.phase)).length;

  for (const session of Object.values(activeSessions)) {
    try {
      if (session.phase === 'done') {
        recordSessionOutcome(session);
        delete activeSessions[session.id];
        continue;
      }

      if (session.phase === 'watching') {
        await session.pollPrice();
        if (session.shouldEnter()) {
          const canTrade = safety.canTrade();
          if (!canTrade.allowed) continue;

          if (activeCount < config.maxPositions) {
            const entered = await session.enter(client);
            if (entered) activeCount++;
          }
        }

      } else if (session.phase === 'buying') {
        await session.checkFill(client);
        await session.checkResolutionWhileBuying();

      } else if (session.phase === 'holding') {
        await session.checkResolution();

      } else if (session.phase === 'redeeming') {
        await session.tryRedeem();
      }

    } catch (err) {
      logger.addActivity('bond_error', {
        message: `Soccer fast loop error (${session.market?.question?.slice(0, 40)}): ${err.message?.slice(0, 60)}`
      });
    }
  }
}

function start() {
  if (isRunning) return;
  isRunning = true;

  const config = getBondConfig();
  logger.addActivity('bot', {
    message: [
      'Soccer Bond Bot started — monitoring live soccer markets',
      `  Threshold:     ${(config.threshold * 100).toFixed(0)}¢ (buy when YES token reaches this)`,
      `  Order size:    $${config.orderSize} per trade`,
      `  Max positions: ${config.maxPositions} concurrent open bets`,
      `  Min volume:    $${config.minVolume.toLocaleString()} 24hr volume`,
      `  Loss limit:    $${process.env.DAILY_LOSS_LIMIT || 30} daily (bot stops if hit)`,
      `  Scan interval: every 2 min | price poll: every 15s`
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
  const activePositions = positions.filter(s => ['buying', 'holding', 'redeeming'].includes(s.phase)).length;
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
