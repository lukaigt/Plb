require('dotenv').config();

const _origStringify = JSON.stringify;
JSON.stringify = function(value, replacer, space) {
  const seen = new WeakSet();
  const safeReplacer = function(key, val) {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    if (replacer) return replacer.call(this, key, val);
    return val;
  };
  return _origStringify.call(JSON, value, safeReplacer, space);
};

const { setupProxy, testProxy } = require('./src/proxy');
setupProxy();

const express         = require('express');
const path            = require('path');
const safety          = require('./src/safety');
const logger          = require('./src/logger');
const redeemer        = require('./src/redeemer');
const positionScanner = require('./src/positionScanner');
const soccerLoop      = require('./src/soccerLoop');
const botLoop         = require('./src/botLoop');
const krakenFeed      = require('./src/krakenFeed');

const app  = express();
const PORT = parseInt(process.env.PORT) || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.get('/api/status', (req, res) => {
  const btcMode = process.env.BTC_MODE === 'true';
  res.json({
    isRunning: btcMode ? botLoop.getStatus().isRunning : soccerLoop.getSoccerRunning(),
    mode:      btcMode ? 'BTC' : 'SPORTS',
    safety:    safety.getStatus(),
    port:      PORT
  });
});

app.get('/api/btc-status', (req, res) => res.json(botLoop.getStatus()));

app.get('/api/activities',  (req, res) => res.json(logger.getActivities(parseInt(req.query.limit) || 60)));
app.get('/api/errors',      (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const all   = logger.getActivities(limit);
  const errorTypes = ['error', 'bond_error', 'bond_cancelled', 'safety_block', 'data_error', 'position_scanner_error'];
  const errors = all.filter(a => errorTypes.some(t => a.type.includes(t)) || (a.message && /error|fail|null|timeout|cancel/i.test(a.message)));
  res.json(errors);
});
app.get('/api/trades',        (req, res) => res.json(logger.getTradeHistory(parseInt(req.query.limit) || 50)));
app.get('/api/stats',         (req, res) => res.json(logger.getStats()));
app.get('/api/btc-trades',    (req, res) => res.json(logger.getBtcTrades(parseInt(req.query.limit) || 200)));
app.get('/api/btc-analytics', (req, res) => res.json(logger.getBtcAnalytics()));
app.get('/api/safety',       (req, res) => res.json(safety.getStatus()));
app.get('/api/redemptions',  (req, res) => res.json(redeemer.getRedemptionStatus()));
app.get('/api/positions',    (req, res) => res.json(positionScanner.getScanResult()));
app.get('/api/soccer-positions', (req, res) => res.json(soccerLoop.getPositions()));
app.get('/api/soccer-stats',    (req, res) => res.json(soccerLoop.getSoccerStats()));
app.get('/api/proxy-test',   async (req, res) => res.json(await testProxy()));

app.post('/api/killswitch', (req, res) => {
  const newState = safety.toggleKillSwitch();
  res.json({ killSwitch: newState, message: newState ? 'Kill switch ACTIVATED — trading halted' : 'Kill switch OFF — trading resumed' });
});

app.post('/api/safety-reset', (req, res) => {
  safety.resetDailyCounters();
  res.json({ success: true, message: 'Daily counters reset — kill switch unchanged', status: safety.getStatus() });
});

