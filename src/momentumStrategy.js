const { Side, OrderType } = require('@polymarket/clob-client-v2');
const krakenFeed = require('./krakenFeed');
const logger = require('./logger');
const safety = require('./safety');
const { placeSellOrder, buildClobAuthHeaders, getUsdcBalance } = require('./trader');

const ESTIMATED_FEE_RATE = 0.02;

const CLOB_API = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// Defensive CLOB preflight — bypasses SDK's getTickSize() which has no null
// guard and crashes with "Cannot read properties of undefined (reading
// 'toString')" when the API returns {"error":"market not found"}.
//
// Returns { ok, reason, tickSize? } — never throws, never calls .toString()
// on potentially-undefined values. Uses String() for all conversions.
// ---------------------------------------------------------------------------
const _clobPreflightCache = new Map(); // tokenId -> { ts, reason }
const PREFLIGHT_COOLDOWN_MS = 3 * 60 * 1000; // 3 min — suppress repeat logs

async function safeGetTickSize(tokenId) {
  if (!tokenId || typeof tokenId !== 'string' || !tokenId.trim()) {
    return { ok: false, reason: 'invalid_token_id' };
  }

  const cached = _clobPreflightCache.get(tokenId);
  if (cached && (Date.now() - cached.ts) < PREFLIGHT_COOLDOWN_MS) {
    return { ok: false, reason: cached.reason, cached: true };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(
        `${CLOB_API}/tick-size?token_id=${encodeURIComponent(tokenId)}`,
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res || !res.ok) {
      _clobPreflightCache.set(tokenId, { ts: Date.now(), reason: 'clob_lookup_failed' });
      return { ok: false, reason: 'clob_lookup_failed' };
    }

    let data;
    try { data = await res.json(); } catch {
      _clobPreflightCache.set(tokenId, { ts: Date.now(), reason: 'clob_lookup_failed' });
      return { ok: false, reason: 'clob_lookup_failed' };
    }

    if (!data || data.error) {
      _clobPreflightCache.set(tokenId, { ts: Date.now(), reason: 'token_not_indexed' });
      return { ok: false, reason: 'token_not_indexed' };
    }

    const raw = data.minimum_tick_size;
    if (raw === null || raw === undefined) {
      _clobPreflightCache.set(tokenId, { ts: Date.now(), reason: 'tick_size_missing' });
      return { ok: false, reason: 'tick_size_missing' };
    }

    const tickSize = String(raw);
    if (!tickSize || tickSize === 'undefined' || tickSize === 'null' || tickSize === 'NaN') {
      _clobPreflightCache.set(tokenId, { ts: Date.now(), reason: 'tick_size_missing' });
      return { ok: false, reason: 'tick_size_missing' };
    }

    _clobPreflightCache.delete(tokenId);
    return { ok: true, tickSize };

  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    const reason = isTimeout ? 'clob_lookup_failed' : 'unexpected_exception';
    _clobPreflightCache.set(tokenId, { ts: Date.now(), reason });
    const detail = (err && err.message) ? String(err.message).slice(0, 80) : 'unknown';
    return { ok: false, reason, detail };
  }
}

const PREFLIGHT_REASON_DESC = {
  invalid_token_id:      'invalid_token_id — tokenId is null/undefined/not a string',
  token_not_indexed:     'token_not_indexed — fresh BTC 15m token not yet registered on CLOB (normal, retrying in 3 min)',
  tick_size_missing:     'tick_size_missing — CLOB responded but minimum_tick_size field is absent',
  clob_lookup_failed:    'clob_lookup_failed — CLOB API HTTP error or request timed out',
  market_metadata_missing: 'market_metadata_missing — market object missing upTokenId/downTokenId',
  unexpected_exception:  'unexpected_exception',
};

