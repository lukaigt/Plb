const { Side, OrderType } = require('@polymarket/clob-client');
const logger = require('./logger');

const CLOB_API = 'https://clob.polymarket.com';

async function fetchMidpoint(tokenId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${CLOB_API}/midpoint?token_id=${tokenId}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data.mid ? parseFloat(data.mid) : null;
  } catch {
    return null;
  }
}

class MarketSession {
  constructor(market, config) {
    this.market  = market;
    this.config  = config;
    this.ordersPosted   = 0;
    this.estimatedFills = 0;
    this.totalSpent     = 0;
    this.phase          = 'active';
    this.lastMid        = null;
    this.lastQuoteTime  = null;
    this.openOrderIds   = [];
    this.cancelled      = false;
  }

  get marketId() { return this.market.id; }
  get secondsLeft() {
    return Math.max(0, (this.market.endTime - Date.now()) / 1000);
  }

  isClosing() {
    return this.secondsLeft <= this.config.closeSeconds;
  }

  isTooEarly() {
    return this.secondsLeft > this.config.maxSeconds;
  }

  async postQuotes(client) {
    const mid = await fetchMidpoint(this.market.upTokenId);
    if (mid === null || mid <= 0 || mid >= 1) {
      logger.addActivity('mm_skip', {
        message: `[${this.market.coin}-${this.market.type}] No valid midpoint (got ${mid}), skipping`
      });
      return;
    }

    this.lastMid = mid;
    this.lastQuoteTime = new Date().toISOString();

    if (!client) {
      logger.addActivity('mm_skip', {
        message: `[${this.market.coin}-${this.market.type}] No CLOB client — mid=$${mid.toFixed(3)} | Set WALLET_PRIVATE_KEY + POLY_API_KEY to trade`
      });
      return;
    }

    const halfSpread = this.config.spread / 2;
    const bidUp   = Math.round((mid - halfSpread) * 100) / 100;
    const bidDown = Math.round(((1 - mid) - halfSpread) * 100) / 100;
    const orderSize = this.config.orderSize;

    if (bidUp < 0.02 || bidDown < 0.02 || bidUp > 0.97 || bidDown > 0.97) {
      logger.addActivity('mm_skip', {
        message: `[${this.market.coin}-${this.market.type}] Bids out of range (UP bid=$${bidUp}, DOWN bid=$${bidDown}), skipping`
      });
      return;
    }

    const label = `[${this.market.coin}-${this.market.type}]`;

    logger.addActivity('mm_quote', {
      message: `${label} Quoting — mid=$${mid.toFixed(3)} | BUY UP@$${bidUp} | BUY DOWN@$${bidDown} | size=$${orderSize} | ${Math.round(this.secondsLeft)}s left`
    });

    const placed = [];

    try {
      const upSizeTokens = parseFloat((orderSize / bidUp).toFixed(2));
      const upOrder = await client.createAndPostOrder(
        {
          tokenID: this.market.upTokenId,
          price: bidUp,
          size: upSizeTokens,
          side: Side.BUY,
          feeRateBps: 0,
          expiration: 0,
          taker: '0x0000000000000000000000000000000000000000'
        },
        { tickSize: this.market.tickSize, negRisk: this.market.negRisk },
        OrderType.GTC
      );

      if (upOrder && upOrder.orderID) {
        placed.push({ orderId: upOrder.orderID, side: 'UP', price: bidUp, size: upSizeTokens });
        this.ordersPosted++;
        this.totalSpent += orderSize;
      } else {
        const errMsg = upOrder?.errorMsg || upOrder?.error || JSON.stringify(upOrder)?.slice(0, 80);
        logger.addActivity('mm_error', { message: `${label} UP order failed: ${errMsg}` });
      }
    } catch (err) {
      logger.addActivity('mm_error', { message: `${label} UP order error: ${err.message?.slice(0, 80)}` });
    }

    try {
      const downSizeTokens = parseFloat((orderSize / bidDown).toFixed(2));
      const downOrder = await client.createAndPostOrder(
        {
          tokenID: this.market.downTokenId,
          price: bidDown,
          size: downSizeTokens,
          side: Side.BUY,
          feeRateBps: 0,
          expiration: 0,
          taker: '0x0000000000000000000000000000000000000000'
        },
        { tickSize: this.market.tickSize, negRisk: this.market.negRisk },
        OrderType.GTC
      );

      if (downOrder && downOrder.orderID) {
        placed.push({ orderId: downOrder.orderID, side: 'DOWN', price: bidDown, size: downSizeTokens });
        this.ordersPosted++;
        this.totalSpent += orderSize;
      } else {
        const errMsg = downOrder?.errorMsg || downOrder?.error || JSON.stringify(downOrder)?.slice(0, 80);
        logger.addActivity('mm_error', { message: `${label} DOWN order failed: ${errMsg}` });
      }
    } catch (err) {
      logger.addActivity('mm_error', { message: `${label} DOWN order error: ${err.message?.slice(0, 80)}` });
    }

    if (placed.length > 0) {
      this.openOrderIds.push(...placed.map(p => p.orderId));
      logger.addActivity('mm_placed', {
        message: `${label} Posted ${placed.length} order(s): ${placed.map(p => `${p.side}@$${p.price}`).join(', ')}`
      });
    }
  }

