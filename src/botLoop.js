const { scanAllMarkets }    = require('./scanner');
const { MarketSession, getMMConfig } = require('./marketMaker');
const { initClient }        = require('./trader');
const safety                = require('./safety');
const logger                = require('./logger');
const redeemer              = require('./redeemer');
const positionScanner       = require('./positionScanner');
const positionTracker       = require('./positionTracker');
const krakenFeed            = require('./krakenFeed');

let isRunning            = false;
let loopInterval         = null;
let lastScanTime         = null;
let lastPositionScanTime = 0;
const POSITION_SCAN_INTERVAL_MS = 5 * 60 * 1000;

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
            const condId = session.market.conditionId || session.market.id;
            redeemer.addPendingRedemption({
              conditionId:   condId,
              tokenId:       session.market.upTokenId,
              negRisk:       session.market.negRisk,
              marketEndTime: session.market.endTime,
              action:        'MM',
              side:          'UP',
              size:          session.totalSpent / 2,
              price:         0.5,
              question:      session.market.question,
              tradeIds:      [...session.tradeIds]
            });
            redeemer.addPendingRedemption({
              conditionId:   condId,
              tokenId:       session.market.downTokenId,
              negRisk:       session.market.negRisk,
              marketEndTime: session.market.endTime,
              action:        'MM',
              side:          'DOWN',
              size:          session.totalSpent / 2,
              price:         0.5,
              question:      session.market.question,
              tradeIds:      [...session.tradeIds]
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
      await new Promise(r => setTimeout(r, 800));
      const placed = await session.postQuotes(client);

      if (Array.isArray(placed)) {
        for (const p of placed) {
          const tokenId = p.side === 'UP' ? session.market.upTokenId : session.market.downTokenId;
          positionTracker.trackOrder(
            p.orderId, tokenId, p.side, p.price, p.size,
            session.market.id, session.market.coin, session.market.type, session.market
          );
        }
      }
    }

    try {
      const sessions = Object.values(activeSessions);
      await positionTracker.pollFills();
      await positionTracker.checkTakeProfit(sessions);
      positionTracker.pruneOldPositions();
    } catch (tpErr) {
      logger.addActivity('error', { message: `Take-profit check error: ${tpErr.message}` });
    }

    safety.resetDailyIfNeeded();

    const now = Date.now();
    if (now - lastPositionScanTime >= POSITION_SCAN_INTERVAL_MS) {
      lastPositionScanTime = now;
      try {
        logger.addActivity('position_scanner', { message: 'Periodic wallet scan — checking for redeemable positions...' });
        const result = await positionScanner.scanExistingPositions();
        if (result.redeemable > 0) {
          logger.addActivity('position_scanner', { message: `Periodic scan: ${result.redeemable} position(s) queued for redemption` });
        }
      } catch (scanErr) {
        logger.addActivity('position_scanner_error', { message: `Periodic scan error: ${scanErr.message?.slice(0, 80)}` });
      }
    }

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

  try {
    logger.addActivity('bot', { message: 'Scanning wallet for existing unredeemed positions...' });
    const result = await positionScanner.scanExistingPositions();
    if (result.redeemable > 0) {
      logger.addActivity('bot', { message: `Found ${result.redeemable} redeemable position(s) — attempting redemption...` });
      await redeemer.checkAndRedeem();
    }
    lastPositionScanTime = Date.now();
  } catch (err) {
    logger.addActivity('bot', { message: `Position scan error (non-fatal): ${err.message}` });
    lastPositionScanTime = Date.now();
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
  const { getProxyWallet, getEoaAddress } = require('./trader');

  return {
    isRunning,
    lastScanTime,
    strategy: 'MARKET_MAKER',
    config,
    activeSessions: sessions,
    windowStatus: krakenFeed.getWindowStatus(),
    safety: safety.getStatus(),
    proxyWallet: getProxyWallet() || null,
    eoaAddress:  getEoaAddress()  || null
  };
}

module.exports = { start, stop, getStatus, runOnce };
