const logger = require('./logger');

const MIN_ENTRY_PRICE = parseFloat(process.env.MIN_ENTRY_PRICE) || 0.88;
const MAX_ENTRY_PRICE = parseFloat(process.env.MAX_ENTRY_PRICE) || 0.95;
const SCALP_MIN_SECONDS = parseInt(process.env.SCALP_MIN_SECONDS) || 30;
const SCALP_MAX_SECONDS = parseInt(process.env.SCALP_MAX_SECONDS) || 90;

let lastSignal = null;

function evaluate(market) {
  if (!market) {
    lastSignal = {
      ready: false,
      reason: 'No active 5-min market found',
      timestamp: Date.now()
    };
    return lastSignal;
  }

  const secondsLeft = market.secondsLeft;

  if (secondsLeft > SCALP_MAX_SECONDS) {
    lastSignal = {
      ready: false,
      reason: `Too early: ${secondsLeft}s left (need ${SCALP_MIN_SECONDS}-${SCALP_MAX_SECONDS}s)`,
      secondsLeft,
      timestamp: Date.now()
    };
    return lastSignal;
  }

  if (secondsLeft < SCALP_MIN_SECONDS) {
    lastSignal = {
      ready: false,
      reason: `Too late: ${secondsLeft}s left (need ${SCALP_MIN_SECONDS}s+)`,
      secondsLeft,
      timestamp: Date.now()
    };
    return lastSignal;
  }

  const upToken = market.tokens.find(t => {
    const o = (t.outcome || '').toLowerCase();
    return o === 'up' || o === 'yes' || o === 'true';
  }) || market.tokens[0];

  const downToken = market.tokens.find(t => {
    const o = (t.outcome || '').toLowerCase();
    return o === 'down' || o === 'no' || o === 'false';
  }) || market.tokens[1];

  const upPrice = upToken?.price;
  const downPrice = downToken?.price;

  if (upPrice === null || downPrice === null || upPrice === undefined || downPrice === undefined) {
    lastSignal = {
      ready: false,
      reason: 'Token prices not available from market data',
      secondsLeft,
      timestamp: Date.now()
    };
    return lastSignal;
  }

  let targetToken = null;
  let targetSide = null;
  let targetPrice = null;
  let otherPrice = null;

  if (upPrice >= MIN_ENTRY_PRICE && upPrice <= MAX_ENTRY_PRICE) {
    targetToken = upToken;
    targetSide = 'UP';
    targetPrice = upPrice;
    otherPrice = downPrice;
  } else if (downPrice >= MIN_ENTRY_PRICE && downPrice <= MAX_ENTRY_PRICE) {
    targetToken = downToken;
    targetSide = 'DOWN';
    targetPrice = downPrice;
    otherPrice = upPrice;
  }

  if (!targetToken) {
    let reason = '';
    if (upPrice > MAX_ENTRY_PRICE || downPrice > MAX_ENTRY_PRICE) {
      reason = `Prices too high: UP=$${upPrice.toFixed(3)}, DOWN=$${downPrice.toFixed(3)} (max $${MAX_ENTRY_PRICE})`;
    } else if (upPrice < MIN_ENTRY_PRICE && downPrice < MIN_ENTRY_PRICE) {
      reason = `No clear leader: UP=$${upPrice.toFixed(3)}, DOWN=$${downPrice.toFixed(3)} (need $${MIN_ENTRY_PRICE}+)`;
    } else {
      reason = `Prices outside range: UP=$${upPrice.toFixed(3)}, DOWN=$${downPrice.toFixed(3)} (need $${MIN_ENTRY_PRICE}-$${MAX_ENTRY_PRICE})`;
    }

    lastSignal = {
      ready: false,
      reason,
      secondsLeft,
      upPrice,
      downPrice,
      timestamp: Date.now()
    };
    return lastSignal;
  }

  const payout = 1.0 / targetPrice;
  const profitPerDollar = payout - 1;
  const confidence = targetPrice >= 0.92 ? 'HIGH' : 'MEDIUM';

  lastSignal = {
    ready: true,
    side: targetSide,
    action: targetSide === 'UP' ? 'BUY_YES' : 'BUY_NO',
    tokenId: targetToken.token_id,
    entryPrice: targetPrice,
    otherPrice,
    upPrice,
    downPrice,
    secondsLeft,
    confidence,
    payout: payout.toFixed(3),
    profitPerDollar: profitPerDollar.toFixed(3),
    reason: `SCALP ${targetSide}: $${targetPrice.toFixed(3)} with ${secondsLeft}s left (payout ${payout.toFixed(2)}x)`,
    market,
    timestamp: Date.now()
  };

  logger.addActivity('scalp_signal', {
    message: `SCALP READY: BUY ${targetSide} at $${targetPrice.toFixed(3)} | ${secondsLeft}s left | Payout: ${payout.toFixed(2)}x | Confidence: ${confidence}`,
    coin: 'BTC'
  });

  return lastSignal;
}

function getLastSignal() {
  return lastSignal;
}

function getConfig() {
  return {
    minEntry: MIN_ENTRY_PRICE,
    maxEntry: MAX_ENTRY_PRICE,
    minSeconds: SCALP_MIN_SECONDS,
    maxSeconds: SCALP_MAX_SECONDS,
    strategy: '5-Min End-of-Window Scalper'
  };
}

module.exports = { evaluate, getLastSignal, getConfig };
