const { scanMarkets } = require('./scanner');
const { getMarketPrice } = require('./dataFetcher');
const { executeTrade } = require('./trader');
const safety = require('./safety');
const logger = require('./logger');
const redeemer = require('./redeemer');
const positionScanner = require('./positionScanner');
const krakenFeed = require('./krakenFeed');
const scalpSignal = require('./scalpSignal');

let isRunning = false;
let loopInterval = null;
let lastScanTime = null;
let lastSignalStatus = null;
let consecutiveErrors = 0;

async function runOnce() {
  if (!isRunning) return;

  lastScanTime = new Date().toISOString();

  try {
    const canTrade = safety.canTrade();
    if (!canTrade.allowed) {
      logger.addActivity('safety_block', { message: `Bot stopped: ${canTrade.reason}` });
      return;
    }

    const windowStatus = krakenFeed.getWindowStatus();
    const secondsLeft = windowStatus.secondsLeft;

    const scalpConfig = scalpSignal.getConfig();

    if (secondsLeft > scalpConfig.maxSeconds + 30) {
      logger.addActivity('scalp_watch', {
        message: `Watching: ${Math.round(secondsLeft)}s left in window | BTC: $${windowStatus.currentPrice?.toLocaleString() || '?'} | ` +
          (windowStatus.btcLeadingSide
            ? `Lead: ${windowStatus.btcLeadingSide} $${windowStatus.btcVsOpenDollars?.toFixed(0) || '?'}`
            : 'Waiting for window data...')
      });

      try { await redeemer.checkAndRedeem(); } catch (err) {}
      consecutiveErrors = 0;
      return;
    }

    const market = await scanMarkets();

    if (!market) {
      logger.addActivity('scalp_watch', {
        message: `No active 5-min market found. ${Math.round(secondsLeft)}s left in current window.`
      });
      consecutiveErrors = 0;
      return;
    }

    if (market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;

      market.tokens.forEach((t, i) => {
        t.price = prices[i] ? parseFloat(prices[i]) : t.price;
      });
    }

    const signal = scalpSignal.evaluate(market);
    lastSignalStatus = signal;

    if (!signal.ready) {
      logger.addActivity('scalp_watch', {
        message: `${signal.reason} | ${market.secondsLeft}s left`
      });
      consecutiveErrors = 0;
      return;
    }

    const windowKey = safety.getWindowKey(market.endTime);
    if (safety.hasTraded('BTC', windowKey)) {
      logger.addActivity('scalp_skip', {
        message: `Already traded this window (${windowKey}). Skipping.`
      });
      return;
    }

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

    const isYes = signal.action === 'BUY_YES';
    const token = isYes
      ? market.tokens.find(t => (t.outcome || '').toLowerCase() === 'up' || (t.outcome || '').toLowerCase() === 'yes') || market.tokens[0]
      : market.tokens.find(t => (t.outcome || '').toLowerCase() === 'down' || (t.outcome || '').toLowerCase() === 'no') || market.tokens[1];

    const otherToken = isYes
      ? market.tokens.find(t => (t.outcome || '').toLowerCase() === 'down' || (t.outcome || '').toLowerCase() === 'no') || market.tokens[1]
      : market.tokens.find(t => (t.outcome || '').toLowerCase() === 'up' || (t.outcome || '').toLowerCase() === 'yes') || market.tokens[0];

    const marketData = {
      market,
      yesToken: {
        ...market.tokens.find(t => (t.outcome || '').toLowerCase() === 'up' || (t.outcome || '').toLowerCase() === 'yes') || market.tokens[0],
        price: { buy: signal.upPrice, sell: null, mid: signal.upPrice }
      },
      noToken: {
        ...market.tokens.find(t => (t.outcome || '').toLowerCase() === 'down' || (t.outcome || '').toLowerCase() === 'no') || market.tokens[1],
        price: { buy: signal.downPrice, sell: null, mid: signal.downPrice }
      },
      fetchedAt: new Date().toISOString()
    };

    const decision = {
      action: signal.action,
      confidence: signal.confidence,
      pattern: `[SCALP] ${signal.reason}`,
      reasoning: signal.reason
    };

    logger.addActivity('scalp_trade', {
      message: `SCALP TRADE: ${signal.action} at $${signal.entryPrice.toFixed(3)} | ${signal.secondsLeft}s left | $${tradeSize} bet | Payout: ${signal.payout}x`,
      coin: 'BTC',
      strategy: 'SCALP'
    });

    const trade = await executeTrade(decision, marketData, tradeSize);
    if (trade && trade.success) {
      safety.recordTrade(tradeSize);
      safety.markTraded('BTC', windowKey, signal.side, 0);

      logger.addActivity('trade_success', {
        message: `SCALP PLACED: ${signal.action} $${tradeSize} at $${trade.price?.toFixed(3)} | ${signal.secondsLeft}s left | Window: ${market.question}`,
        coin: 'BTC',
        strategy: 'SCALP'
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

      consecutiveErrors = 0;
    }
  } catch (err) {
    consecutiveErrors++;
    logger.addActivity('error', { message: `Bot error: ${err.message}` });
    if (consecutiveErrors > 10) {
      logger.addActivity('error', { message: `${consecutiveErrors} consecutive errors. Check configuration.` });
    }
  }

  try { await redeemer.checkAndRedeem(); } catch (err) {}
}

async function start() {
  if (isRunning) {
    logger.addActivity('bot', { message: 'Bot is already running' });
    return;
  }

  isRunning = true;
  safety.reload();

  const interval = (parseInt(process.env.SCAN_INTERVAL) || 5) * 1000;
  const config = scalpSignal.getConfig();

  logger.addActivity('bot', {
    message: `Bot started — 5-MIN SCALP MODE\n` +
      `  Strategy: Buy winning side at $${config.minEntry}-$${config.maxEntry} when ${config.minSeconds}-${config.maxSeconds}s left\n` +
      `  Scan: every ${interval / 1000}s | Trade size: $${safety.maxTradeSize}\n` +
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
    lastSignalStatus,
    windowStatus: krakenFeed.getWindowStatus(),
    safety: safety.getStatus(),
    config: scalpSignal.getConfig()
  };
}

module.exports = { start, stop, getStatus, runOnce };
