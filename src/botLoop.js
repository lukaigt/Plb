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
const CONTRARIAN_MIN_LEAD = parseFloat(process.env.CONTRARIAN_MIN_LEAD) || 20;
const CONTRARIAN_MAX_LEAD = parseFloat(process.env.CONTRARIAN_MAX_LEAD) || 60;
const CONTRARIAN_MAX_MINUTES = parseFloat(process.env.CONTRARIAN_MAX_MINUTES) || 5;
const CONTRARIAN_MIN_MINUTES = parseFloat(process.env.CONTRARIAN_MIN_MINUTES) || 2;

let isRunning = false;
let loopInterval = null;
let lastScanTime = null;
let lastSpikeStatus = null;
let lastStrategy = null;

async function tryCrossOpenFade(spike, markets) {
  if (!spike.detected) return null;
  if (!spike.crossedOpen) return null;

  if (spike.confidence === 'LOW') {
    logger.addActivity('crossopen_skip', {
      message: `Spike ${spike.spikeDirection} crossed opening but confidence LOW (momentum: ${spike.momentum}) — skipping.`,
      coin: 'BTC'
    });
    return null;
  }

  if (!spike.preSpikeeSide) {
    logger.addActivity('crossopen_skip', {
      message: `Spike crossed opening but pre-spike side unknown (insufficient price history). Skipping.`,
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
    if (!prevTrade || prevTrade.reversed) return null;

    const isSameDir = prevTrade.direction === spike.direction;
    if (isSameDir) return null;

    if (prevTrade.direction !== 'UNKNOWN' && spike.magnitude < prevTrade.magnitude) return null;
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
    logger.addActivity('crossopen_price_block', {
      message: `CROSS-OPEN blocked: ${action} at $${entryPrice.toFixed(3)} outside range $${MIN_ENTRY_PRICE}-$${MAX_ENTRY_PRICE}. BTC was ${spike.preSpikeeSide} before spike, now on other side.`,
      coin: 'BTC'
    });
    return null;
  }

  return {
    strategy: 'CROSS_OPEN',
    action,
    entryPrice,
    marketData,
    market,
    windowKey,
    isReversal: alreadyTraded,
    confidence: spike.confidence,
    reason: `CROSS-OPEN: BTC was ${spike.preSpikeeSide} opening, spiked ${spike.spikeDirection} $${spike.magnitude?.toFixed(0)} crossing opening price → bet ${spike.preSpikeeSide} (reversion). Entry: $${entryPrice.toFixed(3)}. Momentum: ${spike.momentum}.`
  };
}

async function tryLateContrarian(markets) {
  const windowStatus = krakenFeed.getWindowStatus();

  if (!windowStatus.openPrice || !windowStatus.currentPrice || !windowStatus.btcLeadingSide) return null;
  if (windowStatus.minutesLeft > CONTRARIAN_MAX_MINUTES || windowStatus.minutesLeft < CONTRARIAN_MIN_MINUTES) return null;
  if (windowStatus.btcVsOpenDollars === null || windowStatus.btcVsOpenDollars < CONTRARIAN_MIN_LEAD || windowStatus.btcVsOpenDollars > CONTRARIAN_MAX_LEAD) return null;

  const market = markets[0];
  if (!market) return null;

  const windowKey = safety.getWindowKey(market.endTime);
  const alreadyTraded = safety.hasTraded('BTC', windowKey);

  if (alreadyTraded) {
    const prevTrade = safety.getWindowTrade('BTC', windowKey);
    if (prevTrade && prevTrade.reversed) return null;

    const losingDir = windowStatus.btcLeadingSide === 'UP' ? 'DOWN' : 'UP';
    const prevDir = prevTrade?.direction;
    if (prevDir && prevDir !== 'UNKNOWN' && prevDir === losingDir) return null;
  }

  const losingSide = windowStatus.btcLeadingSide === 'UP' ? 'DOWN' : 'UP';
  const action = losingSide === 'UP' ? 'BUY_YES' : 'BUY_NO';

  const marketData = await fetchFullMarketData(market);

  let entryPrice = null;
  if (action === 'BUY_YES') {
    entryPrice = marketData.yesToken.price?.mid;
  } else if (action === 'BUY_NO') {
    entryPrice = marketData.noToken.price?.mid;
  }

  if (!entryPrice) return null;

  if (entryPrice < MIN_ENTRY_PRICE || entryPrice > MAX_ENTRY_PRICE) {
    logger.addActivity('contrarian_price_block', {
      message: `CONTRARIAN blocked: ${action} at $${entryPrice.toFixed(3)} outside range $${MIN_ENTRY_PRICE}-$${MAX_ENTRY_PRICE}. BTC leads by $${windowStatus.btcVsOpenDollars.toFixed(0)} (${windowStatus.btcLeadingSide}) with ${windowStatus.minutesLeft.toFixed(1)}min left.`,
      coin: 'BTC'
    });
    return null;
  }

  let confidence = 'MEDIUM';
  if (windowStatus.btcVsOpenDollars <= 35 && windowStatus.minutesLeft >= 3 && entryPrice <= 0.30) {
    confidence = 'HIGH';
  }

  return {
    strategy: 'CONTRARIAN',
    action,
    entryPrice,
    marketData,
    market,
    windowKey,
    isReversal: alreadyTraded,
    confidence,
    reason: `CONTRARIAN: BTC leads ${windowStatus.btcLeadingSide} by $${windowStatus.btcVsOpenDollars.toFixed(0)} with ${windowStatus.minutesLeft.toFixed(1)}min left → buy underdog ${losingSide} at $${entryPrice.toFixed(3)} (small lead, can flip).`
  };
}

function shouldCheckStrategies(spike, windowStatus) {
  if (spike.detected && spike.crossedOpen) return true;

  if (windowStatus.openPrice &&
      windowStatus.btcVsOpenDollars >= CONTRARIAN_MIN_LEAD &&
      windowStatus.btcVsOpenDollars <= CONTRARIAN_MAX_LEAD &&
      windowStatus.minutesLeft <= CONTRARIAN_MAX_MINUTES &&
      windowStatus.minutesLeft >= CONTRARIAN_MIN_MINUTES) {
    return true;
  }

  return false;
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

    if (!shouldCheckStrategies(spike, windowStatus)) {
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

    if (spike.detected && spike.crossedOpen) {
      signal = await tryCrossOpenFade(spike, markets);
    }

    if (!signal) {
      signal = await tryLateContrarian(markets);
    }

    if (!signal) {
      if (spike.detected && spike.crossedOpen) {
        logger.addActivity('skip', { message: `Cross-open spike detected but no valid entry found (price outside range or already traded this window)` });
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
      const tradeDir = signal.action === 'BUY_YES' ? 'UP' : 'DOWN';
      if (signal.isReversal) {
        safety.markReversed('BTC', windowKey);
      } else {
        safety.markTraded('BTC', windowKey, tradeDir, spike.magnitude || 0);
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
      `  Strategy 1: CROSS-OPEN FADE — only fade spikes that cross the opening price\n` +
      `  Strategy 2: LATE CONTRARIAN — buy cheap underdog when lead is small ($${CONTRARIAN_MIN_LEAD}-$${CONTRARIAN_MAX_LEAD}) with ${CONTRARIAN_MAX_MINUTES}min left\n` +
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
