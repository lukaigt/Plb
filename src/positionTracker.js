const logger = require('./logger');
const { getProxyWallet, getEoaAddress, buildClobAuthHeaders, placeSellOrder } = require('./trader');

const CLOB_API = 'https://clob.polymarket.com';

function getTakeProfitPct() {
  const raw = process.env.MM_TAKE_PROFIT_PCT;
  if (raw === undefined || raw === '') return 0.50;
  const n = parseFloat(raw);
  return isNaN(n) ? 0.50 : n;
}

const openPositions = [];
const closedPositions = [];

async function fetchWithTimeout(url, opts = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function fetchOrderStatus(orderId) {
  try {
    const headers = buildClobAuthHeaders('GET', `/orders/${orderId}`);
    if (!headers) return null;
    const res = await fetchWithTimeout(`${CLOB_API}/orders/${orderId}`, { headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchFillsForAddress(makerAddress) {
  try {
    const headers = buildClobAuthHeaders('GET', '/trades');
    if (!headers) return [];
    const url = `${CLOB_API}/trades?maker_address=${makerAddress}&limit=50`;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : (data.data || []);
  } catch {
    return [];
  }
}

function trackOrder(orderId, tokenId, side, bidPrice, postedSize, marketId, coin, type, market) {
  if (openPositions.find(p => p.orderId === orderId)) return;

  openPositions.push({
    orderId,
    tokenId,
    side,
    bidPrice,
    postedTokens: postedSize,
    filledTokens: 0,
    filledCost: 0,
    avgFillPrice: null,
    currentMid: null,
    unrealizedPnL: null,
    marketId,
    coin,
    type,
    market,
    status: 'open',
    addedAt: new Date().toISOString(),
    lastChecked: null,
    takeProfitSent: false,
    takeProfitAttempts: 0
  });
}

async function pollFills() {
  const pending = openPositions.filter(p => p.status === 'open' && !p.takeProfitSent);
  if (pending.length === 0) return;

  const makerAddr = getProxyWallet() || getEoaAddress();
  if (!makerAddr) return;

  let fills = [];
  try {
    fills = await fetchFillsForAddress(makerAddr);
  } catch {}

  const fillsByOrder = {};
  for (const fill of fills) {
    const oid = fill.makerOrderId || fill.orderId || fill.order_id;
    if (!oid) continue;
    if (!fillsByOrder[oid]) fillsByOrder[oid] = [];
    fillsByOrder[oid].push(fill);
  }

  for (const pos of pending) {
    pos.lastChecked = new Date().toISOString();
    const orderFills = fillsByOrder[pos.orderId] || [];

    if (orderFills.length > 0) {
      let totalFilledTokens = 0;
      let totalFilledCost = 0;
      for (const f of orderFills) {
        const qty = parseFloat(f.size || f.matched || 0);
        const px  = parseFloat(f.price || pos.bidPrice);
        totalFilledTokens += qty;
        totalFilledCost   += qty * px;
      }
      if (totalFilledTokens > 0) {
        pos.filledTokens  = totalFilledTokens;
        pos.filledCost    = totalFilledCost;
        pos.avgFillPrice  = totalFilledCost / totalFilledTokens;
        pos.status = 'filled';
        logger.addActivity('position_tracker', {
          message: `Fill detected: ${pos.coin}-${pos.type} ${pos.side} | ${totalFilledTokens.toFixed(2)} tokens @ avg $${pos.avgFillPrice.toFixed(3)}`
        });
      }
    } else {
      const orderData = await fetchOrderStatus(pos.orderId);
      if (orderData) {
        const filled = parseFloat(orderData.size_matched || orderData.matched || 0);
        if (filled > 0 && pos.filledTokens === 0) {
          pos.filledTokens  = filled;
          pos.filledCost    = filled * pos.bidPrice;
          pos.avgFillPrice  = pos.bidPrice;
          pos.status = 'filled';
        }
        if ((orderData.status === 'CANCELED' || orderData.status === 'CANCELLED') && pos.filledTokens === 0) {
          pos.status = 'cancelled';
        }
      }
    }
  }
}

async function checkTakeProfit(activeSessions) {
  const tpPct = getTakeProfitPct();
  if (tpPct <= 0) return;

  const filled = openPositions.filter(p => p.status === 'filled' && !p.takeProfitSent && p.filledTokens > 0);
  if (filled.length === 0) return;

  for (const pos of filled) {
    const session = activeSessions.find(s => s.market && s.market.id === pos.marketId);
    if (!session) continue;

    const upMid = session.lastMid;
    if (upMid === null || upMid === undefined) continue;

    const mid = pos.side === 'UP' ? upMid : (1 - upMid);

    pos.currentMid = mid;

    const entryPrice = pos.avgFillPrice || pos.bidPrice;
    const maxGain    = 1.0 - entryPrice;
    if (maxGain <= 0) continue;

    const currentGain = mid - entryPrice;
    pos.unrealizedPnL = parseFloat((currentGain * pos.filledTokens).toFixed(4));

    const ratio = currentGain / maxGain;

    if (ratio >= tpPct) {
      const sellPrice = Math.min(0.97, Math.round((mid - 0.01) * 100) / 100);
      const sellSize  = Math.max(0.01, parseFloat((pos.filledTokens * 0.95).toFixed(2)));

      logger.addActivity('take_profit', {
        message: `TAKE PROFIT: ${pos.coin}-${pos.type} ${pos.side} | entry=$${entryPrice.toFixed(3)} mid=$${mid.toFixed(3)} gain=${(ratio * 100).toFixed(0)}% ≥ ${(tpPct * 100).toFixed(0)}% threshold | selling ${sellSize} tokens @ $${sellPrice}`
      });

      const market   = pos.market || session.market;
      const negRisk  = market ? market.negRisk : true;
      const tickSize = market ? market.tickSize : '0.01';

      const result = await placeSellOrder(pos.tokenId, sellSize, sellPrice, negRisk, tickSize);

      if (result.success) {
        pos.takeProfitSent    = true;
        pos.takeProfitOrderId = result.orderId;
        pos.takeProfitPrice   = sellPrice;
        pos.status = 'take_profit_sent';
        closedPositions.unshift({ ...pos, closedAt: new Date().toISOString() });
        logger.addActivity('take_profit', {
          message: `SELL posted: ${pos.coin}-${pos.type} ${pos.side} @ $${sellPrice} | orderId: ${result.orderId?.slice(0, 12)}...`
        });
      } else {
        logger.addActivity('take_profit_error', {
          message: `SELL failed: ${pos.coin}-${pos.type} ${pos.side} — ${result.error?.slice(0, 60)}`
        });
        pos.takeProfitAttempts = (pos.takeProfitAttempts || 0) + 1;
        if (pos.takeProfitAttempts >= 3) {
          pos.takeProfitSent = true;
          pos.status = 'tp_failed';
        }
      }
    }
  }
}

function pruneOldPositions() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (let i = openPositions.length - 1; i >= 0; i--) {
    const p = openPositions[i];
    const age  = new Date(p.addedAt).getTime();
    const done = p.status === 'take_profit_sent' || p.status === 'cancelled' || p.status === 'tp_failed';
    if (age < cutoff || done) openPositions.splice(i, 1);
  }
}

function getOpenPositions() {
  const tpPct = getTakeProfitPct();
  return openPositions.map(p => ({
    orderId:        p.orderId?.slice(0, 12) + '...',
    tokenId:        p.tokenId?.slice(0, 10) + '...',
    side:           p.side,
    coin:           p.coin,
    type:           p.type,
    bidPrice:       p.bidPrice,
    filledTokens:   p.filledTokens,
    avgFillPrice:   p.avgFillPrice,
    currentMid:     p.currentMid,
    unrealizedPnL:  p.unrealizedPnL,
    status:         p.status,
    addedAt:        p.addedAt,
    lastChecked:    p.lastChecked,
    takeProfitPct:  tpPct
  }));
}

function getRecentClosed() {
  return closedPositions.slice(0, 20).map(p => ({
    side:          p.side,
    coin:          p.coin,
    type:          p.type,
    entryPrice:    p.avgFillPrice || p.bidPrice,
    exitPrice:     p.takeProfitPrice,
    filledTokens:  p.filledTokens,
    closedAt:      p.closedAt,
    status:        p.status
  }));
}

module.exports = { trackOrder, pollFills, checkTakeProfit, pruneOldPositions, getOpenPositions, getRecentClosed };
