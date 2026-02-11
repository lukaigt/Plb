const { scanMarkets } = require('./scanner');
const { fetchFullMarketData } = require('./dataFetcher');
const { getAiPrediction } = require('./aiEngine');
const { executeTrade } = require('./trader');
const safety = require('./safety');
const logger = require('./logger');

let isRunning = false;
let loopInterval = null;
let lastScanTime = null;

async function processMarket(market) {
  try {
    const marketData = await fetchFullMarketData(market);

    if (!marketData.yesToken.price?.mid && !marketData.noToken.price?.mid) {
      logger.addActivity('skip', {
        message: `Skipping ${market.coin} - no price data available`,
        coin: market.coin
      });
      return;
    }

    const canTrade = safety.canTrade();
    if (!canTrade.allowed) {
      logger.addActivity('safety_block', {
        message: `Cannot trade ${market.coin}: ${canTrade.reason}`,
        coin: market.coin
      });
      return;
    }

    const decision = await getAiPrediction(marketData);

    if (decision.action === 'SKIP') {
      logger.addActivity('ai_skip', {
        message: `AI skipped ${market.coin}: ${decision.reasoning}`,
        coin: market.coin
      });
      return;
    }

    const tradeSize = safety.getTradeSize(decision.confidence);
    if (tradeSize <= 0) {
      logger.addActivity('safety_block', {
        message: `Trade size too small for ${market.coin} after safety checks`,
        coin: market.coin
      });
      return;
    }

    const trade = await executeTrade(decision, marketData, tradeSize);
    if (trade && trade.success) {
      safety.recordTrade(tradeSize);
      logger.addActivity('trade_success', {
        message: `Trade executed: ${decision.action} on ${market.coin} for $${tradeSize}`,
        coin: market.coin
      });
    }
  } catch (err) {
    logger.addActivity('error', {
      message: `Error processing ${market.coin}: ${err.message}`,
      coin: market.coin
    });
  }
}

async function runOnce() {
  if (!isRunning) return;

  lastScanTime = new Date().toISOString();
  logger.addActivity('bot', { message: '--- Starting market scan cycle ---' });

  try {
    const markets = await scanMarkets();

    if (markets.length === 0) {
      logger.addActivity('bot', { message: 'No active 15-min crypto markets found this cycle' });
      return;
    }

    const canTrade = safety.canTrade();
    if (!canTrade.allowed) {
      logger.addActivity('safety_block', { message: `Bot stopped: ${canTrade.reason}` });
      return;
    }

    for (const market of markets) {
      if (!isRunning) break;

      const canStillTrade = safety.canTrade();
      if (!canStillTrade.allowed) {
        logger.addActivity('safety_block', { message: `Stopping mid-cycle: ${canStillTrade.reason}` });
        break;
      }

      await processMarket(market);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    logger.addActivity('bot', { message: `--- Scan cycle complete. Processed ${markets.length} markets ---` });
  } catch (err) {
    logger.addActivity('error', { message: `Bot loop error: ${err.message}` });
  }
}

function start() {
  if (isRunning) {
    logger.addActivity('bot', { message: 'Bot is already running' });
    return;
  }

  isRunning = true;
  safety.reload();

  const interval = (parseInt(process.env.SCAN_INTERVAL) || 120) * 1000;

  logger.addActivity('bot', {
    message: `Bot started. Scanning every ${interval / 1000} seconds. Daily limit: $${safety.dailyLossLimit}, Max trade: $${safety.maxTradeSize}`
  });

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
