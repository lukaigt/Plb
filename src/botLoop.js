const { scanAllCoins } = require('./scanner');
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
let lastMultiCoinStatus = {};
let consecutiveErrors = 0;

async function evaluateMarket(market) {
  const upToken = market.tokens.find(t => {
    const o = (t.outcome || '').toLowerCase();
    return o === 'up' || o === 'yes' || o === 'true';
  }) || market.tokens[0];

  const downToken = market.tokens.find(t => {
    const o = (t.outcome || '').toLowerCase();
    return o === 'down' || o === 'no' || o === 'false';
  }) || market.tokens[1];

  const gammaUp = upToken.price;
  const gammaDown = downToken.price;

  const [upClobPrice, downClobPrice] = await Promise.all([
    getMarketPrice(upToken.token_id),
    getMarketPrice(downToken.token_id)
  ]);

  const liveUpPrice = upClobPrice.buy || upClobPrice.mid || upClobPrice.sell;
  const liveDownPrice = downClobPrice.buy || downClobPrice.mid || downClobPrice.sell;

  if (liveUpPrice !== null && liveUpPrice !== undefined) {
    upToken.price = liveUpPrice;
  }
  if (liveDownPrice !== null && liveDownPrice !== undefined) {
    downToken.price = liveDownPrice;
  }

  logger.addActivity('price_check', {
    message: `[${market.coin}] Gamma: UP=$${gammaUp?.toFixed(3) || '?'} DOWN=$${gammaDown?.toFixed(3) || '?'} | CLOB: UP=$${liveUpPrice?.toFixed(3) || '?'} DOWN=$${liveDownPrice?.toFixed(3) || '?'} | ${market.secondsLeft}s left`
  });

  const signal = scalpSignal.evaluate(market);
  return { signal, market, liveUpPrice, liveDownPrice };
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

    const allMarkets = await scanAllCoins();

    if (allMarkets.length === 0) {
      logger.addActivity('scalp_watch', {
        message: `No active 5-min markets found across all coins. ${Math.round(secondsLeft)}s left.`
      });
      consecutiveErrors = 0;
      return;
    }

    const evaluationPromises = allMarkets
      .filter(m => {
        if (m.secondsLeft > scalpConfig.maxSeconds || m.secondsLeft < scalpConfig.minSeconds) {
          return false;
        }
        const windowKey = safety.getWindowKey(m.endTime);
        if (safety.hasTraded(m.coin, windowKey)) {
          return false;
        }
        return true;
      })
      .map(m => evaluateMarket(m));

    const results = await Promise.all(evaluationPromises);

    const readySignals = results.filter(r => r.signal.ready);
    lastMultiCoinStatus = {};
    for (const r of results) {
      lastMultiCoinStatus[r.market.coin] = {
        signal: r.signal,
        secondsLeft: r.market.secondsLeft,
        liveUpPrice: r.liveUpPrice,
        liveDownPrice: r.liveDownPrice
      };
    }

    if (readySignals.length === 0) {
      const skippedMarkets = allMarkets.filter(m => {
        const windowKey = safety.getWindowKey(m.endTime);
        return safety.hasTraded(m.coin, windowKey);
      });
      if (skippedMarkets.length > 0) {
        for (const m of skippedMarkets) {
          lastMultiCoinStatus[m.coin] = lastMultiCoinStatus[m.coin] || { signal: { ready: false, reason: 'Already traded this window' }, secondsLeft: m.secondsLeft };
        }
      }

      if (results.length > 0) {
        lastSignalStatus = results[0].signal;
      }
      consecutiveErrors = 0;
      return;
    }

    readySignals.sort((a, b) => b.signal.entryPrice - a.signal.entryPrice);

    if (readySignals.length > 1) {
      const coinList = readySignals.map(r => `${r.market.coin}@$${r.signal.entryPrice.toFixed(3)}`).join(', ');
      logger.addActivity('scalp_multi', {
        message: `${readySignals.length} COINS QUALIFY — trading ALL: ${coinList}`
      });
    }

    for (const { signal, market } of readySignals) {
      const canStillTrade = safety.canTrade();
      if (!canStillTrade.allowed) {
        logger.addActivity('safety_block', { message: `Cannot trade: ${canStillTrade.reason}` });
        break;
      }

      const windowKey = safety.getWindowKey(market.endTime);
      if (safety.hasTraded(market.coin, windowKey)) {
        logger.addActivity('scalp_skip', {
          message: `[${market.coin}] Already traded this window (${windowKey}). Skipping.`
        });
        continue;
      }

      lastSignalStatus = signal;

      const tradeSize = safety.getTradeSize(signal.confidence);
      if (tradeSize <= 0) {
        logger.addActivity('safety_block', { message: `[${market.coin}] Trade size too small after safety checks` });
        continue;
      }

      const isYes = signal.action === 'BUY_YES';
      const token = isYes
        ? market.tokens.find(t => (t.outcome || '').toLowerCase() === 'up' || (t.outcome || '').toLowerCase() === 'yes') || market.tokens[0]
        : market.tokens.find(t => (t.outcome || '').toLowerCase() === 'down' || (t.outcome || '').toLowerCase() === 'no') || market.tokens[1];

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
        message: `[${market.coin}] SCALP TRADE: ${signal.action} at $${signal.entryPrice.toFixed(3)} | ${signal.secondsLeft}s left | $${tradeSize} bet | Payout: ${signal.payout}x`,
        coin: market.coin,
        strategy: 'SCALP'
      });

      const trade = await executeTrade(decision, marketData, tradeSize);
      if (trade && trade.success) {
        safety.recordTrade(tradeSize);
        safety.markTraded(market.coin, windowKey, signal.side, 0);

        logger.addActivity('trade_success', {
          message: `[${market.coin}] SCALP PLACED: ${signal.action} $${tradeSize} at $${trade.price?.toFixed(3)} | ${signal.secondsLeft}s left | ${market.question}`,
          coin: market.coin,
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
      }
    }

    consecutiveErrors = 0;
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
  const { COINS } = require('./scanner');

  logger.addActivity('bot', {
    message: `Bot started — MULTI-COIN 5-MIN SCALP MODE\n` +
      `  Coins: ${COINS.join(', ')}\n` +
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
    multiCoinStatus: lastMultiCoinStatus,
    windowStatus: krakenFeed.getWindowStatus(),
    safety: safety.getStatus(),
    config: scalpSignal.getConfig()
  };
}

module.exports = { start, stop, getStatus, runOnce };
