const { Side, OrderType } = require('@polymarket/clob-client');
const krakenFeed = require('./krakenFeed');
const logger = require('./logger');
const { placeSellOrder, buildClobAuthHeaders } = require('./trader');

const CLOB_API = 'https://clob.polymarket.com';

function getMomentumConfig() {
  return {
    orderSize:         parseFloat(process.env.MOM_ORDER_SIZE)        || 10,
    takeProfitCents:   parseFloat(process.env.MOM_TAKE_PROFIT)       || 0.12,
    stopLossCents:     parseFloat(process.env.MOM_STOP_LOSS)         || 0.12,
    momentumThreshold: parseFloat(process.env.MOM_THRESHOLD)         || 0.05,
    midMin:            parseFloat(process.env.MOM_MID_MIN)           || 0.35,
    midMax:            parseFloat(process.env.MOM_MID_MAX)           || 0.65,
    entryAfterSeconds: parseInt(process.env.MOM_ENTRY_AFTER_SECONDS) || 180,
    closeSeconds:      parseInt(process.env.MOM_CLOSE_SECONDS)       || 30,
    refreshInterval:   parseInt(process.env.MM_REFRESH_INTERVAL)     || 10,
    marketType:        process.env.MOM_MARKET_TYPE                   || '15m'
  };
}

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

