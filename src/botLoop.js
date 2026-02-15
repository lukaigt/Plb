const { scanMarkets } = require('./scanner');
const { fetchFullMarketData } = require('./dataFetcher');
const { executeTrade } = require('./trader');
const safety = require('./safety');
const logger = require('./logger');
const redeemer = require('./redeemer');
const positionScanner = require('./positionScanner');
const krakenFeed = require('./krakenFeed');
const spikeDetector = require('./spikeDetector');

const MAX_ENTRY_PRICE = parseFloat(process.env.MAX_ENTRY_PRICE) || 0.40;
const MIN_ENTRY_PRICE = parseFloat(process.env.MIN_ENTRY_PRICE) || 0.10;
const SNIPER_MIN_LEAD = parseFloat(process.env.SNIPER_MIN_LEAD) || 100;
const SNIPER_MAX_MINUTES = parseFloat(process.env.SNIPER_MAX_MINUTES) || 5;
const SNIPER_MIN_MINUTES = parseFloat(process.env.SNIPER_MIN_MINUTES) || 1.5;

let isRunning = false;
let loopInterval = null;
let lastScanTime = null;
let lastSpikeStatus = null;
let lastStrategy = null;

async function tryFadeStrategy(spike, markets) {
  if (!spike.detected) return null;

  if (spike.confidence === 'LOW') {
    logger.addActivity('fade_skip', {
      message: `Spike ${spike.spikeDirection} but confidence LOW (momentum: ${spike.momentum}) — too risky to fade. Waiting for better setup.`,
      coin: 'BTC'
    });
    return null;
  }

  const market = markets[0];
  if (!market) return null;

  const windowKey = safety.getWindowKey(market.endTime);
  const alreadyTraded = safety.hasTraded('BTC', windowKey);

  if (alreadyTraded) {
    const prevTrade = safety.getWindowTrade('BTC', windowKey);
    if (!prevTrade || prevTrade.reversed) {
      return null;
    }

    const oppositeDirection = prevTrade.direction === 'UNKNOWN' ||
      (prevTrade.direction !== spike.direction);

    if (!oppositeDirection) {
      return null;
    }

    if (prevTrade.direction !== 'UNKNOWN' && spike.magnitude < prevTrade.magnitude) {
      return null;
    }
  }

  const marketData = await fetchFullMarketData(market);

  const action = spike.action;
  let entryPrice = null;
  if (action === 'BUY_YES') {
    entryPrice = marketData.yesToken.price?.mid;
  } else if (action === 'BUY_NO') {
    entryPrice = marketData.noToken.price?.mid;
  }

  if (!entryPrice) return null;

  if (entryPrice < MIN_ENTRY_PRICE || entryPrice > MAX_ENTRY_PRICE) {
    logger.addActivity('fade_price_block', {
      message: `FADE blocked: ${action} at $${entryPrice.toFixed(3)} outside range $${MIN_ENTRY_PRICE}-$${MAX_ENTRY_PRICE}`,
      coin: 'BTC'
    });
    return null;
  }

  return {
    strategy: 'FADE',
    action,
    entryPrice,
    marketData,
    market,
    windowKey,
    isReversal: alreadyTraded,
    confidence: spike.confidence,
    reason: `FADE: BTC spiked ${spike.spikeDirection} $${spike.magnitude?.toFixed(0)} → betting ${spike.direction} (mean reversion). Entry: $${entryPrice.toFixed(3)}. Momentum: ${spike.momentum}.`
  };
}

