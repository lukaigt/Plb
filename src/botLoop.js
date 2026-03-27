const { scanAllMarkets }      = require('./scanner');
const { MomentumSession,
        getMomentumConfig }   = require('./momentumStrategy');
const { initClient }          = require('./trader');
const safety                  = require('./safety');
const logger                  = require('./logger');
const redeemer                = require('./redeemer');
const positionScanner         = require('./positionScanner');
const krakenFeed              = require('./krakenFeed');

let isRunning            = false;
let loopInterval         = null;
let fastLoopInterval     = null;
let lastScanTime         = null;
let lastPositionScanTime = 0;
const POSITION_SCAN_INTERVAL_MS = 5 * 60 * 1000;

const activeSessions = {};

async function getClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) return null;
  return initClient(key);
}

async function runFast() {
  if (!isRunning) return;
  try {
    const client = await getClient();
    for (const session of Object.values(activeSessions)) {
      if (session.phase === 'entering') {
        await session.checkEntryFill(client);
      } else if (session.phase === 'managing') {
        await session.checkTrailingStop(client);
      } else if (session.phase === 'exiting') {
        await session.checkExitFill(client);
      }
    }
  } catch (err) {
    logger.addActivity('error', { message: `Fast loop error: ${err.message?.slice(0, 80)}` });
  }
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

    const config  = getMomentumConfig();
    const client  = await getClient();
    const markets = await scanAllMarkets();

    const seenIds = new Set(markets.map(m => m.id));

    for (const marketId of Object.keys(activeSessions)) {
      if (!seenIds.has(marketId)) {
        const session = activeSessions[marketId];
        if (!session.cancelled) {
          session.cancelled = true;
          logger.addActivity('mom_done', {
            message: `[${session.market.coin}-${session.market.type}] Market resolved | flips=${session.flipCount} | total spent=$${session.totalSpent.toFixed(2)} | cumulative P&L=${session.cumulativePnl >= 0 ? '+' : ''}$${session.cumulativePnl.toFixed(3)}`
          });

          if (session.holdingToken && session.tokenId) {
            const condId = session.market.conditionId || session.market.id;
            redeemer.addPendingRedemption({
              conditionId:   condId,
              tokenId:       session.tokenId,
              negRisk:       session.market.negRisk,
              marketEndTime: session.market.endTime,
              action:        'MOMENTUM',
              side:          session.signal,
              size:          session.totalSpent,
              price:         session.entryPrice || 0.5,
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
        activeSessions[market.id] = new MomentumSession(market, config);
        logger.addActivity('mom_start', {
          message: `[${market.coin}-${market.type}] New session — ${Math.round(market.secondsLeft)}s left | ${market.question}`
        });
      }

      const session = activeSessions[market.id];
      session.market = market;

      if (session.isClosing()) {
        await session.handleClosingPhase(client);
        continue;
      }

      if (session.isTooEarly()) {
        const ctx = krakenFeed.getPriceContext();
        const change = ctx.change3m?.percent || '?';
        logger.addActivity('mom_wait', {
          message: `[${market.coin}-${market.type}] Gathering momentum data (${Math.round(session.secondsLeft)}s left) | BTC 3m: ${change}%`
        });
        continue;
      }

      if (session.phase === 'waiting') {
        await session.attemptEntry(client);
        continue;
      }

      if (session.phase === 'entering') {
        await session.checkEntryFill(client);
        continue;
      }

      if (session.phase === 'managing') {
        continue;
      }

      if (session.phase === 'exiting') {
        continue;
      }

      if (session.phase === 'flipping') {
        await session.attemptFlip(client);
        continue;
      }
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

  const config   = getMomentumConfig();
  const interval = config.refreshInterval * 1000;

  logger.addActivity('bot', {
    message: `Bot started — BTC HYBRID TRADER (hold-to-resolution + profit protection)\n` +
      `  Markets:          5m + 15m (both active)\n` +
      `  Order size:       $${config.orderSize}\n` +
      `  Strategy:         Hold to resolution by default\n` +
      `  Profit protect:   trailing stop activates ${(config.trailingActivate * 100).toFixed(0)}¢ above entry, trails ${(config.trailingStop * 100).toFixed(0)}¢ below peak (floor = entry price)\n` +
      `  Stop loss:        -${(config.stopLossCents * 100).toFixed(0)}¢ from entry (safety net)\n` +
      `  Re-entry:         after profitable exit, re-enter on live BTC signal (max ${config.maxFlips} per window)\n` +
      `  Momentum signal:  ±${config.momentumThreshold}% BTC 3-min change\n` +
      `  Mid range:        $${config.midMin} – $${config.midMax}\n` +
      `  15m timing:       entry after ${config.entryAfterSeconds}s | close final ${config.closeSeconds}s\n` +
      `  5m timing:        entry after ${Math.min(config.entryAfterSeconds, 60)}s | close final ${Math.min(config.closeSeconds, 10)}s\n` +
      `  Price check:      every 5s (profit protection) + every ${config.refreshInterval}s (main loop)\n` +
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
  loopInterval     = setInterval(runOnce, interval);
  fastLoopInterval = setInterval(runFast, 5000);
}

function stop() {
  isRunning = false;
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
  }
  if (fastLoopInterval) {
    clearInterval(fastLoopInterval);
    fastLoopInterval = null;
  }
  logger.addActivity('bot', { message: 'Bot stopped' });
}

function getStatus() {
  const config   = getMomentumConfig();
  const sessions = Object.values(activeSessions).map(s => s.getStatus());
  const { getProxyWallet, getEoaAddress } = require('./trader');
  const btcCtx = krakenFeed.getPriceContext();

  return {
    isRunning,
    lastScanTime,
    strategy: 'SWING_TRADER',
    config,
    activeSessions: sessions,
    windowStatus:   krakenFeed.getWindowStatus(),
    btcContext:     btcCtx,
    safety:         safety.getStatus(),
    proxyWallet:    getProxyWallet() || null,
    eoaAddress:     getEoaAddress()  || null
  };
}

module.exports = { start, stop, getStatus, runOnce };