  async fetchMidpointOnly() {
    const mid = await fetchMidpoint(this.market.upTokenId);
    if (mid !== null && mid > 0 && mid < 1) {
      this.lastMid = mid;
      this.lastQuoteTime = new Date().toISOString();
    }
  }

  async cancelOpenOrders(client) {
    if (!client || this.openOrderIds.length === 0) {
      this.openOrderIds = [];
      return;
    }
    try {
      await client.cancelMarketOrders({ asset_id: this.market.upTokenId });
      await client.cancelMarketOrders({ asset_id: this.market.downTokenId });
    } catch (err) {
      logger.addActivity('mm_error', {
        message: `[${this.market.coin}-${this.market.type}] Cancel error: ${err.message?.slice(0, 60)}`
      });
    }
    this.openOrderIds = [];
  }

  getStatus() {
    const mid    = this.lastMid;
    const spread = this.config.spread;
    const rawBidUp   = mid !== null ? Math.round((mid - spread / 2) * 100) / 100 : null;
    const rawBidDown = mid !== null ? Math.round(((1 - mid) - spread / 2) * 100) / 100 : null;
    const bidsValid  = rawBidUp !== null && rawBidUp >= 0.02 && rawBidUp <= 0.97
                    && rawBidDown >= 0.02 && rawBidDown <= 0.97;
    return {
      marketId:       this.marketId,
      coin:           this.market.coin,
      type:           this.market.type,
      secondsLeft:    Math.round(this.secondsLeft),
      phase:          this.isClosing() ? 'closing' : this.isTooEarly() ? 'waiting' : 'quoting',
      lastMid:        mid,
      bidUp:          bidsValid ? rawBidUp   : null,
      bidDown:        bidsValid ? rawBidDown : null,
      bidsValid,
      lastQuoteTime:  this.lastQuoteTime,
      ordersPosted:   this.ordersPosted,
      openOrderCount: this.openOrderIds.length,
      totalSpent:     parseFloat(this.totalSpent.toFixed(2)),
      question:       this.market.question,
      slug:           this.market.slug,
      endTime:        this.market.endTime
    };
  }
}

function getMMConfig() {
  return {
    spread:       parseFloat(process.env.MM_SPREAD)       || 0.06,
    orderSize:    parseFloat(process.env.MM_ORDER_SIZE)   || 10,
    closeSeconds: parseInt(process.env.MM_CLOSE_SECONDS)  || 20,
    maxSeconds:   parseInt(process.env.MM_MAX_SECONDS)    || 240,
    refreshInterval: parseInt(process.env.MM_REFRESH_INTERVAL) || 10
  };
}

module.exports = { MarketSession, getMMConfig };