async function trySniperStrategy(markets) {
  const windowStatus = krakenFeed.getWindowStatus();

  if (!windowStatus.openPrice || !windowStatus.currentPrice) return null;
  if (windowStatus.minutesLeft > SNIPER_MAX_MINUTES || windowStatus.minutesLeft < SNIPER_MIN_MINUTES) return null;
  if (windowStatus.btcVsOpenDollars < SNIPER_MIN_LEAD) return null;

  const market = markets[0];
  if (!market) return null;

  const windowKey = safety.getWindowKey(market.endTime);
  const alreadyTraded = safety.hasTraded('BTC', windowKey);

  if (alreadyTraded) {
    const prevTrade = safety.getWindowTrade('BTC', windowKey);
    if (prevTrade && prevTrade.reversed) return null;

    const prevDir = prevTrade?.direction;
    const sniperDir = windowStatus.btcLeadingSide;
    if (prevDir && prevDir !== 'UNKNOWN' && prevDir === sniperDir) return null;
  }

  const action = windowStatus.btcLeadingSide === 'UP' ? 'BUY_YES' : 'BUY_NO';

  const marketData = await fetchFullMarketData(market);

  let entryPrice = null;
  if (action === 'BUY_YES') {
    entryPrice = marketData.yesToken.price?.mid;
  } else if (action === 'BUY_NO') {
    entryPrice = marketData.noToken.price?.mid;
  }

  if (!entryPrice) return null;

  if (entryPrice < MIN_ENTRY_PRICE || entryPrice > MAX_ENTRY_PRICE) {
    logger.addActivity('sniper_price_block', {
      message: `SNIPER blocked: ${action} at $${entryPrice.toFixed(3)} outside range $${MIN_ENTRY_PRICE}-$${MAX_ENTRY_PRICE}. Lead: $${windowStatus.btcVsOpenDollars.toFixed(0)} with ${windowStatus.minutesLeft.toFixed(1)}min left.`,
      coin: 'BTC'
    });
    return null;
  }

  return {
    strategy: 'SNIPER',
    action,
    entryPrice,
    marketData,
    market,
    windowKey,
    isReversal: alreadyTraded,
    confidence: windowStatus.btcVsOpenDollars >= 200 ? 'HIGH' : 'MEDIUM',
    reason: `SNIPER: BTC ${windowStatus.btcVsOpen} opening by $${windowStatus.btcVsOpenDollars.toFixed(0)} with ${windowStatus.minutesLeft.toFixed(1)}min left → ${action} at $${entryPrice.toFixed(3)}`
  };
}

async function runOnce() {
  if (!isRunning) return;

  lastScanTime = new Date().toISOString();

  try {
    const canTrade = safety.canTrade();
    if (!canTrade.allowed) {
      logger.addActivity('safety_block', { message: `Bot stopped: ${canTrade.reason}` });
      return;
    }

    const spike = spikeDetector.detect();
    lastSpikeStatus = spike;

    const windowStatus = krakenFeed.getWindowStatus();

    if (!spike.detected && (!windowStatus.openPrice || windowStatus.btcVsOpenDollars < SNIPER_MIN_LEAD || windowStatus.minutesLeft > SNIPER_MAX_MINUTES)) {
      const windowInfo = windowStatus.openPrice
        ? ` | vs Open: ${windowStatus.btcVsOpen || '?'} $${windowStatus.btcVsOpenDollars?.toFixed(0) || '?'} | ${windowStatus.minutesLeft?.toFixed(1) || '?'}min left`
        : '';
      logger.addActivity('spike_watch', {
        message: `Watching BTC: $${spike.btcPrice?.toLocaleString() || '?'} | ${spike.direction || 'N/A'} | ${spike.reason}${windowInfo}`,
        coin: 'BTC'
      });

      try {
        await redeemer.checkAndRedeem();
      } catch (err) {
        logger.addActivity('redeemer_error', { message: `Redeem check error: ${err.message}` });
      }
      return;
    }

    const markets = await scanMarkets();

    if (markets.length === 0) {
      logger.addActivity('bot', { message: 'Signal detected but no BTC market available. Waiting...' });
      return;
    }

    let signal = null;

    if (spike.detected) {
      signal = await tryFadeStrategy(spike, markets);
    }

    if (!signal) {
      signal = await trySniperStrategy(markets);
    }

    if (!signal) {
      if (spike.detected) {
        logger.addActivity('skip', { message: `Spike detected but no valid entry found (price outside range or already traded this window)` });
      }
      return;
    }

    lastStrategy = signal.strategy;

    const canStillTrade = safety.canTrade();
    if (!canStillTrade.allowed) {
      logger.addActivity('safety_block', { message: `Cannot trade: ${canStillTrade.reason}` });
      return;
    }

    const tradeSize = safety.getTradeSize(signal.confidence);
    if (tradeSize <= 0) {
      logger.addActivity('safety_block', { message: 'Trade size too small after safety checks' });
      return;
    }

    const decision = {
      action: signal.action,
      confidence: signal.confidence,
      pattern: `[${signal.strategy}] ${signal.reason}`,
      reasoning: signal.reason
    };

    logger.addActivity('strategy_trade', {
      message: `${signal.strategy} ${signal.isReversal ? '(REVERSAL) ' : ''}TRADE: ${signal.action} at $${signal.entryPrice.toFixed(3)} | ${signal.reason}`,
      coin: 'BTC',
      strategy: signal.strategy
    });

    const trade = await executeTrade(decision, signal.marketData, tradeSize);
    if (trade && trade.success) {
      safety.recordTrade(tradeSize);

      const windowKey = signal.windowKey;
      if (signal.isReversal) {
        safety.markReversed('BTC', windowKey);
      } else {
        safety.markTraded('BTC', windowKey, signal.strategy === 'FADE' ? spike.direction : (signal.action === 'BUY_YES' ? 'UP' : 'DOWN'), spike.magnitude || 0);
      }

      logger.addActivity('trade_success', {
        message: `${signal.strategy} ${signal.isReversal ? 'REVERSAL ' : ''}PLACED: ${signal.action} for $${tradeSize} at $${trade.price?.toFixed(3)} | ${signal.reason}`,
        coin: 'BTC',
        strategy: signal.strategy
      });

      redeemer.addPendingRedemption({
        tradeId: trade.tradeId,
        tokenId: trade.tokenId,
        conditionId: signal.market.id,
        negRisk: signal.market.negRisk,
        marketEndTime: signal.market.endTime,
        action: trade.action,
        side: trade.side,
        size: trade.size,
        price: trade.price,
        question: signal.market.question
      });
    }
  } catch (err) {
    logger.addActivity('error', { message: `Bot error: ${err.message}` });
  }

  try {
    await redeemer.checkAndRedeem();
  } catch (err) {
    logger.addActivity('redeemer_error', { message: `Redeem check error: ${err.message}` });
  }
}

