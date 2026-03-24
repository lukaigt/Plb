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

const express        = require('express');
const path           = require('path');
const botLoop        = require('./src/botLoop');
const safety         = require('./src/safety');
const logger         = require('./src/logger');
const redeemer       = require('./src/redeemer');
const positionScanner  = require('./src/positionScanner');
const positionTracker  = require('./src/positionTracker');
const krakenFeed       = require('./src/krakenFeed');
const { getMMConfig }  = require('./src/marketMaker');

const app  = express();
const PORT = parseInt(process.env.PORT) || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.get('/api/status',      (req, res) => res.json(botLoop.getStatus()));
app.get('/api/activities',  (req, res) => res.json(logger.getActivities(parseInt(req.query.limit) || 60)));
app.get('/api/trades',      (req, res) => res.json(logger.getTradeHistory(parseInt(req.query.limit) || 50)));
app.get('/api/stats',       (req, res) => res.json(logger.getStats()));
app.get('/api/safety',      (req, res) => res.json(safety.getStatus()));
app.get('/api/redemptions', (req, res) => res.json(redeemer.getRedemptionStatus()));
app.get('/api/positions',   (req, res) => res.json({
  open:   positionTracker.getOpenPositions(),
  closed: positionTracker.getRecentClosed(),
  scan:   positionScanner.getScanResult()
}));
app.get('/api/btc-price',   (req, res) => res.json(krakenFeed.getPriceContext()));
app.get('/api/window-status', (req, res) => res.json(krakenFeed.getWindowStatus()));
app.get('/api/proxy-test',  async (req, res) => res.json(await testProxy()));

app.post('/api/killswitch', (req, res) => {
  const newState = safety.toggleKillSwitch();
  if (newState) botLoop.stop();
  res.json({ killSwitch: newState, message: newState ? 'Kill switch ACTIVATED — bot stopped' : 'Kill switch OFF' });
});

app.post('/api/bot/start', (req, res) => {
  if (safety.killSwitch) return res.json({ success: false, message: 'Cannot start: kill switch is ON' });
  botLoop.start();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/bot/stop', (req, res) => {
  botLoop.stop();
  res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/bot/scan-now', async (req, res) => {
  if (safety.killSwitch) return res.json({ success: false, message: 'Kill switch is ON' });
  try {
    await botLoop.runOnce();
    res.json({ success: true, message: 'Manual scan completed' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
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

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  const cfg = getMMConfig();
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  console.log('Starting BTC Market Maker Bot...');
  console.log(`Markets:       BTC 5-min + BTC 15-min`);
  console.log(`Wallet Key:    ${process.env.WALLET_PRIVATE_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`CLOB API Key:  ${process.env.POLY_API_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`Spread:        ${(cfg.spread * 100).toFixed(0)}¢ total (${(cfg.spread / 2 * 100).toFixed(0)}¢ each side)`);
  console.log(`Order size:    $${cfg.orderSize} per side`);
  console.log(`Refresh:       every ${cfg.refreshInterval}s`);
  console.log(`Quote window:  up to ${cfg.maxSeconds}s before close`);
  console.log(`Closing phase: final ${cfg.closeSeconds}s`);
  console.log(`Daily loss limit: $${process.env.DAILY_LOSS_LIMIT || 50}`);
  console.log(`Proxy:         ${process.env.PROXY_URL ? 'CONFIGURED' : 'NOT SET'}`);

  testProxy().then(result => {
    console.log(`Outgoing IP: ${result.ip} (proxy ${result.proxyActive ? 'ACTIVE' : 'NOT active'})`);
  });

  krakenFeed.connect();
  console.log('Kraken BTC/USD feed starting...');
  botLoop.start();
});