function getMomentumConfig() {
  const orderPctRaw = process.env.MOM_ORDER_PCT ? parseFloat(process.env.MOM_ORDER_PCT) : null;
  return {
    orderSize:          parseFloat(process.env.MOM_ORDER_SIZE)          || 5,
    orderPct:           orderPctRaw,
    orderPctMin:        parseFloat(process.env.MOM_ORDER_PCT_MIN)       || 2,
    orderPctMax:        parseFloat(process.env.MOM_ORDER_PCT_MAX)       || 20,
    trailingStop:       parseFloat(process.env.MOM_TRAILING_STOP)       || 0.03,
    trailingActivate:   parseFloat(process.env.MOM_TRAILING_ACTIVATE)   || 0.08,
    stopLossCents:      parseFloat(process.env.MOM_STOP_LOSS)           || 0.10,
    takeProfit:         parseFloat(process.env.MOM_TAKE_PROFIT)         || 0.75,
    momentumThreshold:  parseFloat(process.env.MOM_THRESHOLD)           || 0.12,
    midMin:             parseFloat(process.env.MOM_MID_MIN)             || 0.25,
    midMax:             parseFloat(process.env.MOM_MID_MAX)             || 0.75,
    entryAfterSeconds:  parseInt(process.env.MOM_ENTRY_AFTER_SECONDS)   || 30,
    closeSeconds:       parseInt(process.env.MOM_CLOSE_SECONDS)         || 240,
    entryWindowSeconds: parseInt(process.env.MOM_ENTRY_WINDOW_SECONDS)  || 240,
    maxSpread:          parseFloat(process.env.MOM_MAX_SPREAD)          || 0.03,
    refreshInterval:    parseInt(process.env.MM_REFRESH_INTERVAL)       || 10,
    marketType:         process.env.MOM_MARKET_TYPE                     || '15m',
    maxFlips:           parseInt(process.env.MOM_MAX_FLIPS)             || 0,
    flipMinSeconds:     parseInt(process.env.MOM_FLIP_MIN_SECONDS)      || 45,
    volFilter:          process.env.MOM_VOL_FILTER !== 'false',
    noTradeZoneMin:     parseFloat(process.env.MOM_NO_TRADE_MIN)        || 0.46,
    noTradeZoneMax:     parseFloat(process.env.MOM_NO_TRADE_MAX)        || 0.54,
    noTradeHighConf:    parseFloat(process.env.MOM_NO_TRADE_HCONF)      || 0.20,
    minNetEdgeCents:    parseFloat(process.env.MOM_MIN_EDGE_CENTS)      || 0.05,
    require5mConfirm:   process.env.MOM_REQUIRE_5M !== 'false',
    minBookDepth:       parseFloat(process.env.MOM_MIN_DEPTH)           || 30,
    maxDailyTrades:     parseInt(process.env.MOM_MAX_DAILY_TRADES)      || 6,
    makerWaitSeconds:   parseInt(process.env.MOM_MAKER_WAIT_SECONDS)    || 20
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

// fetchBook: returns real bid, ask, spread, and top-of-book depth in USD.
// Used for entry price determination and exit price determination.
// Never uses midpoint as the tradable reference.
async function fetchBook(tokenId) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const bids = (data.bids || [])
      .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size || 0) }))
      .filter(b => b.price > 0);
    const asks = (data.asks || [])
      .map(a => ({ price: parseFloat(a.price), size: parseFloat(a.size || 0) }))
      .filter(a => a.price > 0);
    if (bids.length === 0 || asks.length === 0) return null;
    const bestBid = Math.max(...bids.map(b => b.price));
    const bestAsk = Math.min(...asks.map(a => a.price));
    const bidDepth = bids
      .filter(b => b.price === bestBid)
      .reduce((s, b) => s + b.size * b.price, 0);
    const askDepth = asks
      .filter(a => a.price === bestAsk)
      .reduce((s, a) => s + a.size * a.price, 0);
    return {
      bid:      bestBid,
      ask:      bestAsk,
      spread:   parseFloat((bestAsk - bestBid).toFixed(4)),
      mid:      parseFloat(((bestBid + bestAsk) / 2).toFixed(4)),
      bidDepth: parseFloat(bidDepth.toFixed(2)),
      askDepth: parseFloat(askDepth.toFixed(2))
    };
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

let _lastFetchSourceLog = 0;

async function fetchOrderStatus(client, orderId) {
  const sdkResult = client ? await fetchOrderStatusSDK(client, orderId) : null;
  if (sdkResult) {
    const now = Date.now();
    if (now - _lastFetchSourceLog >= 30000) {
      _lastFetchSourceLog = now;
      logger.addActivity('fill_debug', { message: `[fetchOrderStatus] SDK succeeded for order ${orderId.slice(0, 14)}...` });
    }
    return sdkResult;
  }
  const rawResult = await fetchOrderStatusRaw(orderId);
  if (rawResult) {
    const now = Date.now();
    if (now - _lastFetchSourceLog >= 30000) {
      _lastFetchSourceLog = now;
      logger.addActivity('fill_debug', { message: `[fetchOrderStatus] REST fallback succeeded for order ${orderId.slice(0, 14)}...` });
    }
  }
  return rawResult;
}

class MomentumSession {
  constructor(market, config) {
    this.market  = market;
    this.config  = { ...config };

    if (market.type === '5m') {
      this.config.entryAfterSeconds = Math.min(config.entryAfterSeconds, 60);
      this.config.closeSeconds      = Math.min(config.closeSeconds, 10);
      this.config.flipMinSeconds    = Math.min(config.flipMinSeconds, 30);
      this.config.momentumThreshold = Math.min(config.momentumThreshold, 0.03);
    }

    this.phase          = 'waiting';
    this.cancelled      = false;
    this.lastNoSignalLog = 0;

    this._resetTradeLeg();

    this.flipCount          = 0;
    this.cumulativePnl      = 0;
    this.cumulativeFees     = 0;
    this.cumulativeNetPnl   = 0;
    this.totalSpent         = 0;
    this.tradeIds           = [];
    this.btcChange3m        = null;
    this.lastMid            = null;

    // NEW: signal quality and book state for dashboard + logic
    this.lastConfidence     = null;
    this.lastSkipReason     = null;
    this.lastBid            = null;
    this.lastAsk            = null;
    this.lastSpread         = null;
    this.lastBidDepth       = null;
    this.lastAskDepth       = null;
    this.lastRegime         = null;
    this.lastEstimatedEdge  = null;
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

    this.estimatedBuyFee   = 0;

    this._lastFillDebugLog  = 0;
    this._lastMidDebugLog   = 0;
    this._lastTrailingLog   = 0;
    this._lastExitDebugLog  = 0;

    this._entryTimestamp     = null;
    this._spreadAtEntry      = null;
    this._btcSignalAtEntry   = null;
    this._secondsLeftAtEntry = null;
    this._spreadAtExit       = null;
    this._secondsLeftAtExit  = null;
  }

  get marketId()    { return this.market.id; }
  get secondsLeft() { return Math.max(0, (this.market.endTime - Date.now()) / 1000); }

  isClosing()  { return this.secondsLeft <= this.config.closeSeconds; }
  isTooEarly() {
    const total = this.market.intervalSeconds || 900;
    return this.secondsLeft > (total - this.config.entryAfterSeconds);
  }
  isTooLateToEnter() {
    const total = this.market.intervalSeconds || 900;
    const windowSeconds = this.config.entryWindowSeconds || 240;
    return this.secondsLeft < (total - windowSeconds);
  }