async function start() {
  if (isRunning) {
    logger.addActivity('bot', { message: 'Bot is already running' });
    return;
  }

  isRunning = true;
  safety.reload();

  const interval = (parseInt(process.env.SCAN_INTERVAL) || 10) * 1000;
  const spikeConfig = spikeDetector.getConfig();

  logger.addActivity('bot', {
    message: `Bot started — DUAL STRATEGY MODE.\n` +
      `  Strategy 1: FADE THE SPIKE (mean reversion) — trade AGAINST $${spikeConfig.threshold}+ spikes\n` +
      `  Strategy 2: LATE-GAME SNIPER — trade with BTC lead ($${SNIPER_MIN_LEAD}+) in last ${SNIPER_MAX_MINUTES}min\n` +
      `  Scan: ${interval / 1000}s | Entry: $${MIN_ENTRY_PRICE}-$${MAX_ENTRY_PRICE} | Max trade: $${safety.maxTradeSize}\n` +
      `  Stops after ${safety.maxDailyLosses} losses or $${safety.dailyLossLimit} lost`
  });

  if (!positionScanner.hasScanned()) {
    try {
      logger.addActivity('bot', { message: 'Scanning wallet for existing unredeemed positions...' });
      const result = await positionScanner.scanExistingPositions();
      if (result.redeemable > 0) {
        logger.addActivity('bot', {
          message: `Found ${result.redeemable} redeemable position(s) from old trades! Will attempt redemption...`
        });
        await redeemer.checkAndRedeem();
      }
    } catch (err) {
      logger.addActivity('bot', { message: `Position scan error (non-fatal): ${err.message}` });
    }
  }

  runOnce();
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
  return {
    isRunning,
    lastScanTime,
    lastSpikeStatus,
    lastStrategy,
    windowStatus: krakenFeed.getWindowStatus(),
    safety: safety.getStatus()
  };
}

module.exports = { start, stop, getStatus, runOnce };