async function fetchOrderStatus(orderId) {
  try {
    const headers = buildClobAuthHeaders('GET', `/orders/${orderId}`);
    if (!headers) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${CLOB_API}/orders/${orderId}`, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

class MomentumSession {
  constructor(market, config) {
    this.market = market;
    this.config = config;

    this.phase          = 'waiting';
    this.signal         = null;
    this.tokenId        = null;
    this.entryPrice     = null;
    this.entrySizeTokens = null;
    this.entryOrderId   = null;
    this.entryFilled    = false;
    this.filledSize     = null;
    this.sellOrderId    = null;
    this.takeProfitPrice = null;
    this.stopLossPrice  = null;
    this.exitPrice      = null;
    this.pnl            = null;
    this.totalSpent     = 0;
    this.cancelled      = false;
    this.lastMid        = null;
    this.entryAttempted = false;
    this.tradeIds       = [];
    this.btcChange3m    = null;
  }

  get marketId()    { return this.market.id; }
  get secondsLeft() { return Math.max(0, (this.market.endTime - Date.now()) / 1000); }

  isClosing()  { return this.secondsLeft <= this.config.closeSeconds; }
  isTooEarly() {
    const total = this.market.intervalSeconds || 900;
    return this.secondsLeft > (total - this.config.entryAfterSeconds);
  }

  getSignal() {
    const ctx = krakenFeed.getPriceContext();
    if (!ctx.available || !ctx.change3m) return null;
    const change3m = parseFloat(ctx.change3m.percent);
    this.btcChange3m = change3m;
    if (change3m >= this.config.momentumThreshold)  return 'UP';
    if (change3m <= -this.config.momentumThreshold) return 'DOWN';
    return null;
  }

  async attemptEntry(client) {
    if (this.entryAttempted) return;
    this.entryAttempted = true;

    if (!client) {
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] No CLOB client — set WALLET_PRIVATE_KEY + POLY_API_KEY`
      });
      this.phase = 'no_signal';
      return;
    }

    const signal = this.getSignal();
    if (!signal) {
      const ctx = krakenFeed.getPriceContext();
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] No momentum signal — BTC 3m change: ${ctx.change3m?.percent || '?'}% (need ±${this.config.momentumThreshold}%) | skipping`
      });
      this.phase = 'no_signal';
      return;
    }

    const tokenId = signal === 'UP' ? this.market.upTokenId : this.market.downTokenId;
    const mid = await fetchMidpoint(tokenId);

    if (mid === null) {
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] Could not fetch midpoint — skipping`
      });
      this.phase = 'no_signal';
      return;
    }

    this.lastMid = mid;

    if (mid < this.config.midMin || mid > this.config.midMax) {
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] Signal=${signal} but mid=$${mid.toFixed(3)} outside [${this.config.midMin}–${this.config.midMax}] — token already priced in, skipping`
      });
      this.phase = 'no_signal';
      return;
    }

    const entryPrice     = Math.round(mid * 100) / 100;
    const sizeTokens     = parseFloat((this.config.orderSize / entryPrice).toFixed(2));
    const takeProfitPrice = Math.min(0.97, Math.round((entryPrice + this.config.takeProfitCents) * 100) / 100);
    const stopLossPrice   = Math.max(0.02, Math.round((entryPrice - this.config.stopLossCents) * 100) / 100);

    const ctx = krakenFeed.getPriceContext();
    logger.addActivity('mom_signal', {
      message: `[${this.market.coin}-${this.market.type}] SIGNAL: ${signal} | BTC 3m: ${ctx.change3m?.percent}% | mid=$${mid.toFixed(3)} | buying ${sizeTokens} tokens @ $${entryPrice} | TP=$${takeProfitPrice} | SL=$${stopLossPrice} | ${Math.round(this.secondsLeft)}s left`
    });

    this.signal          = signal;
    this.tokenId         = tokenId;
    this.entryPrice      = entryPrice;
    this.entrySizeTokens = sizeTokens;
    this.takeProfitPrice = takeProfitPrice;
    this.stopLossPrice   = stopLossPrice;
    this.phase           = 'entering';

    try {
      const order = await client.createAndPostOrder(
        {
          tokenID:     tokenId,
          price:       entryPrice,
          size:        sizeTokens,
          side:        Side.BUY,
          feeRateBps:  1000,
          expiration:  0,
          taker:       '0x0000000000000000000000000000000000000000'
        },
        { tickSize: this.market.tickSize, negRisk: this.market.negRisk },
        OrderType.GTC
      );

      if (order && order.orderID) {
        this.entryOrderId = order.orderID;
        this.totalSpent  += this.config.orderSize;
        logger.addActivity('mom_entry', {
          message: `[${this.market.coin}-${this.market.type}] BUY ${signal} posted @ $${entryPrice} | ${sizeTokens} tokens | orderId: ${order.orderID.slice(0, 14)}...`
        });
      } else {
        const err = order?.errorMsg || order?.error || JSON.stringify(order)?.slice(0, 60);
        logger.addActivity('mom_error', { message: `[${this.market.coin}-${this.market.type}] BUY failed: ${err}` });
        this.phase = 'no_signal';
      }
    } catch (err) {
      logger.addActivity('mom_error', { message: `[${this.market.coin}-${this.market.type}] BUY error: ${err.message?.slice(0, 80)}` });
      this.phase = 'no_signal';
    }
  }

  async checkEntryFill() {
    if (!this.entryOrderId || this.entryFilled) return;

    const status = await fetchOrderStatus(this.entryOrderId);
    if (!status) return;

    const matched = parseFloat(status.size_matched || 0);
    if (matched > 0) {
      this.entryFilled = true;
      this.filledSize  = matched;
      this.phase       = 'managing';
      logger.addActivity('mom_filled', {
        message: `[${this.market.coin}-${this.market.type}] BUY FILLED — ${this.signal} ${matched} tokens @ $${this.entryPrice} | posting SELL @ $${this.takeProfitPrice}`
      });
    } else if (status.status === 'CANCELED' || status.status === 'CANCELLED') {
      logger.addActivity('mom_error', { message: `[${this.market.coin}-${this.market.type}] Entry order cancelled` });
      this.phase = 'done';
    }
  }

  async postTakeProfitSell() {
    if (this.sellOrderId || !this.entryFilled || !this.filledSize) return;

    const result = await placeSellOrder(
      this.tokenId,
      this.filledSize,
      this.takeProfitPrice,
      this.market.negRisk,
      this.market.tickSize
    );

    if (result.success) {
      this.sellOrderId = result.orderId;
      logger.addActivity('mom_tp_posted', {
        message: `[${this.market.coin}-${this.market.type}] SELL posted @ $${this.takeProfitPrice} | orderId: ${result.orderId?.slice(0, 14)}...`
      });
    } else {
      logger.addActivity('mom_error', {
        message: `[${this.market.coin}-${this.market.type}] SELL post failed: ${result.error?.slice(0, 60)}`
      });
    }
  }

  async checkManaging(client) {
    if (!this.entryFilled || this.phase === 'done') return;

    const mid = await fetchMidpoint(this.tokenId);
    if (mid !== null) this.lastMid = mid;

    if (this.sellOrderId) {
      const status = await fetchOrderStatus(this.sellOrderId);
      if (status) {
        const matched = parseFloat(status.size_matched || 0);
        if (matched > 0) {
          this.pnl       = parseFloat(((this.takeProfitPrice - this.entryPrice) * matched).toFixed(4));
          this.exitPrice = this.takeProfitPrice;
          this.phase     = 'done';
          logger.addActivity('mom_tp_hit', {
            message: `[${this.market.coin}-${this.market.type}] TAKE PROFIT HIT! Sold ${matched} ${this.signal} @ $${this.takeProfitPrice} | P&L: +$${this.pnl.toFixed(3)}`
          });
          return;
        }
      }
    }

    if (mid !== null && mid <= this.stopLossPrice) {
      logger.addActivity('mom_sl', {
        message: `[${this.market.coin}-${this.market.type}] STOP LOSS — mid=$${mid.toFixed(3)} ≤ SL=$${this.stopLossPrice} | cutting loss`
      });

      if (this.sellOrderId && client) {
        try { await client.cancelOrder({ orderID: this.sellOrderId }); } catch {}
        this.sellOrderId = null;
      }

      const slSize = this.filledSize || this.entrySizeTokens;
      const result = await placeSellOrder(
        this.tokenId,
        slSize,
        this.stopLossPrice,
        this.market.negRisk,
        this.market.tickSize
      );

      this.pnl       = parseFloat(((this.stopLossPrice - this.entryPrice) * slSize).toFixed(4));
      this.exitPrice = this.stopLossPrice;
      this.phase     = 'done';

      if (result.success) {
        logger.addActivity('mom_sl', {
          message: `[${this.market.coin}-${this.market.type}] Stop loss sell @ $${this.stopLossPrice} | Est P&L: $${this.pnl.toFixed(3)}`
        });
      }
    }
  }

  async handleClosingPhase(client) {
    if (this.cancelled) return;
    this.cancelled = true;

    if (this.sellOrderId && client) {
      try { await client.cancelOrder({ orderID: this.sellOrderId }); } catch {}
      this.sellOrderId = null;
      if (this.entryFilled) {
        logger.addActivity('mom_close', {
          message: `[${this.market.coin}-${this.market.type}] Closing — cancelled sell, holding ${this.signal} to resolution`
        });
      }
    }

    if (!this.entryFilled && this.entryOrderId && client) {
      try { await client.cancelOrder({ orderID: this.entryOrderId }); } catch {}
      logger.addActivity('mom_close', {
        message: `[${this.market.coin}-${this.market.type}] Closing — cancelled unfilled entry`
      });
    }
  }

  getStatus() {
    const unrealizedPnL = (this.lastMid !== null && this.entryFilled && this.filledSize && this.phase !== 'done')
      ? parseFloat(((this.lastMid - this.entryPrice) * this.filledSize).toFixed(4))
      : null;

    return {
      marketId:        this.marketId,
      coin:            this.market.coin,
      type:            this.market.type,
      secondsLeft:     Math.round(this.secondsLeft),
      phase:           this.phase,
      signal:          this.signal,
      lastMid:         this.lastMid,
      btcChange3m:     this.btcChange3m,
      entryPrice:      this.entryPrice,
      takeProfitPrice: this.takeProfitPrice,
      stopLossPrice:   this.stopLossPrice,
      entryFilled:     this.entryFilled,
      filledSize:      this.filledSize,
      unrealizedPnL,
      pnl:             this.pnl,
      exitPrice:       this.exitPrice,
      totalSpent:      this.totalSpent,
      question:        this.market.question,
      endTime:         this.market.endTime
    };
  }
}

module.exports = { MomentumSession, getMomentumConfig, fetchMidpoint };