  // ---------------------------------------------------------------------------
  // getSignal: returns 'UP' | 'DOWN' | null
  // Requires 3m BTC change >= threshold AND 5m direction agreement (if enabled).
  // Computes a confidence score 0-1 based on multi-timeframe agreement + strength.
  // Sets this.lastConfidence, this.lastSkipReason, this.lastRegime.
  // ---------------------------------------------------------------------------
  getSignal() {
    const ctx = krakenFeed.getPriceContext();
    if (!ctx.available || !ctx.change3m) {
      this.lastSkipReason = 'no_btc_data';
      return null;
    }

    const change3m = parseFloat(ctx.change3m.percent);
    const change1m = ctx.change1m ? parseFloat(ctx.change1m.percent) : null;
    const change5m = ctx.change5m ? parseFloat(ctx.change5m.percent) : null;

    this.btcChange3m = change3m;

    let rawSignal = null;
    if (change3m >= this.config.momentumThreshold)  rawSignal = 'UP';
    if (change3m <= -this.config.momentumThreshold) rawSignal = 'DOWN';

    if (!rawSignal) {
      this.lastSkipReason = `weak_signal: 3m=${change3m.toFixed(3)}% (need ±${this.config.momentumThreshold}%)`;
      this.lastConfidence = 0;
      return null;
    }

    const sigDir = rawSignal === 'UP' ? 1 : -1;

    // 5-minute confirmation: 5m trend must not oppose 3m signal
    if (this.config.require5mConfirm && change5m !== null) {
      const fiveDir = change5m > 0.01 ? 1 : change5m < -0.01 ? -1 : 0;
      if (fiveDir !== 0 && fiveDir !== sigDir) {
        this.lastSkipReason = `5m_disagrees: 3m=${change3m.toFixed(3)}% ${rawSignal} but 5m=${change5m.toFixed(3)}% opposes`;
        this.lastConfidence = 0;
        return null;
      }
    }

    // Chop filter: 1m must agree with 3m
    if (this.config.volFilter && krakenFeed.isChoppyMarket()) {
      this.lastSkipReason = `choppy: 1m=${change1m?.toFixed(3) || '?'}% vs 3m=${change3m.toFixed(3)}% disagree`;
      this.lastConfidence = 0;
      return null;
    }

    // Confidence score: signal strength × timeframe agreement
    let conf = Math.min(1.0, Math.abs(change3m) / (this.config.momentumThreshold * 4));

    if (change1m !== null) {
      const oneDir = change1m > 0.01 ? 1 : change1m < -0.01 ? -1 : 0;
      if (oneDir === sigDir)      conf = Math.min(1.0, conf + 0.25);
      else if (oneDir !== 0)      conf = Math.max(0, conf - 0.25);
    }
    if (change5m !== null) {
      const fiveDir = change5m > 0.01 ? 1 : change5m < -0.01 ? -1 : 0;
      if (fiveDir === sigDir)     conf = Math.min(1.0, conf + 0.15);
    }

    this.lastConfidence = parseFloat(conf.toFixed(3));
    this.lastSkipReason = null;

    // Regime classification for dashboard
    const allAgree = (change1m === null || (change1m > 0) === (change3m > 0)) &&
                     (change5m === null || (change5m > 0) === (change3m > 0));
    this.lastRegime = allAgree ? 'TREND' : 'MIXED';

    return rawSignal;
  }