app.post('/api/scan-positions', async (req, res) => {
  try {
    logger.addActivity('bot', { message: 'Manual position scan triggered...' });
    const result = await positionScanner.scanExistingPositions();
    if (result.redeemable > 0) await redeemer.checkAndRedeem();
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/force-redeem', async (req, res) => {
  try {
    logger.addActivity('bot', { message: 'Manual force-redeem triggered...' });
    const status = redeemer.getRedemptionStatus();
    if (status.pending.length === 0) {
      logger.addActivity('bot', { message: 'No pending redemptions — scanning wallet first...' });
      await positionScanner.scanExistingPositions();
    }
    const before  = redeemer.getRedemptionStatus().totalRedeemed;
    await redeemer.checkAndRedeem();
    const updated = redeemer.getRedemptionStatus();
    res.json({ success: true, pending: updated.pending.length, redeemed: updated.totalRedeemed - before });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/force-sell', async (req, res) => {
  try {
    const { placeFakSellOrder } = require('./src/trader');
    const { tokenId, size, negRisk, tickSize } = req.body;

    if (!tokenId || !size) {
      return res.json({ success: false, error: 'tokenId and size required' });
    }

    const sizeNum = parseFloat(size);
    if (isNaN(sizeNum) || sizeNum <= 0) {
      return res.json({ success: false, error: 'size must be > 0' });
    }

    // STEP 1: fetch a fresh live orderbook directly from CLOB at click time.
    // We do NOT trust websocket cache, midpoint, or stale held-session state.
    let book = null;
    let bookErr = null;
    try {
      const bookRes = await fetch(
        `https://clob.polymarket.com/book?token_id=${tokenId}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const json = await bookRes.json();
      if (json && Array.isArray(json.bids)) book = json;
      else bookErr = json?.error || `HTTP ${bookRes.status}`;
    } catch (err) {
      bookErr = err.message;
    }

    if (!book) {
      logger.addActivity('bot', {
        message: `[ForceSell] No live book for token=${String(tokenId).slice(0, 14)}… err=${bookErr || 'unknown'}`
      });
      return res.json({ success: false, reason: 'NO_BID_LIQUIDITY', detail: `orderbook unavailable: ${bookErr}` });
    }

    // CLOB returns bids sorted ascending — top bid is the LAST element. Pick the highest-price bid
    // with non-zero size to be safe.
    const liveBids = (book.bids || [])
      .map(b => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter(b => b.price > 0 && b.size > 0)
      .sort((a, b) => b.price - a.price);

    if (liveBids.length === 0) {
      logger.addActivity('bot', {
        message: `[ForceSell] No live bids for token=${String(tokenId).slice(0, 14)}… (book empty) — returning NO_BID_LIQUIDITY`
      });
      return res.json({ success: false, reason: 'NO_BID_LIQUIDITY', detail: 'orderbook has no bids' });
    }

    const topBid     = liveBids[0];
    const sellPrice  = topBid.price;
    const tickStr    = String(tickSize || '0.01');
    const isNegRisk  = negRisk === true || negRisk === 'true';

    logger.addActivity('bot', {
      message: `[ForceSell] Live book hit: top bid $${sellPrice.toFixed(3)} x ${topBid.size.toFixed(2)} | placing FAK ${sizeNum.toFixed(4)} @ $${sellPrice.toFixed(3)} | negRisk=${isNegRisk} tick=${tickStr}`
    });

    // STEP 2: place FAK at the actual top bid price
    const result = await placeFakSellOrder(tokenId, sizeNum, sellPrice, isNegRisk, tickStr);

    if (!result?.success) {
      // Differentiate: NO_FILL = order accepted but zero matched (no buyer at that price);
      // anything else = exchange rejected the order outright.
      const isNoFill = result?.error === 'NO_FILL';
      const reason   = isNoFill ? 'NO_FILL' : 'FAK_REJECTED';
      logger.addActivity('bot', {
        message: `[ForceSell] ${reason} @ $${sellPrice.toFixed(3)}: ${(result?.error || 'unknown').toString().slice(0, 100)} | orderId=${result?.orderId ?? 'n/a'}`
      });
      return res.json({
        success: false,
        reason,
        detail:  result?.error,
        sellPrice,
        topBid,
        orderId: result?.orderId ?? null,
        filled:  0,
        remaining: sizeNum
      });
    }

    const filled    = parseFloat(result?.sizeFilled   ?? 0);
    const remaining = parseFloat(result?.sizeRemaining ?? (sizeNum - filled));

    logger.addActivity('bot', {
      message: `[ForceSell] FAK FILLED @ $${sellPrice.toFixed(3)}: sold=${filled.toFixed(4)} usd=$${(result?.usdReceived ?? filled * sellPrice).toFixed(2)} remaining=${remaining.toFixed(4)} orderId=${result?.orderId ?? 'n/a'}${remaining > 0.01 ? ' — partial, click Force Sell again to retry remainder' : ''}`
    });

    res.json({
      success:   true,
      filled,
      remaining,
      sellPrice,
      topBid,
      orderId:   result?.orderId ?? null,
      usdReceived: result?.usdReceived ?? null,
      rawResult: result
    });
  } catch (err) {
    logger.addActivity('bot', { message: `[ForceSell] Error: ${err.message?.slice(0, 100)}` });
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/recover-positions', async (req, res) => {
  try {
    logger.addActivity('bot', { message: '[Recovery] Manual position recovery triggered from dashboard...' });
    await soccerLoop.recoverOpenPositions();
    const positions = soccerLoop.getPositions();
    const held = positions.filter(p => ['holding', 'liquidating', 'redeeming'].includes(p.phase)).length;
    res.json({ success: true, message: `Recovery complete — ${held} position(s) now tracked`, positions: held });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`Wallet Key: ${process.env.WALLET_PRIVATE_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`Proxy:      ${process.env.PROXY_URL ? 'CONFIGURED' : 'NOT SET'}`);

  testProxy().then(result => {
    console.log(`Outgoing IP: ${result.ip} (proxy ${result.proxyActive ? 'ACTIVE' : 'NOT active'})`);
  });

  const btcMode      = process.env.BTC_MODE === 'true';
  const soccerEnabled = process.env.SOCCER_ENABLED !== 'false';

  if (btcMode && process.env.WALLET_PRIVATE_KEY) {
    console.log('BTC Mode: ACTIVE — sports trading disabled, starting BTC 15m momentum bot');
    krakenFeed.connect();
    botLoop.start();
  } else if (!btcMode && soccerEnabled && process.env.WALLET_PRIVATE_KEY) {
    soccerLoop.start();
  } else {
    console.log(`Bot: ${btcMode ? 'BTC_MODE=true but no WALLET_PRIVATE_KEY' : !soccerEnabled ? 'DISABLED (SOCCER_ENABLED=false)' : 'SKIPPED (no WALLET_PRIVATE_KEY)'}`);
  }

  // Auto-scan existing wallet positions on startup (after 60s so CLOB client
  // has time to initialise and proxy wallet address is resolved), then repeat
  // every 5 minutes so any positions resolved while the bot was offline or from
  // a previous session get collected automatically without pressing Force Redeem.
  if (process.env.WALLET_PRIVATE_KEY) {
    const autoScanAndRedeem = async () => {
      try {
        const result = await positionScanner.scanExistingPositions();
        if (result.redeemable > 0) await redeemer.checkAndRedeem();
      } catch (err) {
        logger.addActivity('bot', { message: `Auto-scan error: ${err.message?.slice(0, 80)}` });
      }
    };
    setTimeout(autoScanAndRedeem, 60 * 1000);
    setInterval(autoScanAndRedeem, 5 * 60 * 1000);
  }
});
