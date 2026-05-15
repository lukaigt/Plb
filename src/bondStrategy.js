const { placeOrder, placeFakSellOrder, initClient, buildClobAuthHeaders } = require('./trader');
const logger        = require('./logger');
const redeemer      = require('./redeemer');
const safety        = require('./safety');
const marketWatcher = require('./marketWatcher');

const CLOB_API           = 'https://clob.polymarket.com';
const GAMMA_API          = 'https://gamma-api.polymarket.com';
const ESTIMATED_FEE_RATE = 0.02;

function getBondConfig() {
  return {
    threshold:     process.env.BOND_THRESHOLD      != null ? parseFloat(process.env.BOND_THRESHOLD)      : 0.95,
    orderSize:     process.env.BOND_ORDER_SIZE     != null ? parseFloat(process.env.BOND_ORDER_SIZE)     : 5,
    maxPositions:  process.env.BOND_MAX_POSITIONS  != null ? parseInt(process.env.BOND_MAX_POSITIONS)    : 5,
    minVolume:     process.env.BOND_MIN_VOLUME     != null ? parseFloat(process.env.BOND_MIN_VOLUME)     : 500,
    stopLoss:      process.env.BOND_STOP_LOSS      != null ? parseFloat(process.env.BOND_STOP_LOSS)      : 0.07,
    maxThreshold:  process.env.BOND_MAX_THRESHOLD  != null ? parseFloat(process.env.BOND_MAX_THRESHOLD)  : 0.97,
    trailingStop:  process.env.BOND_TRAILING_STOP  != null ? parseFloat(process.env.BOND_TRAILING_STOP)  : 0.03,
    maxSpread:     process.env.BOND_MAX_SPREAD     != null ? parseFloat(process.env.BOND_MAX_SPREAD)     : 0.10,
    fakRetries:    process.env.BOND_FAK_RETRIES    != null ? parseInt(process.env.BOND_FAK_RETRIES)      : 5,
    exitRetrySecs: process.env.BOND_EXIT_RETRY_SECS != null ? parseInt(process.env.BOND_EXIT_RETRY_SECS) : 5,
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

    // Exit engine state
    this.currentBestBid      = null;
    this.currentBestAsk      = null;
    this.currentSpread       = null;
    this.peakBestBid         = null;
    this.exitAttemptCount    = 0;
    this.lastExitReason      = null;
    this._liquidating        = false;
    this._remainingTokens    = 0;
    this._totalProceeds      = 0;
    this._liquidationStartedAt = null;
  }

  get id() { return this.market.id; }

  async pollPrice() {
    // Prefer live best_bid from WebSocket — updated in near real-time, no proxy needed
    const wsData  = marketWatcher.getBookData(this.market.yesTokenId);
    const wsFresh = marketWatcher.isFresh(this.market.yesTokenId);

    if (wsFresh && wsData && wsData.best_bid != null) {
      this.currentBestBid = wsData.best_bid;
      this.currentBestAsk = wsData.best_ask ?? null;
      this.currentSpread  = wsData.spread   ?? null;
      this.lastMid        = wsData.best_bid;
      this.lastPollAt     = Date.now();
      return this.lastMid;
    }

    // Fallback: REST midpoint when WS is disconnected or stale
    const mid = await fetchMidpoint(this.market.yesTokenId);
    if (mid !== null) {
      this.lastMid        = mid;
      this.currentBestBid = mid;
    }
    this.lastPollAt = Date.now();
    return this.lastMid;
  }

  shouldEnter() {
    const tickNum  = parseFloat(this.market.tickSize || '0.01') || 0.01;
    const decimals = tickNum <= 0.001 ? 3 : 2;
    const hardMax  = parseFloat((1.0 - tickNum).toFixed(decimals));
    const ceiling  = (this.config.maxThreshold > 0 && this.config.maxThreshold < hardMax)
      ? this.config.maxThreshold
      : hardMax;
    return this.lastMid !== null
      && this.lastMid >= this.config.threshold
      && this.lastMid <= ceiling;
  }

  async enter(client) {
    if (!this.lastMid) return false;
    const privateKey = process.env.WALLET_PRIVATE_KEY;
    if (!privateKey) return false;

    const amount   = this.config.orderSize;
    const negRisk  = this.market.negRisk;
    const tickSize = this.market.tickSize || '0.01';
    const tickNum  = parseFloat(tickSize) || 0.01;
    const decimals = tickNum <= 0.001 ? 3 : 2;
    const maxPrice = parseFloat((1.0 - tickNum).toFixed(decimals));
    const price    = Math.min(this.lastMid, maxPrice);

    logger.addActivity('bond_entry', {
      message: `[ENTRY] signal: "${this.market.question.slice(0, 50)}" | bid=${price.toFixed(3)} threshold=${this.config.threshold} | $${amount} buy`
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

      logger.addActivity('bond_entry', {
        message: `[BUY] submitted: orderId=${result.orderId.slice(0, 12)}... price=$${price.toFixed(3)} size=$${amount}`
      });

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

    const errMsg = (result.error || '').toLowerCase();
    const isInfraError = errMsg.includes('balance') || errMsg.includes('allowance') ||
      errMsg.includes('not initialized') || errMsg.includes('client not');

    if (isInfraError) {
      logger.addActivity('bond_error', {
        message: `[BUY] failed (will retry) "${this.market.question.slice(0, 50)}": ${result.error?.slice(0, 80)}`
      });
      this.phase = 'watching';
    } else {
      logger.addActivity('bond_error', {
        message: `[BUY] rejected "${this.market.question.slice(0, 50)}": ${result.error?.slice(0, 80)}`
      });
      this.phase = 'done';
    }
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
        logger.addActivity('bond_error', { message: `[BUY] cannot check fill after 20 attempts — marking done` });
        this.phase = 'done';
        if (this.tradeId) logger.updateTrade(this.tradeId, { result: 'failed', exitReason: 'fill_check_timeout' });
      }
      return;
    }

    const sizeMatched = parseFloat(order.size_matched || order.sizeMatched || 0);
    const status = (order.status || order.orderStatus || '').toUpperCase();

    if (sizeMatched > 0 || status === 'MATCHED') {
      const tokens = sizeMatched > 0 ? sizeMatched : (this.filledAmount / (this.entryPrice || 0.95));
      this.filledTokens     = parseFloat(tokens.toFixed(4));
      this._remainingTokens = this.filledTokens;
      this.phase            = 'holding';

      // Subscribe to real-time market WebSocket for this position
      marketWatcher.subscribe(this.market.yesTokenId);

      logger.addActivity('bond_fill', {
        message: `[BUY] filled: ${this.filledTokens.toFixed(2)} YES tokens @ $${this.entryPrice?.toFixed(3)} | real-time best_bid tracking active | "${this.market.question.slice(0, 45)}"`
      });
      return;
    }

    if (status === 'CANCELLED' || status === 'EXPIRED') {
      logger.addActivity('bond_cancelled', {
        message: `[BUY] order ${status} for "${this.market.question.slice(0, 50)}"`
      });
      this.phase = 'done';
      if (this.tradeId) logger.updateTrade(this.tradeId, { result: 'failed', exitReason: 'order_cancelled' });
    }
  }

  // ─── EXIT ENGINE ────────────────────────────────────────────────────────────

  _checkExitTrigger() {
    if (this.phase !== 'holding') return null;
    if (this._liquidating) return null;
    if (this.filledTokens <= 0 || this.filledAmount <= 0) return null;

    const bid = this.currentBestBid ?? this.lastMid;
    if (bid === null) return null;

    // Track peak best_bid since fill
    if (this.peakBestBid === null || bid > this.peakBestBid) {
      this.peakBestBid = bid;
    }

    // ── Per-tick diagnostic log — shows full stop-loss math every poll ─────────
    const currentValue    = bid * this.filledTokens;
    const hardThreshold   = this.filledAmount * (1 - (this.config.stopLoss || 0));
    const lossPctNow      = (((this.filledAmount - currentValue) / this.filledAmount) * 100);
    const dropFromPeak    = this.peakBestBid !== null ? (this.peakBestBid - bid) : 0;
    const spreadStr       = this.currentSpread != null ? `spread=${(this.currentSpread * 100).toFixed(1)}¢` : 'spread=?';
    const pnl             = currentValue - this.filledAmount;
    const hardWouldTrig   = this.config.stopLoss > 0 && currentValue < hardThreshold;
    const trailWouldTrig  = this.config.trailingStop > 0 && this.peakBestBid !== null && dropFromPeak >= this.config.trailingStop;
    const spreadWouldTrig = this.config.maxSpread > 0 && this.currentBestAsk !== null && (this.currentBestAsk - bid) > this.config.maxSpread;

    logger.addActivity('bond_hold', {
      message: [
        `[HOLD] "${this.market.question.slice(0, 38)}"`,
        `tokenId=${this.market.yesTokenId.slice(0, 14)}…`,
        `entry=$${this.entryPrice?.toFixed(3) ?? '?'} filled=${this.filledTokens.toFixed(4)} cost=$${this.filledAmount.toFixed(3)}`,
        `bid=$${bid.toFixed(3)} value=$${currentValue.toFixed(3)} loss=${lossPctNow.toFixed(2)}%`,
        `hardThresh=$${hardThreshold.toFixed(3)} (stop=${((this.config.stopLoss || 0) * 100).toFixed(0)}%)`,
        `peak=$${(this.peakBestBid || 0).toFixed(3)} dropFromPeak=${(dropFromPeak * 100).toFixed(1)}¢ (trailStop=${(this.config.trailingStop * 100).toFixed(0)}¢)`,
        `${spreadStr} pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}`,
        `TRIGGER: hard=${hardWouldTrig} trail=${trailWouldTrig} spread=${spreadWouldTrig}`
      ].join(' | ')
    });

    // 1. Hard stop — current value fell more than BOND_STOP_LOSS below entry cost
    if (hardWouldTrig) {
      return { reason: 'hard', detail: `${lossPctNow.toFixed(1)}% loss | bid=$${bid.toFixed(3)} value=$${currentValue.toFixed(3)} threshold=$${hardThreshold.toFixed(3)} entry=$${this.filledAmount.toFixed(3)}` };
    }

    // 2. Trailing stop — bid dropped BOND_TRAILING_STOP below peak
    if (trailWouldTrig) {
      return {
        reason: 'trailing',
        detail: `bid dropped ${(dropFromPeak * 100).toFixed(1)}¢ from peak $${this.peakBestBid.toFixed(3)} | bid=$${bid.toFixed(3)}`
      };
    }

    // 3. Spread exit — book is broken/illiquid
    if (spreadWouldTrig) {
      const spread = this.currentBestAsk - bid;
      return {
        reason: 'spread',
        detail: `spread=${(spread * 100).toFixed(1)}¢ > max=${(this.config.maxSpread * 100).toFixed(0)}¢`
      };
    }

    return null;
  }

  async checkExitTriggers() {
    const trigger = this._checkExitTrigger();
    if (!trigger) return;

    this.lastExitReason        = trigger.reason;
    this.phase                 = 'liquidating';
    this._remainingTokens      = this.filledTokens;
    this._totalProceeds        = 0;
    this._liquidationStartedAt = Date.now();

    logger.addActivity('bond_stoploss', {
      message: `[STOP] triggered: reason=${trigger.reason} | ${trigger.detail} | ${this.filledTokens.toFixed(4)} tokens → liquidating now | "${this.market.question.slice(0, 40)}"`
    });

    // Start background liquidation loop — does not block the fast loop
    this.runLiquidationLoop().catch(err => {
      logger.addActivity('bond_error', {
        message: `[EXIT] liquidation loop crash: ${err.message?.slice(0, 80)}`
      });
      marketWatcher.unsubscribe(this.market.yesTokenId);
      this._liquidating = false;
      this.phase = 'done';
    });
  }

  async runLiquidationLoop() {
    if (this._liquidating) return;
    this._liquidating = true;

    const maxRetries = Math.max(1, this.config.fakRetries    || 5);
    const retrySecs  = Math.max(2, this.config.exitRetrySecs || 5) * 1000;
    const tokenId    = this.market.yesTokenId;
    const tickNum    = parseFloat(this.market.tickSize || '0.01') || 0.01;
    const decimals   = tickNum <= 0.001 ? 3 : 2;

    let allNoBid = true; // tracks whether every attempt had zero live bids

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (this._remainingTokens <= 0.01) break;
      if (this.phase === 'done') break;

      logger.addActivity('bond_exit', {
        message: `[EXIT] liquidation attempt ${attempt}/${maxRetries} tokenId=${tokenId.slice(0, 14)}… remaining=${this._remainingTokens.toFixed(4)} | "${this.market.question.slice(0, 38)}"`
      });

      // ── STEP 1: fetch live order book — never use websocket cache or midpoint ──
      let topBid = null;
      try {
        const bookRes = await fetch(
          `https://clob.polymarket.com/book?token_id=${tokenId}`,
          { signal: AbortSignal.timeout(8000) }
        );
        const book = await bookRes.json();
        if (book && Array.isArray(book.bids)) {
          const liveBids = book.bids
            .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
            .filter(b => b.price > 0 && b.size > 0)
            .sort((a, b) => b.price - a.price);
          if (liveBids.length > 0) topBid = liveBids[0].price;
        }
      } catch (fetchErr) {
        logger.addActivity('bond_exit', {
          message: `[EXIT] book fetch error attempt ${attempt}: ${fetchErr.message?.slice(0, 60)}`
        });
      }

      if (topBid === null) {
        logger.addActivity('bond_exit', {
          message: `[EXIT] no_bid_liquidity attempt ${attempt} — no live bids found, skipping FAK | remaining=${this._remainingTokens.toFixed(4)}`
        });
        await new Promise(r => setTimeout(r, retrySecs));
        continue;
      }

      allNoBid = false;

      // ── STEP 2: place FAK at live top bid ─────────────────────────────────
      // Sell at the exact top bid — FAK matches against it directly.
      // No midpoint, no websocket cache, no fallback fake prices.
      const sellPrice = parseFloat(Math.max(0.01, topBid).toFixed(decimals));

      logger.addActivity('bond_exit', {
        message: `[EXIT] book top bid = $${topBid.toFixed(3)} | FAK sent price=${sellPrice.toFixed(decimals)} size=${this._remainingTokens.toFixed(4)} tokenId=${tokenId.slice(0, 14)}…`
      });

      this.exitAttemptCount++;
      let result = null;
      try {
        result = await placeFakSellOrder(
          tokenId,
          this._remainingTokens,
          sellPrice,
          this.market.negRisk,
          this.market.tickSize || '0.01'
        );
      } catch (err) {
        logger.addActivity('bond_exit', {
          message: `[EXIT] FAK exception attempt ${attempt}: ${err.message?.slice(0, 80)}`
        });
        await new Promise(r => setTimeout(r, retrySecs));
        continue;
      }

      // ── STEP 3: read actual fill from SDK response ─────────────────────────
      // makingAmount = tokens sold, takingAmount = USDC received (CLOB v2 SDK).
      // sizeFilled is already extracted from makingAmount by placeFakSellOrder().
      // sizeFilled = 0 means the exchange accepted the order but matched zero — NOT success.
      const filled  = result?.sizeFilled  ?? 0;
      const usdGot  = result?.usdReceived ?? (filled * sellPrice);
      const orderId = result?.orderId     ?? 'n/a';

      logger.addActivity('bond_exit', {
        message: `[EXIT] result makingAmount=${filled.toFixed(4)} takingAmount=$${usdGot.toFixed(3)} orderId=${orderId}`
      });

      if (filled > 0) {
        this._totalProceeds   += usdGot > 0 ? usdGot : filled * sellPrice;
        this._remainingTokens  = Math.max(0, parseFloat((this._remainingTokens - filled).toFixed(6)));
        logger.addActivity('bond_exit', {
          message: `[EXIT] remaining after fill = ${this._remainingTokens.toFixed(4)}`
        });
      } else {
        const failReason = result?.failReason ?? 'unknown';
        logger.addActivity('bond_exit', {
          message: `[EXIT] FAK failed attempt ${attempt} — failReason=${failReason} error=${result?.error ?? 'unknown'} | retry in ${this.config.exitRetrySecs}s`
        });

        // wrong_wallet_balance means the EOA holds zero tokens for this tokenId.
        // Retrying is pointless — the tokens were never here or are already gone.
        // Mark session done immediately to prevent it being stuck on dashboard forever.
        if (failReason === 'wrong_wallet_balance') {
          logger.addActivity('bond_exit', {
            message: `[EXIT] stale_session detected — EOA holds 0 tokens for tokenId=${tokenId.slice(0, 14)}… — marking done (no tokens to sell) | "${this.market.question.slice(0, 50)}"`
          });
          this._remainingTokens = 0;
          break;
        }
      }

      if (this._remainingTokens <= 0.01) break;
      await new Promise(r => setTimeout(r, retrySecs));
    }

    // ── POST LOOP ─────────────────────────────────────────────────────────────

    if (this._remainingTokens <= 0.01) {
      // All tokens sold — record PnL and close session normally
      logger.addActivity('bond_exit', {
        message: `[EXIT] fully flat — all tokens sold | "${this.market.question.slice(0, 50)}"`
      });

      const grossPnl = this._totalProceeds - this.filledAmount;
      const fee      = this.filledAmount * ESTIMATED_FEE_RATE;
      const netPnl   = grossPnl - fee;
      this.pnl        = grossPnl;
      this.resolvedAt = new Date().toISOString();
      if (grossPnl < 0) safety.recordLoss(Math.abs(grossPnl));
      else safety.recordWin(grossPnl);

      if (this.tradeId) {
        logger.updateTrade(this.tradeId, {
          result:     grossPnl >= 0 ? 'win' : 'loss',
          pnl:        grossPnl,
          exitReason: this.lastExitReason || 'stop_loss'
        });
      }
      logger.addActivity(grossPnl >= 0 ? 'bond_done' : 'bond_loss', {
        message: `[EXIT] result: gross=${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(3)} net=${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(3)} | reason=${this.lastExitReason} attempts=${this.exitAttemptCount} | "${this.market.question.slice(0, 40)}"`
      });
      marketWatcher.unsubscribe(tokenId);
      this._liquidating = false;
      this.phase = 'done';

    } else {
      // Tokens still held — do NOT mark done.
      // Reset _liquidating=false so the fast loop re-triggers this function
      // on the next tick. Session stays 'liquidating' and remains visible
      // on the dashboard until tokens are actually flat.
      logger.addActivity('bond_exit', {
        message: `[EXIT] unresolved risk, still holding tokens: ${this._remainingTokens.toFixed(4)} remaining | all_no_bid=${allNoBid} | session stays liquidating — auto-retry on next fast loop tick | "${this.market.question.slice(0, 40)}"`
      });
      this._liquidating = false;
      // phase stays 'liquidating' — NEVER done while tokens > 0
    }
  }

  // ─── STALE SESSION GUARD ────────────────────────────────────────────────────
  // Called from the fast loop for sessions stuck in 'liquidating' or 'holding'
  // longer than STALE_SESSION_MINUTES. Reads actual on-chain CTF balance and
  // auto-clears the session if the wallet holds no tokens.

  async checkStaleSession() {
    // Only check liquidating sessions — holding sessions use checkResolution()
    // which fires every 30s and handles game-end cleanup cleanly.
    // Liquidating sessions should complete in seconds to minutes;
    // anything older than STALE_SESSION_MINUTES with zero on-chain balance is stale.
    if (this.phase !== 'liquidating') return;
    if (this._liquidating) return;
    if (this._staleChecking) return;
    if (!this._liquidationStartedAt) return;

    const staleMinutes = parseInt(process.env.STALE_SESSION_MINUTES) || 8;
    const staleMs      = staleMinutes * 60 * 1000;
    const ageMs        = Date.now() - this._liquidationStartedAt;
    if (ageMs < staleMs) return;

    this._staleChecking = true;
    try {
      const { getPublicClient, getEoaAddress, getProxyWallet } = require('./trader');
      const publicClient = getPublicClient ? getPublicClient() : null;
      const eoaAddr      = getEoaAddress();
      const safeAddr     = getProxyWallet();
      const tokenId      = this.market.yesTokenId;

      if (!publicClient || !eoaAddr) return;

      const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
      const ERC1155_BAL = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ type: 'uint256' }] }];

      const eoaRaw  = await publicClient.readContract({ address: CTF_ADDRESS, abi: ERC1155_BAL, functionName: 'balanceOf', args: [eoaAddr, BigInt(tokenId)] });
      const eoaBal  = Number(eoaRaw) / 1e6;

      let safeBal = 0;
      if (safeAddr) {
        const safeRaw = await publicClient.readContract({ address: CTF_ADDRESS, abi: ERC1155_BAL, functionName: 'balanceOf', args: [safeAddr, BigInt(tokenId)] });
        safeBal = Number(safeRaw) / 1e6;
      }

      const totalBal = eoaBal + safeBal;
      logger.addActivity('bond_exit', {
        message: `[STALE-CHECK] phase=${this.phase} age=${Math.floor(ageMs / 60000)}min tokenId=${tokenId.slice(0, 14)}… eoa_bal=${eoaBal.toFixed(4)} safe_bal=${safeBal.toFixed(4)} total=${totalBal.toFixed(4)} remaining_in_session=${this._remainingTokens.toFixed(4)} | "${this.market.question.slice(0, 45)}"`
      });

      if (totalBal < 0.01) {
        logger.addActivity('bond_exit', {
          message: `[STALE-CHECK] auto-clearing — on-chain CTF balance is zero for both wallets. Session was stale (${this.phase}). Marking done. | "${this.market.question.slice(0, 50)}"`
        });
        this._remainingTokens = 0;
        this.phase            = 'done';
      }
    } catch (err) {
      logger.addActivity('bond_error', {
        message: `[STALE-CHECK] error: ${err.message?.slice(0, 80)}`
      });
    } finally {
      this._staleChecking = false;
    }
  }

  // ─── RESOLUTION ─────────────────────────────────────────────────────────────

  async checkResolutionWhileBuying() {
    if (this.phase !== 'buying') return;
    if (!this.market.conditionId) return;

    const res = await checkMarketResolved(this.market.conditionId);
    if (!res || (!res.resolved && !res.closed)) return;

    logger.addActivity('bond_cancelled', {
      message: `[BUY] market resolved before fill confirmed — checking on-chain balance for "${this.market.question.slice(0, 50)}"`
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
      logger.addActivity('bond_error', { message: `No conditionId for resolution check: ${this.market.question.slice(0, 50)}` });
      return;
    }

    const res = await checkMarketResolved(this.market.conditionId);
    if (!res) return;

    // Only finalise on actual resolution — outcomePrices are only set once
    // resolved=true. Triggering on closed-but-not-resolved gives yesWon=null
    // and falls through to an unreliable lastMid fallback, causing false losses.
    if (res.resolved) {
      await this._finalise(res);
    }
  }

  async _finalise(res) {
    if (this.phase !== 'holding' && this.phase !== 'liquidating') { this.phase = 'done'; return; }

    // If we're mid-liquidation, let it finish first
    if (this._liquidating) return;

    let yesWon;
    if (res.yesWon !== null && res.yesWon !== undefined) {
      yesWon = res.yesWon;
    } else {
      // outcomePrices not yet set on Gamma — don't guess with lastMid, that
      // causes false losses when the market resolves a moment later.
      // Log and keep holding; next resolution check (30s) will retry.
      logger.addActivity('bond_error', {
        message: `[RESOLVE] outcome not yet set on Gamma for "${this.market.question.slice(0, 50)}" — holding, will retry in 30s`
      });
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

    // Unsubscribe from live market data — no longer needed after resolution
    marketWatcher.unsubscribe(this.market.yesTokenId);

    if (result === 'win') {
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
      logger.addActivity('redeemer_error', {
        message: `[Soccer] Giving up on redemption after 2 hours: "${this.market.question.slice(0, 50)}"`
      });
      this.phase = 'done';
    }
  }

  getStatus() {
    const priceForPnl = this.currentBestBid ?? this.lastMid;
    let unrealizedPnL = null;
    if ((this.phase === 'holding' || this.phase === 'liquidating' || this.phase === 'buying') &&
        this.filledAmount > 0 && priceForPnl !== null) {
      const tokens = this.filledTokens > 0 ? this.filledTokens : (this.filledAmount / (this.entryPrice || 0.95));
      unrealizedPnL = parseFloat(((priceForPnl * tokens) - this.filledAmount).toFixed(4));
    }

    const now         = new Date();
    const endDate     = new Date(this.market.endDate);
    const minutesLeft = Math.max(0, Math.round((endDate - now) / 60000));

    return {
      id:               this.id,
      question:         this.market.question,
      eventTitle:       this.market.eventTitle,
      phase:            this.phase,
      lastMid:          this.lastMid,
      currentBestBid:   this.currentBestBid,
      currentBestAsk:   this.currentBestAsk,
      currentSpread:    this.currentSpread,
      peakBestBid:      this.peakBestBid,
      entryPrice:       this.entryPrice,
      filledTokens:     this.filledTokens,
      filledAmount:     this.filledAmount,
      remainingTokens:  this._remainingTokens,
      unrealizedPnL,
      pnl:              this.pnl,
      endDate:          this.market.endDate,
      minutesLeft,
      threshold:        this.config.threshold,
      stopLoss:         this.config.stopLoss,
      trailingStop:     this.config.trailingStop,
      exitAttemptCount: this.exitAttemptCount,
      lastExitReason:   this.lastExitReason,
      wsConnected:      marketWatcher.isConnected(),
      createdAt:        this.createdAt.toISOString(),
      yesTokenId:       this.market.yesTokenId,
      negRisk:          this.market.negRisk,
      tickSize:         this.market.tickSize || '0.01'
    };
  }
}

module.exports = { BondSession, getBondConfig, fetchMidpoint };