  async attemptEntry(client) {
    if (!client) {
      logger.addActivity('mom_skip', {
        message: `[${this.market.coin}-${this.market.type}] No CLOB client — set WALLET_PRIVATE_KEY + POLY_API_KEY`
      });
      this.phase = 'done';
      return;
    }

    // Safety: daily trade limit
    const safetyStatus = safety.getStatus();
    if (safetyStatus.dailyTradeCount >= this.config.maxDailyTrades) {
      const now = Date.now();
      if (now - this.lastNoSignalLog >= 60000) {
        this.lastNoSignalLog = now;
        logger.addActivity('mom_skip', {
          message: `[${this.market.coin}-${this.market.type}] Daily trade limit reached (${safetyStatus.dailyTradeCount}/${this.config.maxDailyTrades}) — no new entries today`
        });
      }
      return;
    }

    // Safety: cooldown after a loss
    const cooldown = safety.getCooldownRemaining();
    if (cooldown > 0) {
      const now = Date.now();
      if (now - this.lastNoSignalLog >= 30000) {
        this.lastNoSignalLog = now;
        logger.addActivity('mom_skip', {
          message: `[${this.market.coin}-${this.market.type}] Loss cooldown: ${Math.ceil(cooldown)}s remaining — skipping entry`
        });
      }
      return;
    }

    // Safety: losing streak stop
    if (safety.consecutiveLosses >= safety.losingStreakStop) {
      const now = Date.now();
      if (now - this.lastNoSignalLog >= 60000) {
        this.lastNoSignalLog = now;
        logger.addActivity('mom_skip', {
          message: `[${this.market.coin}-${this.market.type}] Losing streak (${safety.consecutiveLosses}) hit limit (${safety.losingStreakStop}) — paused until next window`
        });
      }
      return;
    }

    const signal = this.getSignal();
    if (!signal) {
      const now = Date.now();
      if (now - this.lastNoSignalLog >= 60000) {
        const ctx = krakenFeed.getPriceContext();
        logger.addActivity('mom_skip', {
          message: `[${this.market.coin}-${this.market.type}] No signal — ${this.lastSkipReason || `BTC 3m: ${ctx.change3m?.percent || '?'}%`} | conf=${this.lastConfidence ?? '?'} | ${Math.round(this.secondsLeft)}s left`
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

    const liveSignal = this.getSignal();
    if (!liveSignal) {
      this.phase = 'done';
      logger.addActivity('mom_done', {
        message: `[${this.market.coin}-${this.market.type}] No BTC signal for re-entry — holding done | cumulative P&L: ${this.cumulativePnl >= 0 ? '+' : ''}$${this.cumulativePnl.toFixed(3)}`
      });
      return;
    }
    await this._enterSide(client, liveSignal, 'flip');
  }

  async _enterSide(client, side, reason) {
    const mkt = `${this.market.coin}-${this.market.type}`;

    const tokenId = side === 'UP' ? this.market.upTokenId : this.market.downTokenId;
    if (!tokenId || typeof tokenId !== 'string') {
      logger.addActivity('mom_error', {
        message: `[${mkt}] market_metadata_missing: ${side}TokenId is ${tokenId === undefined ? 'undefined' : tokenId === null ? 'null' : 'empty'} — skipping`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    // Fetch real orderbook — this is the ground truth for price, not midpoint
    const book = await fetchBook(tokenId);
    if (!book) {
      logger.addActivity('mom_skip', {
        message: `[${mkt}] Cannot fetch orderbook — skipping | ${Math.round(this.secondsLeft)}s left`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    // Update session state for dashboard
    this.lastBid      = book.bid;
    this.lastAsk      = book.ask;
    this.lastSpread   = book.spread;
    this.lastBidDepth = book.bidDepth;
    this.lastAskDepth = book.askDepth;
    this.lastMid      = book.mid;

    logger.addActivity('mom_book', {
      message: `[${mkt}] Book: bid=$${book.bid.toFixed(3)} ask=$${book.ask.toFixed(3)} spread=${(book.spread * 100).toFixed(1)}¢ bidDepth=$${book.bidDepth.toFixed(1)} askDepth=$${book.askDepth.toFixed(1)} | ${Math.round(this.secondsLeft)}s left`
    });

    // Spread too wide — skip
    if (book.spread > this.config.maxSpread) {
      this.lastSkipReason = `spread_${(book.spread * 100).toFixed(1)}c_>_max_${(this.config.maxSpread * 100).toFixed(0)}c`;
      logger.addActivity('mom_skip', {
        message: `[${mkt}] SPREAD ${(book.spread * 100).toFixed(1)}¢ > max ${(this.config.maxSpread * 100).toFixed(0)}¢ — skipping | ${Math.round(this.secondsLeft)}s left`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    // Book depth check — skip if top-of-book is too thin
    if (book.askDepth < this.config.minBookDepth) {
      this.lastSkipReason = `thin_book_ask_depth_$${book.askDepth.toFixed(1)}_<_$${this.config.minBookDepth}`;
      logger.addActivity('mom_skip', {
        message: `[${mkt}] Ask depth $${book.askDepth.toFixed(1)} < min $${this.config.minBookDepth} — thin book, skipping | ${Math.round(this.secondsLeft)}s left`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    const mid = book.mid;

    // Mid range check
    if (mid < this.config.midMin || mid > this.config.midMax) {
      this.lastSkipReason = `mid_${mid.toFixed(3)}_outside_[${this.config.midMin}-${this.config.midMax}]`;
      logger.addActivity('mom_skip', {
        message: `[${mkt}] ${side} mid=$${mid.toFixed(3)} outside [${this.config.midMin}–${this.config.midMax}] — ${reason === 'flip' ? 'skipping flip' : 'skipping entry'}`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    // No-trade zone: mid is near 50/50 — signal is weakest here
    const inNoTradeZone = mid >= this.config.noTradeZoneMin && mid <= this.config.noTradeZoneMax;
    if (inNoTradeZone) {
      const needsHighConf = this.config.noTradeHighConf;
      const conf = this.lastConfidence || 0;
      if (conf < needsHighConf) {
        this.lastSkipReason = `no_trade_zone_mid=${mid.toFixed(3)}_conf=${conf.toFixed(3)}_<_${needsHighConf}`;
        logger.addActivity('mom_skip', {
          message: `[${mkt}] NO-TRADE ZONE: mid=$${mid.toFixed(3)} in [${this.config.noTradeZoneMin}-${this.config.noTradeZoneMax}] | conf=${conf.toFixed(3)} < required ${needsHighConf} — skipping weak 50/50 setup`
        });
        this.phase = reason === 'flip' ? 'done' : 'waiting';
        return;
      }
    }

    // CLOB preflight
    const preflight = await safeGetTickSize(tokenId);
    if (!preflight.ok) {
      if (!preflight.cached) {
        const desc = PREFLIGHT_REASON_DESC[preflight.reason] || preflight.reason + (preflight.detail ? ` — ${preflight.detail}` : '');
        logger.addActivity('mom_skip', {
          message: `[${mkt}] Preflight skip (${preflight.reason}): ${desc} | token ${tokenId.slice(0, 14)}…`
        });
      }
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }
    logger.addActivity('mom_entry', {
      message: `[${mkt}] Preflight OK — tick_size=${preflight.tickSize} | token ${tokenId.slice(0, 14)}… | proceeding to order`
    });

    if (client && client.tickSizes) {
      client.tickSizes[tokenId] = preflight.tickSize;
    }

    this._resetTradeLeg();
    this._spreadAtEntry      = book.spread;
    this._btcSignalAtEntry   = this.btcChange3m;
    this._secondsLeftAtEntry = Math.round(this.secondsLeft);
    this.signal     = side;
    this.tokenId    = tokenId;

    // Use the real ASK price (not midpoint) as entry — ensures we know exactly
    // what we're paying and the order is genuinely executable at this level.
    // Round up to nearest cent to guarantee taker fill.
    const entryAsk  = Math.ceil(book.ask * 100) / 100;
    this.entryPrice = Math.min(0.97, entryAsk);

    let orderSize = this.config.orderSize;
    if (this.config.orderPct) {
      try {
        const balance = await getUsdcBalance();
        if (balance !== null && balance > 0) {
          const pctSize = parseFloat((balance * this.config.orderPct).toFixed(2));
          orderSize = Math.min(this.config.orderPctMax, Math.max(this.config.orderPctMin, pctSize));
          logger.addActivity('mom_entry', {
            message: `[${mkt}] Dynamic sizing: balance=$${balance.toFixed(2)} × ${(this.config.orderPct * 100).toFixed(0)}% → $${orderSize.toFixed(2)}`
          });
        } else {
          logger.addActivity('mom_entry', {
            message: `[${mkt}] Dynamic sizing: balance fetch failed — using fixed $${orderSize}`
          });
        }
      } catch (err) {
        logger.addActivity('mom_entry', {
          message: `[${mkt}] Dynamic sizing error: ${err.message?.slice(0, 60)} — using fixed $${orderSize}`
        });
      }
    }

    this.entrySizeTokens   = parseFloat((orderSize / this.entryPrice).toFixed(2));
    this._currentOrderSize = orderSize;

    // Fee-aware edge check: estimated net edge per token after round-trip fees
    const estBuyFee    = this.entryPrice * ESTIMATED_FEE_RATE;
    const estSellFee   = this.config.takeProfit * ESTIMATED_FEE_RATE;
    const estGrossEdge = this.config.takeProfit - this.entryPrice;
    const estNetEdge   = estGrossEdge - estBuyFee - estSellFee;
    this.lastEstimatedEdge = parseFloat(estNetEdge.toFixed(4));

    if (estNetEdge < this.config.minNetEdgeCents) {
      this.lastSkipReason = `edge_${estNetEdge.toFixed(4)}_<_min_${this.config.minNetEdgeCents}`;
      logger.addActivity('mom_skip', {
        message: `[${mkt}] FEE CHECK FAILED: estimated net edge ${(estNetEdge * 100).toFixed(2)}¢/token < min ${(this.config.minNetEdgeCents * 100).toFixed(2)}¢ — ask=$${this.entryPrice} TP=$${this.config.takeProfit} fees≈${((estBuyFee + estSellFee) * 100).toFixed(2)}¢ — skipping`
      });
      this.phase = reason === 'flip' ? 'done' : 'waiting';
      return;
    }

    const conf = this.lastConfidence !== null ? this.lastConfidence : '?';
    if (reason === 'flip') {
      logger.addActivity('mom_flip', {
        message: `[${mkt}] FLIP → ${side} | ask=$${this.entryPrice} mid=$${mid.toFixed(3)} | conf=${conf} | edge=+${(estNetEdge * 100).toFixed(2)}¢/tok | ${Math.round(this.secondsLeft)}s left`
      });
    } else {
      const ctx = krakenFeed.getPriceContext();
      logger.addActivity('mom_signal', {
        message: `[${mkt}] SIGNAL: ${side} | BTC 3m: ${ctx.change3m?.percent || '?'}% | regime=${this.lastRegime || '?'} | conf=${conf} | edge=+${(estNetEdge * 100).toFixed(2)}¢/tok | ask=$${this.entryPrice} (was mid=$${mid.toFixed(3)}) | ${Math.round(this.secondsLeft)}s left`
      });
    }

    logger.addActivity('mom_entry', {
      message: `[${mkt}] BUY ${side} @ $${this.entryPrice} (ask) | ${this.entrySizeTokens} tokens | SL: -${(this.config.stopLossCents * 100).toFixed(0)}¢ | TP: $${this.config.takeProfit} | trail: ${(this.config.trailingStop * 100).toFixed(0)}¢ (activates ${(this.config.trailingActivate * 100).toFixed(0)}¢ above entry)`
    });

    this.phase = 'entering';

    try {
      const order = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price:   this.entryPrice,
          size:    this.entrySizeTokens,
          side:    Side.BUY
        },
        { tickSize: preflight.tickSize, negRisk: this.market.negRisk === true },
        OrderType.GTC
      );

      if (order && order.orderID) {
        this.entryOrderId = order.orderID;
        this.totalSpent  += this._currentOrderSize || this.config.orderSize;
        safety.recordTrade(this._currentOrderSize || this.config.orderSize);
        if (reason === 'flip') {
          this.flipCount++;
          logger.addActivity('mom_flip', {
            message: `[${mkt}] FLIP #${this.flipCount} posted | orderId: ${order.orderID.slice(0, 14)}...`
          });
        } else {
          logger.addActivity('mom_entry', {
            message: `[${mkt}] BUY order posted | orderId: ${order.orderID.slice(0, 14)}...`
          });
        }
      } else {
        const err = order?.errorMsg || order?.error || JSON.stringify(order)?.slice(0, 60);
        logger.addActivity('mom_error', {
          message: `[${mkt}] BUY failed: ${err}`
        });
        this.phase = reason === 'flip' ? 'done' : 'waiting';
      }
    } catch (err) {
      logger.addActivity('mom_error', {
        message: `[${mkt}] BUY error: ${err.message?.slice(0, 80)}`
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
      this.entryFilled      = true;
      this.holdingToken     = true;
      this.filledSize       = matched;
      this.peakMid          = this.entryPrice;
      this.phase            = 'managing';
      this.estimatedBuyFee  = parseFloat((matched * this.entryPrice * ESTIMATED_FEE_RATE).toFixed(4));
      this._entryTimestamp  = new Date().toISOString();
      logger.addActivity('mom_filled', {
        message: `[${this.market.coin}-${this.market.type}] BUY FILLED — ${this.signal} ${matched} tokens @ $${this.entryPrice} | trail activates ${(this.config.trailingActivate * 100).toFixed(0)}¢ above entry | est. fee: $${this.estimatedBuyFee.toFixed(3)}`
      });
    } else if (orderStatus === 'CANCELED' || orderStatus === 'CANCELLED') {
      logger.addActivity('mom_error', {
        message: `[${this.market.coin}-${this.market.type}] Entry order cancelled`
      });
      this.phase = 'done';
    } else if (orderStatus === 'MATCHED') {
      this.entryFilled      = true;
      this.holdingToken     = true;
      this.filledSize       = origSize > 0 ? origSize : this.entrySizeTokens;
      this.peakMid          = this.entryPrice;
      this.phase            = 'managing';
      this.estimatedBuyFee  = parseFloat((this.filledSize * this.entryPrice * ESTIMATED_FEE_RATE).toFixed(4));
      this._entryTimestamp  = new Date().toISOString();
      logger.addActivity('mom_filled', {
        message: `[${this.market.coin}-${this.market.type}] BUY FILLED (MATCHED) — ${this.signal} ${this.filledSize} tokens @ $${this.entryPrice} | est. fee: $${this.estimatedBuyFee.toFixed(3)}`
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
          message: `[${this.market.coin}-${this.market.type}] Trailing stop — midpoint fetch returned NULL | ${Math.round(this.secondsLeft)}s left`
        });
      }
      return;
    }

    this.lastMid = mid;

    if (mid >= this.config.takeProfit) {
      logger.addActivity('mom_tp_target', {
        message: `[${this.market.coin}-${this.market.type}] TAKE PROFIT HIT — mid=$${mid.toFixed(3)} >= $${this.config.takeProfit} | entry=$${this.entryPrice} — cashing out`
      });
      await this._postExitSell(client, mid, 'take_profit');
      return;
    }

    const now3 = Date.now();
    if (!this._lastTrailingLog || now3 - this._lastTrailingLog >= 15000) {
      this._lastTrailingLog = now3;
      const stopLoss = Math.max(0.02, this.entryPrice - this.config.stopLossCents);
      logger.addActivity('fill_debug', {
        message: `[${this.market.coin}-${this.market.type}] Monitor — mid=$${mid.toFixed(3)} entry=$${this.entryPrice} peak=$${(this.peakMid || 0).toFixed(3)} trailActive=${this.trailingActive} stop=$${(this.trailingStopLevel || 0).toFixed(3)} SL=$${stopLoss.toFixed(3)} TP=$${this.config.takeProfit} | ${Math.round(this.secondsLeft)}s left`
      });
    }

    const stopLossPrice = Math.max(0.02, this.entryPrice - this.config.stopLossCents);

    if (!this.trailingActive && mid >= this.entryPrice + this.config.trailingActivate) {
      this.trailingActive    = true;
      this.peakMid           = mid;
      this.trailingStopLevel = Math.max(this.entryPrice, mid - this.config.trailingStop);
      logger.addActivity('mom_trailing', {
        message: `[${this.market.coin}-${this.market.type}] Profit protection ACTIVATED | peak=$${mid.toFixed(3)} | stop=$${this.trailingStopLevel.toFixed(3)} (floor=entry $${this.entryPrice})`
      });
    } else if (this.trailingActive) {
      if (mid > this.peakMid) {
        this.peakMid           = mid;
        this.trailingStopLevel = Math.max(this.entryPrice, mid - this.config.trailingStop);
        logger.addActivity('mom_peak', {
          message: `[${this.market.coin}-${this.market.type}] New peak=$${mid.toFixed(3)} | trail stop=$${this.trailingStopLevel.toFixed(3)} | unrealized: +$${((mid - this.entryPrice) * (this.filledSize || this.entrySizeTokens)).toFixed(3)}`
        });
      }

      if (mid <= this.trailingStopLevel) {
        await this._postExitSell(client, mid, 'trailing_stop');
        return;
      }
    }

    if (mid <= stopLossPrice) {
      await this._postExitSell(client, mid, 'stop_loss');
      return;
    }

    // Signal-flip fast exit: BTC reversed while we're below entry
    if (!this.trailingActive && mid < this.entryPrice) {
      const liveSignal = this.getSignal();
      if (liveSignal && liveSignal !== this.signal) {
        logger.addActivity('mom_flip_exit', {
          message: `[${this.market.coin}-${this.market.type}] SIGNAL FLIP — entered ${this.signal} but BTC now ${liveSignal} | mid=$${mid.toFixed(3)} < entry=$${this.entryPrice} — cutting`
        });
        await this._postExitSell(client, mid, 'signal_flip');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // _postExitSell: posts the exit sell order.
  // For defensive exits (stop_loss, trailing_stop, signal_flip):
  //   → fetches real orderbook and posts at best BID to guarantee immediate fill.
  //   → Never lets a stop-loss order rest unfilled while price keeps dropping.
  // For profit exits (take_profit, closing_cashout):
  //   → posts at mid (can afford to wait as a maker).
  // ---------------------------------------------------------------------------
  async _postExitSell(client, mid, reason) {
    if (this.phase !== 'managing' || !this.holdingToken || this.exitOrderId || this._exitInFlight) return false;

    this._exitInFlight = true;

    try {
      const exitSize = this.filledSize || this.entrySizeTokens;

      let exitPrice;
      const defensiveExit = reason === 'stop_loss' || reason === 'trailing_stop' || reason === 'signal_flip';

      if (defensiveExit) {
        // For stop/loss exits: use real best BID from orderbook to guarantee fill.
        // Posting at mid on a falling market means the order never fills.
        const exitBook = await fetchBook(this.tokenId);
        if (exitBook && exitBook.bid > 0) {
          // Post at best bid — crosses the book immediately as a taker
          exitPrice = Math.max(0.02, exitBook.bid);
          this._spreadAtExit = exitBook.spread;
          logger.addActivity('mom_book', {
            message: `[${this.market.coin}-${this.market.type}] Exit book: bid=$${exitBook.bid.toFixed(3)} ask=$${exitBook.ask.toFixed(3)} — using bid for guaranteed fill`
          });
        } else {
          // Fallback: use mid if book fetch fails
          exitPrice = Math.max(0.02, Math.min(0.97, Math.round(mid * 100) / 100));
          fetchBook(this.tokenId).then(bk => { if (bk) this._spreadAtExit = bk.spread; }).catch(() => {});
        }
      } else {
        // Profit exit: post at rounded mid (maker-friendly, we're winning)
        exitPrice = Math.max(0.02, Math.min(0.97, Math.round(mid * 100) / 100));
        fetchBook(this.tokenId).then(bk => { if (bk) this._spreadAtExit = bk.spread; }).catch(() => {});
      }

      const labels = {
        trailing_stop:   'TRAILING STOP',
        stop_loss:       'STOP LOSS',
        time_exit:       'TIME EXIT',
        closing_cashout: 'CLOSING CASHOUT',
        take_profit:     'TAKE PROFIT',
        signal_flip:     'SIGNAL FLIP EXIT'
      };
      const label = labels[reason] || reason.toUpperCase();
      const peakStr = this.peakMid ? ` | peak was $${this.peakMid.toFixed(3)}` : '';
      const activityType = (reason === 'stop_loss') ? 'mom_sl' : 'mom_tp_hit';
      const fillMode = defensiveExit ? 'TAKER (bid)' : 'MAKER (mid)';

      logger.addActivity(activityType, {
        message: `[${this.market.coin}-${this.market.type}] ${label} | ${this.signal} mid=$${mid.toFixed(3)}${peakStr} | posting sell @ $${exitPrice.toFixed(3)} [${fillMode}]`
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
          message: `[${this.market.coin}-${this.market.type}] Exit sell POST failed: ${result.error?.slice(0, 80)} — will retry`
        });
        return false;
      }

      this.exitOrderId        = result.orderId;
      this.exitPostedPrice    = exitPrice;
      this.exitSize           = exitSize;
      this.exitFilledSoFar    = 0;
      this._lastExitReason    = reason;
      this._secondsLeftAtExit = Math.round(this.secondsLeft);
      this.phase              = 'exiting';

      logger.addActivity(activityType, {
        message: `[${this.market.coin}-${this.market.type}] Exit sell posted @ $${exitPrice.toFixed(3)} | orderId: ${result.orderId?.slice(0, 14)}... | waiting for fill`
      });
      return true;
    } finally {
      this._exitInFlight = false;
    }
  }

  // ---------------------------------------------------------------------------
  // _recordTradeClose: called when exit is fully filled.
  // Wires into safety system for real loss/win tracking.
  // ---------------------------------------------------------------------------
  _recordTradeClose(fillPrice, exitQty, tradePnl, tradeNetPnl, tradeFeeTotal) {
    const mkt = `${this.market.coin}-${this.market.type}`;
    if (tradeNetPnl < 0) {
      safety.recordLoss(Math.abs(tradeNetPnl));
    } else {
      safety.recordWin(tradeNetPnl);
    }

    logger.addTrade({
      strategy:              'btc_momentum',
      coin:                  this.market.coin,
      marketType:            this.market.type,
      question:              this.market.question,
      market_slug:           this.market.slug || this.market.id || '',
      contract_id:           this.market.conditionId || this.market.id || '',
      token_id:              this.tokenId || '',
      direction:             this.signal,
      timestamp_open:        this._entryTimestamp,
      timestamp_close:       new Date().toISOString(),
      entry_price:           this.entryPrice,
      exit_price:            fillPrice,
      shares:                exitQty,
      gross_pnl:             tradePnl,
      estimated_fees:        tradeFeeTotal,
      net_pnl:               tradeNetPnl,
      spread_at_entry:       this._spreadAtEntry,
      spread_at_exit:        this._spreadAtExit,
      hold_seconds:          this._entryTimestamp
                               ? Math.round((Date.now() - new Date(this._entryTimestamp).getTime()) / 1000)
                               : null,
      exit_reason:           this._lastExitReason || 'unknown',
      was_flip_reentry:      this.flipCount > 0,
      flip_count:            this.flipCount,
      btc_signal_at_entry:   this._btcSignalAtEntry,
      seconds_left_at_entry: this._secondsLeftAtEntry,
      seconds_left_at_exit:  this._secondsLeftAtExit,
      confidence_at_entry:   this.lastConfidence,
      regime_at_entry:       this.lastRegime,
      estimated_edge:        this.lastEstimatedEdge,
      result:                tradePnl >= 0 ? 'win' : 'loss',
      pnl:                   tradeNetPnl,
      estimatedFee:          tradeFeeTotal,
      exitReason:            this._lastExitReason || 'unknown',
      entryPrice:            this.entryPrice,
      entryOrderId:          this.entryOrderId,
      exitOrderId:           this.exitOrderId
    });
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
      const fillPrice        = this.exitPostedPrice;
      const exitQty          = this.exitFilledSoFar;
      const estimatedSellFee = parseFloat((exitQty * fillPrice * ESTIMATED_FEE_RATE).toFixed(4));
      const tradeFeeTotal    = parseFloat((this.estimatedBuyFee + estimatedSellFee).toFixed(4));
      this.holdingToken      = false;
      this.exitPrice         = fillPrice;
      this.tradePnl          = parseFloat(((fillPrice - this.entryPrice) * exitQty).toFixed(4));
      this.tradeNetPnl       = parseFloat((this.tradePnl - tradeFeeTotal).toFixed(4));
      this.cumulativePnl     = parseFloat((this.cumulativePnl + this.tradePnl).toFixed(4));
      this.cumulativeFees    = parseFloat((this.cumulativeFees + tradeFeeTotal).toFixed(4));
      this.cumulativeNetPnl  = parseFloat((this.cumulativeNetPnl + this.tradeNetPnl).toFixed(4));
      this.exitOrderId       = null;
      this.phase             = this.tradePnl > 0 && this.config.maxFlips > 0 ? 'flipping' : 'done';

      logger.addActivity('mom_tp_hit', {
        message: `[${this.market.coin}-${this.market.type}] Exit FILLED — sold ${exitQty} ${this.signal} @ $${fillPrice.toFixed(3)} | gross: ${this.tradePnl >= 0 ? '+' : ''}$${this.tradePnl.toFixed(3)} | fees: -$${tradeFeeTotal.toFixed(3)} | net: ${this.tradeNetPnl >= 0 ? '+' : ''}$${this.tradeNetPnl.toFixed(3)} | window net: ${this.cumulativeNetPnl >= 0 ? '+' : ''}$${this.cumulativeNetPnl.toFixed(3)}`
      });

      this._recordTradeClose(fillPrice, exitQty, this.tradePnl, this.tradeNetPnl, tradeFeeTotal);
      return;
    }

    if (exitStatus === 'MATCHED') {
      const fillPrice        = this.exitPostedPrice;
      const exitAmt          = this.exitSize || totalMatched || this.filledSize || this.entrySizeTokens;
      this.exitFilledSoFar   = exitAmt;
      const estimatedSellFee = parseFloat((exitAmt * fillPrice * ESTIMATED_FEE_RATE).toFixed(4));
      const tradeFeeTotal    = parseFloat((this.estimatedBuyFee + estimatedSellFee).toFixed(4));
      this.holdingToken      = false;
      this.exitPrice         = fillPrice;
      this.tradePnl          = parseFloat(((fillPrice - this.entryPrice) * exitAmt).toFixed(4));
      this.tradeNetPnl       = parseFloat((this.tradePnl - tradeFeeTotal).toFixed(4));
      this.cumulativePnl     = parseFloat((this.cumulativePnl + this.tradePnl).toFixed(4));
      this.cumulativeFees    = parseFloat((this.cumulativeFees + tradeFeeTotal).toFixed(4));
      this.cumulativeNetPnl  = parseFloat((this.cumulativeNetPnl + this.tradeNetPnl).toFixed(4));
      this.exitOrderId       = null;
      this.phase             = this.tradePnl > 0 && this.config.maxFlips > 0 ? 'flipping' : 'done';

      logger.addActivity('mom_tp_hit', {
        message: `[${this.market.coin}-${this.market.type}] Exit FILLED (MATCHED) — sold ${exitAmt} ${this.signal} @ $${fillPrice.toFixed(3)} | gross: ${this.tradePnl >= 0 ? '+' : ''}$${this.tradePnl.toFixed(3)} | fees: -$${tradeFeeTotal.toFixed(3)} | net: ${this.tradeNetPnl >= 0 ? '+' : ''}$${this.tradeNetPnl.toFixed(3)}`
      });

      this._recordTradeClose(fillPrice, exitAmt, this.tradePnl, this.tradeNetPnl, tradeFeeTotal);
      return;
    }

    if (this.exitFilledSoFar > 0 && remaining > 0.01) {
      logger.addActivity('mom_tp_hit', {
        message: `[${this.market.coin}-${this.market.type}] Partial exit: ${this.exitFilledSoFar.toFixed(2)}/${this.exitSize?.toFixed(2)} filled — ${remaining.toFixed(2)} remaining`
      });
      return;
    }

    if (exitStatus === 'CANCELED' || exitStatus === 'CANCELLED') {
      this.exitOrderId = null;
      this.phase       = 'managing';
      logger.addActivity('mom_error', {
        message: `[${this.market.coin}-${this.market.type}] Exit order cancelled — returning to managing to retry`
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
      if (mid !== null && mid > this.entryPrice) {
        logger.addActivity('mom_close', {
          message: `[${this.market.coin}-${this.market.type}] Closing — in profit, selling @ mid=$${mid.toFixed(3)} | entry=$${this.entryPrice}`
        });
        const sold = await this._postExitSell(client, mid, 'closing_cashout');
        if (!sold) {
          logger.addActivity('mom_close', {
            message: `[${this.market.coin}-${this.market.type}] Closing — sell failed, holding to resolution`
          });
        }
      } else {
        logger.addActivity('mom_close', {
          message: `[${this.market.coin}-${this.market.type}] Closing — holding ${this.signal} to resolution | entry=$${this.entryPrice} mid=${mid !== null ? '$' + mid.toFixed(3) : 'N/A'}`
        });
      }
    } else if (this.entryFilled && this.holdingToken) {
      logger.addActivity('mom_close', {
        message: `[${this.market.coin}-${this.market.type}] Closing — phase=${this.phase}, letting exit complete`
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
      lastBid:           this.lastBid,
      lastAsk:           this.lastAsk,
      lastSpread:        this.lastSpread,
      lastBidDepth:      this.lastBidDepth,
      lastAskDepth:      this.lastAskDepth,
      btcChange3m:       this.btcChange3m,
      confidence:        this.lastConfidence,
      skipReason:        this.lastSkipReason,
      regime:            this.lastRegime,
      estimatedEdge:     this.lastEstimatedEdge,
      entryPrice:        this.entryPrice,
      peakMid:           this.peakMid,
      trailingStopLevel: this.trailingStopLevel,
      trailingActive:    this.trailingActive,
      stopLossPrice:     this.entryPrice !== null ? Math.max(0.02, this.entryPrice - this.config.stopLossCents) : null,
      takeProfitPrice:   this.config.takeProfit,
      entryFilled:       this.entryFilled,
      holdingToken:      this.holdingToken,
      filledSize:        this.filledSize,
      exitOrderId:       this.exitOrderId || null,
      unrealizedPnL,
      tradePnl:          this.tradePnl,
      tradeNetPnl:       this.tradeNetPnl,
      cumulativePnl:     this.cumulativePnl,
      cumulativeFees:    this.cumulativeFees,
      cumulativeNetPnl:  this.cumulativeNetPnl,
      exitPrice:         this.exitPrice,
      flipCount:         this.flipCount,
      totalSpent:        this.totalSpent,
      question:          this.market.question,
      endTime:           this.market.endTime
    };
  }
}

module.exports = { MomentumSession, getMomentumConfig, fetchMidpoint };
