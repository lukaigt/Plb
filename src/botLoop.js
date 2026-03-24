const { scanAllMarkets }    = require('./scanner');
const { MarketSession, getMMConfig } = require('./marketMaker');
const { initClient }        = require('./trader');
const safety                = require('./safety');
const logger                = require('./logger');
const redeemer              = require('./redeemer');
const positionScanner       = require('./positionScanner');
const krakenFeed            = require('./krakenFeed');

let isRunning      = false;
let loopInterval   = null;
let lastScanTime   = null;

const activeSessions = {};

function getClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) return null;
  return initClient(key);
}

async function runOnce() {
  if (!isRunning) return;
  lastScanTime = new Date().toISOString();

  try {
    const canTrade = safety.canTrade();
    if (!canTrade.allowed) {
      logger.addActivity('safety_block', { message: `Trading paused: ${canTrade.reason}` });
      return;
    }

    const config  = getMMConfig();
    const client  = await getClient();
    const markets = await scanAllMarkets();

    const seenIds = new Set(markets.map(m => m.id));

    for (const marketId of Object.keys(activeSessions)) {
      if (!seenIds.has(marketId)) {
        const session = activeSessions[marketId];
        if (!session.cancelled) {
          logger.addActivity('mm_done', {
            message: `[${session.market.coin}-${session.market.type}] Market resolved. Orders posted: ${session.ordersPosted} | Spent: $${session.totalSpent.toFixed(2)}`
          });
          await session.cancelOpenOrders(client);
          session.cancelled = true;

          if (session.totalSpent > 0) {
            redeemer.addPendingRedemption({
              conditionId: session.market.id,
              tokenId:     session.market.upTokenId,
              negRisk:     session.market.negRisk,
              marketEndTime: session.market.endTime,
              action:      'MM',
              side:        'UP+DOWN',
              size:        session.totalSpent,
              price:       0.5,
              question:    session.market.question
            });
          }
        }
        delete activeSessions[marketId];
      }
    }

    for (const market of markets) {
      if (!activeSessions[market.id]) {
        activeSessions[market.id] = new MarketSession(market, config);
        logger.addActivity('mm_start', {
          message: `[${market.coin}-${market.type}] New market session — ${Math.round(market.secondsLeft)}s left | ${market.question}`
        });
      }

      const session = activeSessions[market.id];
      session.market = market;

      if (session.isClosing()) {
        if (!session.cancelled) {
          logger.addActivity('mm_close', {
            message: `[${market.coin}-${market.type}] Closing phase (${Math.round(session.secondsLeft)}s left) — cancelling all open orders`
          });
          await session.cancelOpenOrders(client);
          session.cancelled = true;
          session.phase = 'closing';
        }
        continue;
      }

      if (session.isTooEarly()) {
        logger.addActivity('mm_wait', {
          message: `[${market.coin}-${market.type}] Too early to quote (${Math.round(session.secondsLeft)}s left, starts at ${config.maxSeconds}s)`
        });
        await session.fetchMidpointOnly();
        continue;
      }

      session.cancelled = false;
      session.phase = 'active';

      await session.cancelOpenOrders(client);
      await session.postQuotes(client);
    }

    safety.resetDailyIfNeeded();
  } catch (err) {
    logger.addActivity('error', { message: `Bot error: ${err.message}` });
  }

  try { await redeemer.checkAndRedeem(); } catch {}
}

async function start() {
  if (isRunning) {
    logger.addActivity('bot', { message: 'Bot already running' });
    return;
  }

  isRunning = true;
  safety.reload();

  const config   = getMMConfig();
  const interval = config.refreshInterval * 1000;

  logger.addActivity('bot', {
    message: `Bot started — BTC MARKET MAKER MODE\n` +
      `  Markets: BTC 5-min + BTC 15-min\n` +
      `  Spread: ${(config.spread * 100).toFixed(0)}¢ (${(config.spread / 2 * 100).toFixed(0)}¢ each side)\n` +
      `  Order size: $${config.orderSize} per side\n` +
      `  Quote refresh: every ${config.refreshInterval}s\n` +
      `  Quoting window: up to ${config.maxSeconds}s before end\n` +
      `  Closing phase: final ${config.closeSeconds}s — no new orders\n` +
      `  Daily loss limit: $${safety.dailyLossLimit}`
  });

  if (!positionScanner.hasScanned()) {
    try {
      logger.addActivity('bot', { message: 'Scanning wallet for existing unredeemed positions...' });
      const result = await positionScanner.scanExistingPositions();
      if (result.redeemable > 0) {
        logger.addActivity('bot', { message: `Found ${result.redeemable} redeemable position(s) — attempting redemption...` });
        await redeemer.checkAndRedeem();
      }
    } catch (err) {
      logger.addActivity('bot', { message: `Position scan error (non-fatal): ${err.message}` });
    }
  }

  await runOnce();
  loopInterval = setInterval(runOnce, interval);
}

function stop() {
  isRunning = false;
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  logger.addActivity('bot', { message: 'Bot stopped' });
}

function getStatus() {
  const config = getMMConfig();
  const sessions = Object.values(activeSessions).map(s => s.getStatus());

  return {
    isRunning,
    lastScanTime,
    strategy: 'MARKET_MAKER',
    config,
    activeSessions: sessions,
    windowStatus: krakenFeed.getWindowStatus(),
    safety: safety.getStatus()
  };
}

module.exports = { start, stop, getStatus, runOnce };
