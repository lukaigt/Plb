const { scanMarkets } = require('./scanner');
const { fetchFullMarketData } = require('./dataFetcher');
const { getAiPrediction } = require('./aiEngine');
const { executeTrade } = require('./trader');
const safety = require('./safety');
const logger = require('./logger');
const redeemer = require('./redeemer');
const positionScanner = require('./positionScanner');

let isRunning = false;
let loopInterval = null;
let lastScanTime = null;

async function runOnce() {
  if (!isRunning) return;

  lastScanTime = new Date().toISOString();
  logger.addActivity('bot', { message: '--- Starting BTC scan ---' });

  try {
    const canTrade = safety.canTrade();
    if (!canTrade.allowed) {
      logger.addActivity('safety_block', { message: `Bot stopped: ${canTrade.reason}` });
      return;
    }

    const markets = await scanMarkets();

    if (markets.length === 0) {
      logger.addActivity('bot', { message: 'No BTC market available. Waiting...' });
      return;
    }

    const market = markets[0];

    const windowKey = safety.getWindowKey(market.endTime);
    if (safety.hasTraded('BTC', windowKey)) {
      logger.addActivity('skip', { message: `Already traded BTC in this 15-min window. Waiting for next window.` });
      return;
    }

    const marketData = await fetchFullMarketData(market);

    if (!marketData.yesToken.price?.mid && !marketData.noToken.price?.mid) {
      logger.addActivity('skip', { message: 'No price data available for BTC market' });
      return;
    }

    const decision = await getAiPrediction(marketData);

    if (decision.action === 'SKIP') {
      logger.addActivity('ai_skip', {
        message: `AI SKIPPED | Pattern: ${decision.pattern || 'none'} | ${decision.reasoning}`,
        coin: 'BTC'
      });
      logger.addActivity('bot', { message: '--- Scan complete. No trade. ---' });
      return;
    }

    const canStillTrade = safety.canTrade();
    if (!canStillTrade.allowed) {
      logger.addActivity('safety_block', { message: `Cannot trade: ${canStillTrade.reason}` });
      return;
    }

    const tradeSize = safety.getTradeSize(decision.confidence);
    if (tradeSize <= 0) {
      logger.addActivity('safety_block', { message: 'Trade size too small after safety checks' });
      return;
    }

    const trade = await executeTrade(decision, marketData, tradeSize);
    if (trade && trade.success) {
      safety.recordTrade(tradeSize);
      safety.markTraded('BTC', windowKey);
      logger.addActivity('trade_success', {
        message: `TRADE PLACED: ${decision.action} on BTC for $${tradeSize} | Pattern: ${decision.pattern} | Price: $${trade.price?.toFixed(3)}`,
        coin: 'BTC'
      });

      redeemer.addPendingRedemption({
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

    logger.addActivity('bot', { message: '--- Scan complete. ---' });
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

  const interval = (parseInt(process.env.SCAN_INTERVAL) || 30) * 1000;

  logger.addActivity('bot', {
    message: `Bot started — BTC ONLY. Scanning every ${interval / 1000}s. Max trade: $${safety.maxTradeSize}. Stops after ${safety.maxDailyLosses} losses or $${safety.dailyLossLimit} lost. Strategy: Candle structure analysis.`
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
    safety: safety.getStatus()
  };
}

module.exports = { start, stop, getStatus, runOnce };
