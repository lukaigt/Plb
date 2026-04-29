const { placeOrder, initClient, buildClobAuthHeaders } = require('./trader');
const logger   = require('./logger');
const redeemer = require('./redeemer');
const safety   = require('./safety');

const CLOB_API           = 'https://clob.polymarket.com';
const GAMMA_API          = 'https://gamma-api.polymarket.com';
const ESTIMATED_FEE_RATE = 0.02;

function getBondConfig() {
  return {
    threshold:    process.env.BOND_THRESHOLD    != null ? parseFloat(process.env.BOND_THRESHOLD)   : 0.95,
    orderSize:    process.env.BOND_ORDER_SIZE   != null ? parseFloat(process.env.BOND_ORDER_SIZE)  : 5,
    maxPositions: process.env.BOND_MAX_POSITIONS != null ? parseInt(process.env.BOND_MAX_POSITIONS) : 5,
    minVolume:    process.env.BOND_MIN_VOLUME   != null ? parseFloat(process.env.BOND_MIN_VOLUME)  : 500
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
  } catch { return null; }
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
  } catch { return null; }
}

async function checkMarketResolved(conditionId) {
  try {
    const url = `${GAMMA_API}/markets?conditionId=${conditionId}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const markets = await res.json();
    if (Array.isArray(markets) && markets.length > 0) {
      const m = markets[0];

      let yesWon = null;
      try {
        const prices = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : (Array.isArray(m.outcomePrices) ? m.outcomePrices : null);
        if (prices && prices.length >= 2) {
          yesWon = parseFloat(prices[0]) === 1;
        }
      } catch {}

      return {
        resolved: m.resolved === true || m.hasResolved === true,
        closed:   m.closed === true,
        negRisk:  m.negRisk === true || m.enableNegRisk === true,
        yesWon
      };
    }
  } catch {}
  return null;
}

class BondSession {
  constructor(market, config) {
    this.market       = market;
    this.config       = config;
    this.phase        = 'watching';
    this.lastMid      = null;
    this.entryPrice   = null;
    this.orderId      = null;
    this.filledTokens = 0;
    this.filledAmount = 0;
    this.resolvedAt   = null;
    this.tradeId      = null;
    this.pnl          = null;
    this.createdAt    = new Date();
    this.lastPollAt       = 0;
    this.resolutionCheckAt = 0;
    this._fillCheckFails  = 0;
  }

  get id() { return this.market.id; }

  async pollPrice() {
    const mid = await fetchMidpoint(this.market.yesTokenId);
    if (mid !== null) this.lastMid = mid;
    this.lastPollAt = Date.now();
    return this.lastMid;
  }

  shouldEnter() {
    // Must be at or above threshold but below the market's max valid price.
    // At 1.000 the game is over and the CLOB rejects prices >= 1.0 (no yield left).
    const tickNum  = parseFloat(this.market.tickSize || '0.01') || 0.01;
    const decimals = tickNum <= 0.001 ? 3 : 2;
    const maxPrice = parseFloat((1.0 - tickNum).toFixed(decimals));
    return this.lastMid !== null
      && this.lastMid >= this.config.threshold
      && this.lastMid <= maxPrice;
  }

  async enter(client) {
    if (!this.lastMid) return false;
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) return false;

    const amount   = this.config.orderSize;
    const negRisk  = this.market.negRisk;
    const tickSize = this.market.tickSize || '0.01';
    // Cap price strictly below 1.0 using the market's actual tick size
    const tickNum  = parseFloat(tickSize) || 0.01;
    const decimals = tickNum <= 0.001 ? 3 : 2;
    const maxPrice = parseFloat((1.0 - tickNum).toFixed(decimals));
    const price    = Math.min(this.lastMid, maxPrice);

    logger.addActivity('bond_entry', {
      message: `[Soccer] ENTERING "${this.market.question.slice(0, 55)}" | mid=${price.toFixed(3)} >= threshold=${this.config.threshold} | $${amount} buy`
    });

    const result = await placeOrder(
      this.market.yesTokenId,
      'BUY',
      amount,
      price,
      privateKey,
      negRisk,
      tickSize
    );

    if (result.success && result.orderId) {
      this.phase        = 'buying';
      this.entryPrice   = price;
      this.orderId      = result.orderId;
      this.filledAmount = amount;
      safety.recordTrade(amount);

      const estimatedFee = amount * ESTIMATED_FEE_RATE;
      const logged = logger.addTrade({
        strategy:     'soccer_bond',
        question:     this.market.question,
        eventTitle:   this.market.eventTitle,
        tokenId:      this.market.yesTokenId,
        side:         'YES',
        price,
        size:         amount,
        orderId:      result.orderId,
        result:       'pending',
        pnl:          0,
        estimatedFee,
        exitReason:   null
      });
      this.tradeId = logged.id;
      return true;
    }

    logger.addActivity('bond_error', {
      message: `[Soccer] Order failed "${this.market.question.slice(0, 50)}": ${result.error?.slice(0, 80)}`
    });
    this.phase = 'done';
    return false;
  }

  async checkFill(client) {
    if (!this.orderId) return;

    let order = await fetchOrderStatus(this.orderId);

    if (!order && client) {
      try { order = await client.getOrder(this.orderId); } catch {}
    }

    if (!order) {
      this._fillCheckFails++;
      if (this._fillCheckFails >= 20) {
        logger.addActivity('bond_error', { message: `[Soccer] Cannot check fill after 20 attempts — marking done` });
        this.phase = 'done';
        if (this.tradeId) logger.updateTrade(this.tradeId, { result: 'failed', exitReason: 'fill_check_timeout' });
      }
      return;
    }

    const sizeMatched = parseFloat(order.size_matched || order.sizeMatched || 0);
    const status = (order.status || order.orderStatus || '').toUpperCase();

    if (sizeMatched > 0 || status === 'MATCHED') {
      const tokens = sizeMatched > 0 ? sizeMatched : (this.filledAmount / (this.entryPrice || 0.95));
      this.filledTokens = parseFloat(tokens.toFixed(4));
      this.phase = 'holding';
      logger.addActivity('bond_fill', {
        message: `[Soccer] FILLED "${this.market.question.slice(0, 55)}" | ${this.filledTokens.toFixed(2)} YES tokens @ $${this.entryPrice?.toFixed(3)} | waiting for resolution`
      });
      return;
    }

    if (status === 'CANCELLED' || status === 'EXPIRED') {
      logger.addActivity('bond_cancelled', {
        message: `[Soccer] Order ${status} for "${this.market.question.slice(0, 50)}"`
      });
      this.phase = 'done';
      if (this.tradeId) logger.updateTrade(this.tradeId, { result: 'failed', exitReason: 'order_cancelled' });
    }
  }

  async checkResolutionWhileBuying() {
    if (this.phase !== 'buying') return; // checkFill() may have already moved phase
    if (!this.market.conditionId) return;

    const res = await checkMarketResolved(this.market.conditionId);
    if (!res || (!res.resolved && !res.closed)) return;

    // Market resolved while fill was not confirmed via API. The order may have
    // actually filled on-chain even though the fill-check API returned null.
    // Transition to 'redeeming' and let tryRedeem() check the actual on-chain
    // balance — if tokens are there we collect them, if not it exits cleanly.
    logger.addActivity('bond_cancelled', {
      message: `[Soccer] Market resolved before fill confirmed — checking on-chain balance for "${this.market.question.slice(0, 50)}"`
    });
    if (this.tradeId) {
      logger.updateTrade(this.tradeId, { result: 'no_fill', exitReason: 'resolved_before_fill' });
    }
    this.phase            = 'redeeming';
    this._redeemAttempts  = 0;
    this._redeemStartedAt = Date.now();
  }

  async checkResolution() {
    const now = Date.now();
    if (now - this.resolutionCheckAt < 30000) return;
    this.resolutionCheckAt = now;

    await this.pollPrice();

    if (!this.market.conditionId) {
      logger.addActivity('bond_error', { message: `[Soccer] No conditionId for resolution check: ${this.market.question.slice(0, 50)}` });
      return;
    }

    // Check resolution every 30s regardless of endDate.
    // Polymarket closes markets as soon as the game ends — often 15-30+ min
    // before the scheduled endDate buffer — so waiting for pastEnd causes
    // filled positions to sit unredeemed for a long time.
    const res = await checkMarketResolved(this.market.conditionId);
    if (!res) return;

    if (res.resolved || res.closed) {
      await this._finalise(res);
    }
  }

  async _finalise(res) {
    if (this.phase !== 'holding') { this.phase = 'done'; return; }

    // Derive winner from Gamma outcomePrices (authoritative).
    // Fall back to lastMid >= 0.5 only when Gamma data is unavailable.
    let yesWon;
    if (res.yesWon !== null && res.yesWon !== undefined) {
      yesWon = res.yesWon;
    } else if (this.lastMid !== null) {
      yesWon = this.lastMid >= 0.5;
    } else {
      logger.addActivity('bond_error', {
        message: `[Soccer] Cannot determine outcome for "${this.market.question.slice(0, 50)}" — logged as no_fill`
      });
      this.phase = 'done';
      if (this.tradeId) logger.updateTrade(this.tradeId, { result: 'no_fill', exitReason: 'outcome_unknown' });
      return;
    }

    const tokens   = this.filledTokens > 0 ? this.filledTokens : (this.filledAmount / (this.entryPrice || 0.95));
    const grossPnl = yesWon ? (tokens * 1.0) - this.filledAmount : -this.filledAmount;
    const fee      = this.filledAmount * ESTIMATED_FEE_RATE;
    const netPnl   = grossPnl - fee;
    const result   = yesWon ? 'win' : 'loss';

    this.pnl        = grossPnl;
    this.resolvedAt = new Date().toISOString();

    if (result === 'win') safety.recordWin(Math.abs(grossPnl));
    else safety.recordLoss(Math.abs(grossPnl));

    if (this.tradeId) {
      logger.updateTrade(this.tradeId, {
        result,
        pnl:          grossPnl,
        estimatedFee: fee,
        exitReason:   result === 'win' ? 'resolved_win' : 'resolved_loss'
      });
    }

    logger.addActivity(result === 'win' ? 'bond_done' : 'bond_loss', {
      message: `[Soccer] RESOLVED ${result.toUpperCase()} "${this.market.question.slice(0, 50)}" | gross=${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(3)} | net=${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(3)}`
    });

    if (result === 'win') {
      // Attempt on-chain redemption immediately in the same flow — the redeemer
      // checks actual token balance itself, so no need to gate on filledTokens.
      // If it fails, phase stays 'redeeming' and the fast loop retries every 15s.
      this.phase           = 'redeeming';
      this._redeemAttempts = 0;
      await this.tryRedeem();
    } else {
      this.phase = 'done';
    }
  }

  async tryRedeem() {
    this._redeemAttempts  = (this._redeemAttempts  || 0) + 1;
    if (!this._redeemStartedAt) this._redeemStartedAt = Date.now();

    const elapsedMin = Math.floor((Date.now() - this._redeemStartedAt) / 60000);
    logger.addActivity('redeemer', {
      message: `[Soccer] Redeem attempt ${this._redeemAttempts} (+${elapsedMin}min) for "${this.market.question.slice(0, 50)}"`
    });

    const succeeded = await redeemer.redeemPosition(
      this.market.conditionId,
      this.market.yesTokenId,
      this.market.negRisk,
      this.market.question
    );

    if (succeeded) {
      this.phase = 'done';
    } else if (Date.now() - this._redeemStartedAt > 2 * 60 * 60 * 1000) {
      // On-chain market resolution (payoutDenominator becoming non-zero) can take
      // 30–60 min after Gamma marks the market closed. Retry every 15s for up to
      // 2 hours before giving up, so we don't abandon tokens that are redeemable.
      logger.addActivity('redeemer_error', {
        message: `[Soccer] Giving up on redemption after 2 hours: "${this.market.question.slice(0, 50)}"`
      });
      this.phase = 'done';
    }
    // else: stay in 'redeeming' — fast loop retries on next 15s tick
  }

  getStatus() {
    let unrealizedPnL = null;
    if ((this.phase === 'holding' || this.phase === 'buying') && this.filledAmount > 0 && this.lastMid !== null) {
      const tokens = this.filledTokens > 0 ? this.filledTokens : (this.filledAmount / (this.entryPrice || 0.95));
      unrealizedPnL = parseFloat(((this.lastMid * tokens) - this.filledAmount).toFixed(4));
    }
    const now       = new Date();
    const endDate   = new Date(this.market.endDate);
    const minutesLeft = Math.max(0, Math.round((endDate - now) / 60000));

    return {
      id:            this.id,
      question:      this.market.question,
      eventTitle:    this.market.eventTitle,
      phase:         this.phase,
      lastMid:       this.lastMid,
      entryPrice:    this.entryPrice,
      filledTokens:  this.filledTokens,
      filledAmount:  this.filledAmount,
      unrealizedPnL,
      pnl:           this.pnl,
      endDate:       this.market.endDate,
      minutesLeft,
      threshold:     this.config.threshold,
      createdAt:     this.createdAt.toISOString()
    };
  }
}

module.exports = { BondSession, getBondConfig, fetchMidpoint };
