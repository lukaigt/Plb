const krakenFeed = require('./krakenFeed');
const logger = require('./logger');

const SPIKE_THRESHOLD = parseFloat(process.env.SPIKE_THRESHOLD) || 30;
const MIN_SPIKE_SPEED = parseFloat(process.env.MIN_SPIKE_SPEED) || 15;

let lastSpikeResult = null;

function detect() {
  const ctx = krakenFeed.getPriceContext();
  const windowStatus = krakenFeed.getWindowStatus();

  if (!ctx.available) {
    lastSpikeResult = {
      detected: false,
      reason: 'No BTC price data available',
      btcPrice: null,
      direction: null,
      magnitude: null,
      speed: null,
      crossedOpen: false,
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
    const crossedOpen = windowStatus.crossedOpen || false;
    const preSpikeeSide = windowStatus.preSpikeeSide || null;

    const isDecelerating = ctx.momentum === 'DECELERATING';
    const isAccelerating = ctx.momentum === 'ACCELERATING';

    let confidence = 'MEDIUM';
    if (crossedOpen && isDecelerating) {
      confidence = 'HIGH';
    } else if (crossedOpen && !isAccelerating) {
      confidence = 'MEDIUM';
    } else if (isAccelerating) {
      confidence = 'LOW';
    } else if (!crossedOpen) {
      confidence = 'LOW';
    }

    const fadeAction = preSpikeeSide === 'UP' ? 'BUY_YES' : 'BUY_NO';
    const fadeDirection = preSpikeeSide === 'UP' ? 'UP' : 'DOWN';

    lastSpikeResult = {
      detected: true,
      reason: `BTC spiked ${spikeDirection} $${bestSpike.moveDollars > 0 ? '+' : ''}${bestSpike.moveDollars} in ${bestSpike.window} ($${bestSpike.speed.toFixed(0)}/min)${crossedOpen ? ' — CROSSED OPENING PRICE' : ' — did not cross opening'}`,
      btcPrice: ctx.currentPrice,
      spikeDirection,
      direction: fadeDirection,
      action: fadeAction,
      magnitude: bestSpike.absMoveD,
      speed: bestSpike.speed,
      window: bestSpike.window,
      percent: bestSpike.percent,
      confidence,
      momentum: ctx.momentum,
      isDecelerating,
      isAccelerating,
      crossedOpen,
      preSpikeeSide,
      strategy: 'CROSS_OPEN_FADE',
      timestamp: Date.now()
    };

    const logType = crossedOpen ? 'spike_crossopen' : 'spike_detected';
    logger.addActivity(logType, {
      message: `SPIKE ${spikeDirection} $${bestSpike.moveDollars > 0 ? '+' : ''}${bestSpike.moveDollars} in ${bestSpike.window} | Speed: $${bestSpike.speed.toFixed(0)}/min | Momentum: ${ctx.momentum} | Cross-Open: ${crossedOpen ? 'YES → FADE ' + fadeAction : 'NO (skip)'}`,
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
    crossedOpen: false,
    timestamp: Date.now()
  };

  return lastSpikeResult;
}

function getLastResult() {
  return lastSpikeResult;
}

function getConfig() {
  return {
    threshold: SPIKE_THRESHOLD,
    windows: '1m, 3m, 5m',
    minSpeed: MIN_SPIKE_SPEED,
    strategy: 'Cross-Open Fade + Late Contrarian'
  };
}

module.exports = { detect, getLastResult, getConfig };
