const krakenFeed = require('./krakenFeed');
const logger = require('./logger');

const SPIKE_THRESHOLD = parseFloat(process.env.SPIKE_THRESHOLD) || 30;
const MIN_SPIKE_SPEED = parseFloat(process.env.MIN_SPIKE_SPEED) || 15;

let lastSpikeResult = null;
let lastFadeSignal = null;

function detect() {
  const ctx = krakenFeed.getPriceContext();

  if (!ctx.available) {
    lastSpikeResult = {
      detected: false,
      reason: 'No BTC price data available',
      btcPrice: null,
      direction: null,
      magnitude: null,
      speed: null,
      timestamp: Date.now()
    };
    return lastSpikeResult;
  }

  const windows = [
    { label: '1m', data: ctx.change1m, seconds: 60 },
    { label: '3m', data: ctx.change3m, seconds: 180 },
    { label: '5m', data: ctx.change5m, seconds: 300 }
  ];

  let bestSpike = null;

  for (const w of windows) {
    if (!w.data) continue;

    const moveDollars = parseFloat(w.data.dollars);
    const absMoveD = Math.abs(moveDollars);
    const speed = absMoveD / (w.seconds / 60);

    if (absMoveD >= SPIKE_THRESHOLD && speed >= MIN_SPIKE_SPEED) {
      if (!bestSpike || speed > bestSpike.speed) {
        bestSpike = {
          window: w.label,
          moveDollars,
          absMoveD,
          speed,
          direction: moveDollars > 0 ? 'UP' : 'DOWN',
          percent: w.data.percent
        };
      }
    }
  }

  if (bestSpike) {
    const spikeDirection = bestSpike.direction;
    const fadeDirection = spikeDirection === 'UP' ? 'DOWN' : 'UP';
    const fadeAction = spikeDirection === 'UP' ? 'BUY_NO' : 'BUY_YES';
    const followAction = spikeDirection === 'UP' ? 'BUY_YES' : 'BUY_NO';

    const isDecelerating = ctx.momentum === 'DECELERATING';
    const isAccelerating = ctx.momentum === 'ACCELERATING';

    let fadeConfidence = 'MEDIUM';
    if (bestSpike.speed >= 60 && isDecelerating) {
      fadeConfidence = 'HIGH';
    } else if (bestSpike.speed >= 40 && isDecelerating) {
      fadeConfidence = 'HIGH';
    } else if (isAccelerating) {
      fadeConfidence = 'LOW';
    }

    lastSpikeResult = {
      detected: true,
      reason: `BTC spiked ${spikeDirection} $${bestSpike.moveDollars > 0 ? '+' : ''}${bestSpike.moveDollars} in ${bestSpike.window} ($${bestSpike.speed.toFixed(0)}/min) — FADE to ${fadeDirection}`,
      btcPrice: ctx.currentPrice,
      spikeDirection,
      direction: fadeDirection,
      action: fadeAction,
      followAction,
      magnitude: bestSpike.absMoveD,
      speed: bestSpike.speed,
      window: bestSpike.window,
      percent: bestSpike.percent,
      confidence: fadeConfidence,
      momentum: ctx.momentum,
      isDecelerating,
      isAccelerating,
      strategy: 'FADE',
      timestamp: Date.now()
    };

    lastFadeSignal = lastSpikeResult;

    logger.addActivity('spike_detected', {
      message: `SPIKE ${spikeDirection} $${bestSpike.moveDollars > 0 ? '+' : ''}${bestSpike.moveDollars} in ${bestSpike.window} | Speed: $${bestSpike.speed.toFixed(0)}/min | Momentum: ${ctx.momentum} | FADE → ${fadeAction}`,
      coin: 'BTC'
    });

    return lastSpikeResult;
  }

  const change1mVal = ctx.change1m ? Math.abs(parseFloat(ctx.change1m.dollars)) : 0;
  const change3mVal = ctx.change3m ? Math.abs(parseFloat(ctx.change3m.dollars)) : 0;

  let skipReason = 'No significant BTC move';
  if (change1mVal > 0 || change3mVal > 0) {
    skipReason = `BTC move too small: $${change1mVal.toFixed(0)} in 1m, $${change3mVal.toFixed(0)} in 3m (need $${SPIKE_THRESHOLD}+)`;
  }

  lastSpikeResult = {
    detected: false,
    reason: skipReason,
    btcPrice: ctx.currentPrice,
    direction: ctx.direction,
    magnitude: change1mVal,
    speed: change1mVal,
    momentum: ctx.momentum,
    timestamp: Date.now()
  };

  return lastSpikeResult;
}

function getLastResult() {
  return lastSpikeResult;
}

function getLastFadeSignal() {
  return lastFadeSignal;
}

function getConfig() {
  return {
    threshold: SPIKE_THRESHOLD,
    windows: '1m, 3m, 5m',
    minSpeed: MIN_SPIKE_SPEED,
    strategy: 'FADE (mean reversion)'
  };
}

module.exports = { detect, getLastResult, getLastFadeSignal, getConfig };
