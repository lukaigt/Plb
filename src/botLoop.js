const { scanMarkets } = require('./scanner');
const { fetchFullMarketData } = require('./dataFetcher');
const { executeTrade } = require('./trader');
const safety = require('./safety');
const logger = require('./logger');
const redeemer = require('./redeemer');
const positionScanner = require('./positionScanner');
const krakenFeed = require('./krakenFeed');
const spikeDetector = require('./spikeDetector');

const MAX_ENTRY_PRICE = 0.45;
const MIN_ENTRY_PRICE = 0.10;

let isRunning = false;
let loopInterval = null;
let lastScanTime = null;
let lastSpikeStatus = null;

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

    if (!spike.detected) {
      logger.addActivity('spike_watch', {
        message: `Watching BTC: $${spike.btcPrice?.toLocaleString() || '?'} | ${spike.direction || 'N/A'} | ${spike.reason}`,
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
      logger.addActivity('bot', { message: 'Spike detected but no BTC market available. Waiting...' });
      return;
    }

    const market = markets[0];
    const windowKey = safety.getWindowKey(market.endTime);
    const alreadyTraded = safety.hasTraded('BTC', windowKey);
    let isReversal = false;

    if (alreadyTraded) {
      const prevTrade = safety.getWindowTrade('BTC', windowKey);

      if (!prevTrade || prevTrade.reversed) {
        logger.addActivity('skip', { message: `Spike detected but already traded + reversed this window. Max 2 trades per window.` });
        return;
      }

      const oppositeDirection = prevTrade.direction === 'UNKNOWN' ||
                                 (prevTrade.direction === 'UP' && spike.direction === 'DOWN') ||
                                 (prevTrade.direction === 'DOWN' && spike.direction === 'UP');

      if (!oppositeDirection) {
        logger.addActivity('skip', { message: `Spike ${spike.direction} but already traded ${prevTrade.direction} this window. Same direction = skip.` });
        return;
      }

      if (prevTrade.direction !== 'UNKNOWN' && spike.magnitude < prevTrade.magnitude) {
        logger.addActivity('skip', {
          message: `Reversal spike $${spike.magnitude?.toFixed(0)} weaker than original $${prevTrade.magnitude?.toFixed(0)}. Need stronger reversal to trade.`
        });
        return;
      }

      isReversal = true;
      logger.addActivity('spike_reversal', {
        message: `REVERSAL DETECTED: Was ${prevTrade.direction} ($${prevTrade.magnitude?.toFixed(0)}), now ${spike.direction} ($${spike.magnitude?.toFixed(0)}). Allowing reversal trade!`,
        coin: 'BTC'
      });
    }

    const marketData = await fetchFullMarketData(market);

    if (!marketData.yesToken.price?.mid && !marketData.noToken.price?.mid) {
      logger.addActivity('skip', { message: 'Spike detected but no price data for market' });
      return;
    }

    const action = spike.action;
    let entryPrice = null;
    if (action === 'BUY_YES') {
      entryPrice = marketData.yesToken.price?.mid;
    } else if (action === 'BUY_NO') {
      entryPrice = marketData.noToken.price?.mid;
    }

    if (!entryPrice) {
      logger.addActivity('skip', { message: 'No entry price available for trade' });
      return;
    }

    if (entryPrice < MIN_ENTRY_PRICE) {
      logger.addActivity('price_block', {
        message: `BLOCKED: ${action} entry $${entryPrice.toFixed(3)} < min $${MIN_ENTRY_PRICE}. Price too low, likely bad data.`,
        coin: 'BTC'
      });
      return;
    }

    if (entryPrice > MAX_ENTRY_PRICE) {
      logger.addActivity('price_block', {
        message: `BLOCKED: ${action} entry $${entryPrice.toFixed(3)} > max $${MAX_ENTRY_PRICE}. Market already priced in.`,
        coin: 'BTC'
      });
      return;
    }

    const canStillTrade = safety.canTrade();
    if (!canStillTrade.allowed) {
      logger.addActivity('safety_block', { message: `Cannot trade: ${canStillTrade.reason}` });
      return;
    }

    const confidence = spike.confidence || 'MEDIUM';
    const tradeSize = safety.getTradeSize(confidence);
    if (tradeSize <= 0) {
      logger.addActivity('safety_block', { message: 'Trade size too small after safety checks' });
      return;
    }

    const decision = {
      action: action,
      confidence: confidence,
      pattern: isReversal
        ? `REVERSAL ${spike.direction}: $${spike.magnitude?.toFixed(0)} in ${spike.window}`
        : `Spike ${spike.direction}: $${spike.magnitude?.toFixed(0)} in ${spike.window}`,
      reasoning: spike.reason
    };

    logger.addActivity('spike_trade', {
      message: `${isReversal ? 'REVERSAL' : 'TRADING'} on spike: ${action} at $${entryPrice.toFixed(3)} | BTC $${spike.btcPrice?.toLocaleString()} ${spike.direction} | $${spike.magnitude?.toFixed(0)} move in ${spike.window} | Speed: $${spike.speed?.toFixed(0)}/min`,
      coin: 'BTC'
    });

    const trade = await executeTrade(decision, marketData, tradeSize);
    if (trade && trade.success) {
      safety.recordTrade(tradeSize);

      if (isReversal) {
        safety.markReversed('BTC', windowKey);
      } else {
        safety.markTraded('BTC', windowKey, spike.direction, spike.magnitude);
      }

      logger.addActivity('trade_success', {
        message: `${isReversal ? 'REVERSAL ' : ''}TRADE PLACED: ${action} on BTC for $${tradeSize} at $${trade.price?.toFixed(3)} | Spike: ${spike.direction} $${spike.magnitude?.toFixed(0)} | Speed: $${spike.speed?.toFixed(0)}/min`,
        coin: 'BTC'
      });

      redeemer.addPendingRedemption({
        tradeId: trade.tradeId,
        tokenId: trade.tokenId,
        conditionId: market.id,
        negRisk: market.negRisk,
        marketEndTime: market.endTime,
        action: trade.action,
        side: trade.side,
        size: trade.size,
        price: trade.price,
        question: market.question
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
    message: `Bot started — SPIKE DETECTION MODE. Scanning every ${interval / 1000}s. Spike threshold: $${spikeConfig.threshold} (${spikeConfig.windows}). Min speed: $${spikeConfig.minSpeed}/min. Entry range: $${MIN_ENTRY_PRICE}-$${MAX_ENTRY_PRICE}. Max trade: $${safety.maxTradeSize}. Stops after ${safety.maxDailyLosses} losses or $${safety.dailyLossLimit} lost. Reversal trades: ENABLED.`
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
    safety: safety.getStatus()
  };
}

module.exports = { start, stop, getStatus, runOnce };
