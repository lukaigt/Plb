const { scanMarkets } = require('./scanner');
const { fetchFullMarketData } = require('./dataFetcher');
const { getAiPrediction } = require('./aiEngine');
const { executeTrade } = require('./trader');
const safety = require('./safety');
const logger = require('./logger');

let isRunning = false;
let loopInterval = null;
let lastScanTime = null;
let tradedThisCycle = false;

async function scoreOpportunity(marketData, decision) {
  if (decision.action === 'SKIP') return -1;

  let score = 0;

  if (decision.confidence === 'HIGH') score += 3;
  else if (decision.confidence === 'MEDIUM') score += 1;

  const upBids = parseFloat(marketData.yesToken.orderbook?.totalBidVolume) || 0;
  const downBids = parseFloat(marketData.noToken.orderbook?.totalBidVolume) || 0;
  const totalBids = upBids + downBids;
  if (totalBids > 0) {
    const imbalance = Math.abs(upBids - downBids) / totalBids;
    score += imbalance * 5;
  }

  if (marketData.priceTrend.momentum === 'decelerating') score += 2;
  if (marketData.priceTrend.momentum === 'accelerating') score -= 2;

  const yesPrice = marketData.yesToken.price?.mid || 0.5;
  const distFromCenter = Math.abs(yesPrice - 0.5);
  if (distFromCenter > 0.15) score += 1;
  if (distFromCenter > 0.25) score += 1;

  return score;
}

async function processMarket(market) {
  try {
    const windowKey = safety.getWindowKey(market.endTime);
    if (safety.hasTraded(market.coin, windowKey)) {
      logger.addActivity('skip', {
        message: `Skipping ${market.coin} — already traded this 15-min window`,
        coin: market.coin
      });
      return null;
    }

    const marketData = await fetchFullMarketData(market);

    if (!marketData.yesToken.price?.mid && !marketData.noToken.price?.mid) {
      logger.addActivity('skip', {
        message: `Skipping ${market.coin} - no price data available`,
        coin: market.coin
      });
      return null;
    }

    const canTrade = safety.canTrade();
    if (!canTrade.allowed) {
      logger.addActivity('safety_block', {
        message: `Cannot trade ${market.coin}: ${canTrade.reason}`,
        coin: market.coin
      });
      return null;
    }

    const decision = await getAiPrediction(marketData);

    if (decision.action === 'SKIP') {
      logger.addActivity('ai_skip', {
        message: `AI skipped ${market.coin}: ${decision.reasoning}`,
        coin: market.coin
      });
      return null;
    }

    const score = await scoreOpportunity(marketData, decision);

    return {
      market,
      marketData,
      decision,
      score
    };
  } catch (err) {
    logger.addActivity('error', {
      message: `Error processing ${market.coin}: ${err.message}`,
      coin: market.coin
    });
    return null;
  }
}

async function runOnce() {
  if (!isRunning) return;

  lastScanTime = new Date().toISOString();
  tradedThisCycle = false;
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

    const opportunities = [];

    for (const market of markets) {
      if (!isRunning) break;

      const canStillTrade = safety.canTrade();
      if (!canStillTrade.allowed) {
        logger.addActivity('safety_block', { message: `Stopping mid-cycle: ${canStillTrade.reason}` });
        break;
      }

      const opportunity = await processMarket(market);
      if (opportunity) {
        opportunities.push(opportunity);
      }

      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    if (opportunities.length === 0) {
      logger.addActivity('bot', { message: `--- Scan cycle complete. No trade opportunities found. ---` });
      return;
    }

    opportunities.sort((a, b) => b.score - a.score);
    const best = opportunities[0];

    logger.addActivity('bot', {
      message: `Best opportunity: ${best.market.coin} (score: ${best.score.toFixed(1)}) — ${best.decision.action} (${best.decision.confidence})`
    });

    const tradeSize = safety.getTradeSize(best.decision.confidence);
    if (tradeSize <= 0) {
      logger.addActivity('safety_block', {
        message: `Trade size too small for ${best.market.coin} after safety checks`,
        coin: best.market.coin
      });
      return;
    }

    const trade = await executeTrade(best.decision, best.marketData, tradeSize);
    if (trade && trade.success) {
      safety.recordTrade(tradeSize);
      const windowKey = safety.getWindowKey(best.market.endTime);
      safety.markTraded(best.market.coin, windowKey);
      tradedThisCycle = true;
      logger.addActivity('trade_success', {
        message: `Trade executed: ${best.decision.action} on ${best.market.coin} for $${tradeSize} (best of ${opportunities.length} opportunities)`,
        coin: best.market.coin
      });
    }

    logger.addActivity('bot', { message: `--- Scan cycle complete. ${opportunities.length} opportunities evaluated, ${tradedThisCycle ? '1 trade placed' : 'no trade placed'}. ---` });
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
    message: `Bot started. Scanning every ${interval / 1000}s. Daily loss limit: $${safety.dailyLossLimit}, Max trade: $${safety.maxTradeSize}. Strategy: Mean reversion + orderbook analysis. Max 1 trade per scan cycle, 1 per coin per window.`
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
