const { Side, OrderType } = require('@polymarket/clob-client');
const krakenFeed = require('./krakenFeed');
const logger = require('./logger');
const { placeSellOrder, buildClobAuthHeaders } = require('./trader');

const CLOB_API = 'https://clob.polymarket.com';

function getMomentumConfig() {
  return {
    orderSize:         parseFloat(process.env.MOM_ORDER_SIZE)         || 10,
    trailingStop:      parseFloat(process.env.MOM_TRAILING_STOP)      || 0.02,
    trailingActivate:  parseFloat(process.env.MOM_TRAILING_ACTIVATE)  || 0.01,
    stopLossCents:     parseFloat(process.env.MOM_STOP_LOSS)          || 0.12,
    momentumThreshold: parseFloat(process.env.MOM_THRESHOLD)          || 0.05,
    midMin:            parseFloat(process.env.MOM_MID_MIN)            || 0.35,
    midMax:            parseFloat(process.env.MOM_MID_MAX)            || 0.65,
    entryAfterSeconds: parseInt(process.env.MOM_ENTRY_AFTER_SECONDS)  || 180,
    closeSeconds:      parseInt(process.env.MOM_CLOSE_SECONDS)        || 30,
    refreshInterval:   parseInt(process.env.MM_REFRESH_INTERVAL)      || 10,
    marketType:        process.env.MOM_MARKET_TYPE                    || '15m',
    maxFlips:          parseInt(process.env.MOM_MAX_FLIPS)            || 3,
    flipMinSeconds:    parseInt(process.env.MOM_FLIP_MIN_SECONDS)     || 45
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

async function fetchOrderStatusRaw(orderId) {
  try {
    const headers = buildClobAuthHeaders('GET', `/orders/${orderId}`);
    if (!headers) {
      logger.addActivity('fill_debug', { message: `[fetchOrderStatus] No auth headers — CLOB creds missing` });
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${CLOB_API}/orders/${orderId}`, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      logger.addActivity('fill_debug', { message: `[fetchOrderStatus] REST returned ${res.status} for order ${orderId.slice(0, 14)}` });
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.addActivity('fill_debug', { message: `[fetchOrderStatus] REST error: ${err.message?.slice(0, 60)}` });
    return null;
  }
}

async function fetchOrderStatusSDK(client, orderId) {
  try {
    const order = await client.getOrder(orderId);
    return order || null;
  } catch (err) {
    logger.addActivity('fill_debug', { message: `[fetchOrderSDK] SDK error: ${err.message?.slice(0, 60)}` });
    return null;
  }
}

async function fetchOrderStatus(client, orderId) {
  const sdkResult = client ? await fetchOrderStatusSDK(client, orderId) : null;
  if (sdkResult) return sdkResult;
  return await fetchOrderStatusRaw(orderId);
}

class MomentumSession {
  constructor(market, config) {
    this.market  = market;
    this.config  = config;

    this.phase          = 'waiting';
    this.cancelled      = false;
    this.lastNoSignalLog = 0;

    this._resetTradeLeg();

    this.flipCount     = 0;
    this.cumulativePnl = 0;
    this.totalSpent    = 0;
    this.tradeIds      = [];
    this.btcChange3m   = null;
    this.lastMid       = null;
  }

  _resetTradeLeg() {
    this.signal          = null;
    this.tokenId         = null;
    this.entryPrice      = null;
    this.entrySizeTokens = null;
    this.entryOrderId    = null;
    this.entryFilled     = false;
    this.holdingToken    = false;
    this.filledSize      = null;
    this.exitOrderId     = null;
    this.exitPostedPrice = null;
    this.exitSize        = null;
    this.exitFilledSoFar = 0;
    this._exitInFlight   = false;
    this.exitPrice       = null;
    this.tradePnl        = null;

    this.peakMid           = null;
    this.trailingStopLevel = null;
    this.trailingActive    = false;

    this._lastFillDebugLog  = 0;
    this._lastMidDebugLog   = 0;
    this._lastTrailingLog   = 0;
    this._lastExitDebugLog  = 0;
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
    if (!client) {
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] No CLOB client — set WALLET_PRIVATE_KEY + POLY_API_KEY`
      });
      this.phase = 'done';
      return;
    }

    const signal = this.getSignal();
    if (!signal) {
      const now = Date.now();
      if (now - this.lastNoSignalLog >= 60000) {
        const ctx = krakenFeed.getPriceContext();
        logger.addActivity('mom_skip', {
          message: `[${this.market.coin}-${this.market.type}] No momentum signal — BTC 3m: ${ctx.change3m?.percent || '?'}% (need ±${this.config.momentumThreshold}%) | retrying every 10s | ${Math.round(this.secondsLeft)}s left`
        });
        this.lastNoSignalLog = now;
      }
      return;
    }

    await this._enterSide(client, signal, 'initial');
  }

  async attemptFlip(client) {
    if (this.flipCount >= this.config.maxFlips) {
      this.phase = 'done';
      logger.addActivity('mom_done', {
        message: `[${this.market.coin}-${this.market.type}] Max flips (${this.config.maxFlips}) reached | cumulative P&L: ${this.cumulativePnl >= 0 ? '+' : ''}$${this.cumulativePnl.toFixed(3)}`
      });
      return;
    }

    if (this.secondsLeft <= this.config.flipMinSeconds) {
      this.phase = 'done';
      logger.addActivity('mom_done', {
        message: `[${this.market.coin}-${this.market.type}] Not enough time for flip (${Math.round(this.secondsLeft)}s left, need ${this.config.flipMinSeconds}s)`
      });
      return;
    }

    if (!client) {
      this.phase = 'done';
      return;
    }

    const flipSide = this.signal === 'UP' ? 'DOWN' : 'UP';
    await this._enterSide(client, flipSide, 'flip');
  }

  async _enterSide(client, side, reason) {
    const tokenId = side === 'UP' ? this.market.upTokenId : this.market.downTokenId;
    const mid = await fetchMidpoint(tokenId);

    if (mid === null) {
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] Could not fetch midpoint for ${side} — skipping`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    this.lastMid = mid;

    if (mid < this.config.midMin || mid > this.config.midMax) {
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] ${side} mid=$${mid.toFixed(3)} outside [${this.config.midMin}–${this.config.midMax}] — ${reason === 'flip' ? 'skipping flip' : 'skipping entry'}`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    this._resetTradeLeg();
    this.signal          = side;
    this.tokenId         = tokenId;
    this.entryPrice      = Math.round(mid * 100) / 100;
    this.entrySizeTokens = parseFloat((this.config.orderSize / this.entryPrice).toFixed(2));

    if (reason === 'flip') {
      logger.addActivity('mom_flip', {
        message: `[${this.market.coin}-${this.market.type}] FLIP attempt → ${side} | mid=$${mid.toFixed(3)} | ${Math.round(this.secondsLeft)}s left | cumP&L: ${this.cumulativePnl >= 0 ? '+' : ''}$${this.cumulativePnl.toFixed(3)}`
      });
    } else {
      const ctx = krakenFeed.getPriceContext();
      logger.addActivity('mom_signal', {
        message: `[${this.market.coin}-${this.market.type}] SIGNAL: ${side} | BTC 3m: ${ctx.change3m?.percent || '?'}% | mid=$${mid.toFixed(3)} | ${Math.round(this.secondsLeft)}s left`
      });
    }

    logger.addActivity('mom_entry', {
      message: `[${this.market.coin}-${this.market.type}] BUY ${side} @ $${this.entryPrice} | ${this.entrySizeTokens} tokens | trailing stop: ${(this.config.trailingStop * 100).toFixed(0)}¢ below peak (activates ${(this.config.trailingActivate * 100).toFixed(0)}¢ above entry) | SL: -${(this.config.stopLossCents * 100).toFixed(0)}¢`
    });

    this.phase = 'entering';

    try {
      const order = await client.createAndPostOrder(
        {
          tokenID:    tokenId,
          price:      this.entryPrice,
          size:       this.entrySizeTokens,
          side:       Side.BUY,
          feeRateBps: 1000,
          expiration: 0,
          taker:      '0x0000000000000000000000000000000000000000'
        },
        { tickSize: this.market.tickSize, negRisk: this.market.negRisk },
        OrderType.GTC
      );

      if (order && order.orderID) {
        this.entryOrderId = order.orderID;
        this.totalSpent  += this.config.orderSize;
        if (reason === 'flip') {
          this.flipCount++;
          logger.addActivity('mom_flip', {
            message: `[${this.market.coin}-${this.market.type}] FLIP #${this.flipCount} CONFIRMED → ${side} BUY posted | orderId: ${order.orderID.slice(0, 14)}...`
          });
        } else {
          logger.addActivity('mom_entry', {
            message: `[${this.market.coin}-${this.market.type}] BUY order posted | orderId: ${order.orderID.slice(0, 14)}...`
          });
        }
      } else {
        const err = order?.errorMsg || order?.error || JSON.stringify(order)?.slice(0, 60);
        logger.addActivity('mom_error', {
          message: `[${this.market.coin}-${this.market.type}] BUY failed: ${err}`
        });
        this.phase = reason === 'flip' ? 'done' : 'waiting';
      }
    } catch (err) {
      logger.addActivity('mom_error', {
        message: `[${this.market.coin}-${this.market.type}] BUY error: ${err.message?.slice(0, 80)}`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
    }
  }

  async checkEntryFill(client) {
    if (!this.entryOrderId || this.entryFilled) return;

    const status = await fetchOrderStatus(client, this.entryOrderId);

    if (!status) {
      const now = Date.now();
      if (!this._lastFillDebugLog || now - this._lastFillDebugLog >= 15000) {
        this._lastFillDebugLog = now;
        logger.addActivity('fill_debug', {
          message: `[${this.market.coin}-${this.market.type}] Entry fill check — API returned NULL for order ${this.entryOrderId.slice(0, 14)}... | phase=${this.phase} | ${Math.round(this.secondsLeft)}s left`
        });
      }
      return;
    }

    const matched = parseFloat(status.size_matched || 0);
    const origSize = parseFloat(status.original_size || 0);
    const orderStatus = String(status.status || '').toUpperCase();

    const now2 = Date.now();
    if (!this._lastFillDebugLog || now2 - this._lastFillDebugLog >= 15000) {
      this._lastFillDebugLog = now2;
      logger.addActivity('fill_debug', {
        message: `[${this.market.coin}-${this.market.type}] Entry fill check — status=${orderStatus} | matched=${matched} | original=${origSize} | order=${this.entryOrderId.slice(0, 14)}...`
      });
    }

    if (matched > 0) {
      this.entryFilled  = true;
      this.holdingToken = true;
      this.filledSize   = matched;
      this.peakMid      = this.entryPrice;
      this.phase        = 'managing';
      logger.addActivity('mom_filled', {
        message: `[${this.market.coin}-${this.market.type}] BUY FILLED — ${this.signal} ${matched} tokens @ $${this.entryPrice} | trailing stop activates ${(this.config.trailingActivate * 100).toFixed(0)}¢ above entry ($${(this.entryPrice + this.config.trailingActivate).toFixed(3)})`
      });
    } else if (orderStatus === 'CANCELED' || orderStatus === 'CANCELLED') {
      logger.addActivity('mom_error', {
        message: `[${this.market.coin}-${this.market.type}] Entry order cancelled`
      });
      this.phase = 'done';
    } else if (orderStatus === 'MATCHED') {
      this.entryFilled  = true;
      this.holdingToken = true;
      this.filledSize   = origSize > 0 ? origSize : this.entrySizeTokens;
      this.peakMid      = this.entryPrice;
      this.phase        = 'managing';
      logger.addActivity('mom_filled', {
        message: `[${this.market.coin}-${this.market.type}] BUY FILLED (status=MATCHED) — ${this.signal} ${this.filledSize} tokens @ $${this.entryPrice} | trailing stop activates ${(this.config.trailingActivate * 100).toFixed(0)}¢ above entry ($${(this.entryPrice + this.config.trailingActivate).toFixed(3)})`
      });
    }
  }

  async checkTrailingStop(client) {
    if (this.phase !== 'managing') return;
    if (!this.entryFilled || !this.holdingToken) return;

    const mid = await fetchMidpoint(this.tokenId);
    if (mid === null) {
      const now = Date.now();
      if (!this._lastMidDebugLog || now - this._lastMidDebugLog >= 15000) {
        this._lastMidDebugLog = now;
        logger.addActivity('fill_debug', {
          message: `[${this.market.coin}-${this.market.type}] Trailing stop — midpoint fetch returned NULL | tokenId=${this.tokenId?.slice(0, 14)}... | ${Math.round(this.secondsLeft)}s left`
        });
      }
      return;
    }

    this.lastMid = mid;

    const now3 = Date.now();
    if (!this._lastTrailingLog || now3 - this._lastTrailingLog >= 15000) {
      this._lastTrailingLog = now3;
      const stopLoss = Math.max(0.02, this.entryPrice - this.config.stopLossCents);
      logger.addActivity('fill_debug', {
        message: `[${this.market.coin}-${this.market.type}] Trailing monitor — mid=$${mid.toFixed(3)} | entry=$${this.entryPrice} | peak=$${(this.peakMid || 0).toFixed(3)} | active=${this.trailingActive} | stop=${(this.trailingStopLevel || 0).toFixed(3)} | SL=$${stopLoss.toFixed(3)} | ${Math.round(this.secondsLeft)}s left`
      });
    }

    const stopLossPrice = Math.max(0.02, this.entryPrice - this.config.stopLossCents);

    if (this.secondsLeft <= 60 && this.secondsLeft > this.config.closeSeconds) {
      await this._postExitSell(client, mid, 'time_exit');
      return;
    }

    if (!this.trailingActive && mid >= this.entryPrice + this.config.trailingActivate) {
      this.trailingActive    = true;
      this.peakMid           = mid;
      this.trailingStopLevel = Math.max(0.02, mid - this.config.trailingStop);
      logger.addActivity('mom_trailing', {
        message: `[${this.market.coin}-${this.market.type}] Trailing stop ACTIVATED | peak=$${mid.toFixed(3)} | stop=$${this.trailingStopLevel.toFixed(3)}`
      });
    } else if (this.trailingActive) {
      if (mid > this.peakMid) {
        this.peakMid           = mid;
        this.trailingStopLevel = Math.max(0.02, mid - this.config.trailingStop);
        logger.addActivity('mom_peak', {
          message: `[${this.market.coin}-${this.market.type}] New peak=$${mid.toFixed(3)} | trailing stop=$${this.trailingStopLevel.toFixed(3)} | unrealized: +$${((mid - this.entryPrice) * (this.filledSize || this.entrySizeTokens)).toFixed(3)}`
        });
      }

      if (mid <= this.trailingStopLevel) {
        await this._postExitSell(client, mid, 'trailing_stop');
        return;
      }
    }

    if (mid <= stopLossPrice) {
      await this._postExitSell(client, mid, 'stop_loss');
    }
  }

  async _postExitSell(client, mid, reason) {
    if (this.phase !== 'managing' || !this.holdingToken || this.exitOrderId || this._exitInFlight) return false;

    this._exitInFlight = true;

    try {
      const exitSize  = this.filledSize || this.entrySizeTokens;
      const exitPrice = Math.max(0.02, Math.min(0.97, Math.round(mid * 100) / 100));

      const labels = {
        trailing_stop:   'TRAILING STOP',
        stop_loss:       'STOP LOSS',
        time_exit:       'TIME EXIT',
        closing_cashout: 'CLOSING CASHOUT'
      };
      const label = labels[reason] || reason.toUpperCase();
      const peakStr = this.peakMid ? ` | peak was $${this.peakMid.toFixed(3)}` : '';
      const activityType = (reason === 'stop_loss') ? 'mom_sl' : 'mom_tp_hit';

      logger.addActivity(activityType, {
        message: `[${this.market.coin}-${this.market.type}] ${label} TRIGGERED | ${this.signal} mid=$${mid.toFixed(3)}${peakStr} | posting sell @ $${exitPrice}`
      });

      const result = await placeSellOrder(
        this.tokenId,
        exitSize,
        exitPrice,
        this.market.negRisk,
        this.market.tickSize
      );

      if (!result.success) {
        logger.addActivity('mom_error', {
          message: `[${this.market.coin}-${this.market.type}] Exit sell POST failed: ${result.error?.slice(0, 80)} — will retry next tick`
        });
        return false;
      }

      this.exitOrderId     = result.orderId;
      this.exitPostedPrice = exitPrice;
      this.exitSize        = exitSize;
      this.exitFilledSoFar = 0;
      this.phase           = 'exiting';

      logger.addActivity(activityType, {
        message: `[${this.market.coin}-${this.market.type}] Exit sell posted @ $${exitPrice} | orderId: ${result.orderId?.slice(0, 14)}... | waiting for fill`
      });
      return true;
    } finally {
      this._exitInFlight = false;
    }
  }

  async checkExitFill(client) {
    if (this.phase !== 'exiting' || !this.exitOrderId) return;

    const status = await fetchOrderStatus(client, this.exitOrderId);

    if (!status) {
      const now = Date.now();
      if (!this._lastExitDebugLog || now - this._lastExitDebugLog >= 15000) {
        this._lastExitDebugLog = now;
        logger.addActivity('fill_debug', {
          message: `[${this.market.coin}-${this.market.type}] Exit fill check — API returned NULL for order ${this.exitOrderId.slice(0, 14)}... | ${Math.round(this.secondsLeft)}s left`
        });
      }
      return;
    }

    const totalMatched = parseFloat(status.size_matched || 0);
    if (totalMatched > this.exitFilledSoFar) {
      this.exitFilledSoFar = totalMatched;
    }

    const remaining = (this.exitSize || 0) - this.exitFilledSoFar;
    const fullyFilled = this.exitFilledSoFar > 0 && remaining <= 0.01;
    const exitStatus = String(status.status || '').toUpperCase();

    const now2 = Date.now();
    if (!this._lastExitDebugLog || now2 - this._lastExitDebugLog >= 15000) {
      this._lastExitDebugLog = now2;
      logger.addActivity('fill_debug', {
        message: `[${this.market.coin}-${this.market.type}] Exit fill check — status=${exitStatus} | matched=${totalMatched} | exitSize=${(this.exitSize || 0).toFixed(2)} | remaining=${remaining.toFixed(2)}`
      });
    }

    if (fullyFilled) {
      const fillPrice = this.exitPostedPrice;
      this.holdingToken  = false;
      this.exitPrice     = fillPrice;
      this.tradePnl      = parseFloat(((fillPrice - this.entryPrice) * this.exitFilledSoFar).toFixed(4));
      this.cumulativePnl = parseFloat((this.cumulativePnl + this.tradePnl).toFixed(4));
      this.exitOrderId   = null;
      this.phase         = 'flipping';

      logger.addActivity('mom_tp_hit', {
        message: `[${this.market.coin}-${this.market.type}] Exit FULLY FILLED — sold ${this.exitFilledSoFar} ${this.signal} @ $${fillPrice.toFixed(3)} | trade P&L: ${this.tradePnl >= 0 ? '+' : ''}$${this.tradePnl.toFixed(3)} | window cumulative: ${this.cumulativePnl >= 0 ? '+' : ''}$${this.cumulativePnl.toFixed(3)}`
      });
      return;
    }

    if (exitStatus === 'MATCHED') {
      const fillPrice = this.exitPostedPrice;
      const exitAmt = this.exitSize || totalMatched || this.filledSize || this.entrySizeTokens;
      this.exitFilledSoFar = exitAmt;
      this.holdingToken  = false;
      this.exitPrice     = fillPrice;
      this.tradePnl      = parseFloat(((fillPrice - this.entryPrice) * exitAmt).toFixed(4));
      this.cumulativePnl = parseFloat((this.cumulativePnl + this.tradePnl).toFixed(4));
      this.exitOrderId   = null;
      this.phase         = 'flipping';

      logger.addActivity('mom_tp_hit', {
        message: `[${this.market.coin}-${this.market.type}] Exit FILLED (status=MATCHED) — sold ${exitAmt} ${this.signal} @ $${fillPrice.toFixed(3)} | trade P&L: ${this.tradePnl >= 0 ? '+' : ''}$${this.tradePnl.toFixed(3)} | window cumulative: ${this.cumulativePnl >= 0 ? '+' : ''}$${this.cumulativePnl.toFixed(3)}`
      });
      return;
    }

    if (this.exitFilledSoFar > 0 && remaining > 0.01) {
      logger.addActivity('mom_tp_hit', {
        message: `[${this.market.coin}-${this.market.type}] Partial exit: ${this.exitFilledSoFar.toFixed(2)}/${this.exitSize?.toFixed(2)} tokens filled — ${remaining.toFixed(2)} remaining, waiting for full fill`
      });
      return;
    }

    if (exitStatus === 'CANCELED' || exitStatus === 'CANCELLED') {
      this.exitOrderId = null;
      this.phase       = 'managing';
      logger.addActivity('mom_error', {
        message: `[${this.market.coin}-${this.market.type}] Exit order cancelled externally — returning to managing to retry exit`
      });
    }
  }

  async handleClosingPhase(client) {
    if (this.cancelled) return;
    this.cancelled = true;

    if (this.phase === 'exiting' && this.exitOrderId) {
      logger.addActivity('mom_close', {
        message: `[${this.market.coin}-${this.market.type}] Closing — exit sell in progress (${(this.exitFilledSoFar || 0).toFixed(2)} of ${(this.exitSize || 0).toFixed(2)} filled) | letting it fill`
      });
      return;
    }

    if (!this.entryFilled && this.entryOrderId && client) {
      try { await client.cancelOrder({ orderID: this.entryOrderId }); } catch {}
      logger.addActivity('mom_close', {
        message: `[${this.market.coin}-${this.market.type}] Closing — cancelled unfilled entry`
      });
      return;
    }

    if (this.entryFilled && this.holdingToken && this.phase === 'managing') {
      const mid = await fetchMidpoint(this.tokenId);
      if (mid !== null) {
        logger.addActivity('mom_close', {
          message: `[${this.market.coin}-${this.market.type}] Closing — cashing out ${this.signal} at mid=$${mid.toFixed(3)} | entry=$${this.entryPrice.toFixed(3)} | cumP&L: ${this.cumulativePnl >= 0 ? '+' : ''}$${this.cumulativePnl.toFixed(3)}`
        });
        const sold = await this._postExitSell(client, mid, 'closing_cashout');
        if (!sold) {
          logger.addActivity('mom_close', {
            message: `[${this.market.coin}-${this.market.type}] Closing — sell failed, holding to resolution`
          });
        }
      } else {
        logger.addActivity('mom_close', {
          message: `[${this.market.coin}-${this.market.type}] Closing — no mid available, holding ${this.signal} to resolution`
        });
      }
    } else if (this.entryFilled && this.holdingToken) {
      logger.addActivity('mom_close', {
        message: `[${this.market.coin}-${this.market.type}] Closing — phase=${this.phase}, letting exit complete | cumP&L: ${this.cumulativePnl >= 0 ? '+' : ''}$${this.cumulativePnl.toFixed(3)}`
      });
    }
  }

  getStatus() {
    const unrealizedPnL = (this.lastMid !== null && this.entryFilled && this.holdingToken && this.filledSize && this.phase === 'managing')
      ? parseFloat(((this.lastMid - this.entryPrice) * this.filledSize).toFixed(4))
      : null;

    return {
      marketId:          this.marketId,
      coin:              this.market.coin,
      type:              this.market.type,
      secondsLeft:       Math.round(this.secondsLeft),
      phase:             this.phase,
      signal:            this.signal,
      lastMid:           this.lastMid,
      btcChange3m:       this.btcChange3m,
      entryPrice:        this.entryPrice,
      peakMid:           this.peakMid,
      trailingStopLevel: this.trailingStopLevel,
      trailingActive:    this.trailingActive,
      stopLossPrice:     this.entryPrice !== null ? Math.max(0.02, this.entryPrice - this.config.stopLossCents) : null,
      entryFilled:       this.entryFilled,
      holdingToken:      this.holdingToken,
      filledSize:        this.filledSize,
      exitOrderId:       this.exitOrderId || null,
      unrealizedPnL,
      tradePnl:          this.tradePnl,
      cumulativePnl:     this.cumulativePnl,
      exitPrice:         this.exitPrice,
      flipCount:         this.flipCount,
      totalSpent:        this.totalSpent,
      question:          this.market.question,
      endTime:           this.market.endTime
    };
  }
}

module.exports = { MomentumSession, getMomentumConfig, fetchMidpoint };
