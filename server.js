require('dotenv').config();

const { setupProxy, testProxy, testGeoblock } = require('./src/proxy');
setupProxy();

const express = require('express');
const path = require('path');
const botLoop = require('./src/botLoop');
const safety = require('./src/safety');
const logger = require('./src/logger');

const app = express();
const PORT = parseInt(process.env.PORT) || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.get('/api/status', (req, res) => {
  res.json(botLoop.getStatus());
});

app.get('/api/activities', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(logger.getActivities(limit));
});

app.get('/api/decisions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(logger.getAiDecisions(limit));
});

app.get('/api/trades', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(logger.getTradeHistory(limit));
});

app.get('/api/stats', (req, res) => {
  res.json(logger.getStats());
});

app.get('/api/safety', (req, res) => {
  res.json(safety.getStatus());
});

app.post('/api/killswitch', (req, res) => {
  const newState = safety.toggleKillSwitch();
  if (newState) {
    botLoop.stop();
  }
  res.json({ killSwitch: newState, message: newState ? 'Kill switch ACTIVATED - bot stopped' : 'Kill switch DEACTIVATED' });
});

app.post('/api/bot/start', (req, res) => {
  if (safety.killSwitch) {
    return res.json({ success: false, message: 'Cannot start: kill switch is ON' });
  }
  botLoop.start();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/bot/stop', (req, res) => {
  botLoop.stop();
  res.json({ success: true, message: 'Bot stopped' });
});

app.get('/api/proxy-test', async (req, res) => {
  const result = await testProxy();
  res.json(result);
});

app.post('/api/bot/scan-now', async (req, res) => {
  if (safety.killSwitch) {
    return res.json({ success: false, message: 'Cannot scan: kill switch is ON' });
  }
  try {
    await botLoop.runOnce();
    res.json({ success: true, message: 'Manual scan completed' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  console.log('Starting bot...');

  const hasKey = !!process.env.OPENROUTER_API_KEY;
  const hasWallet = !!process.env.WALLET_PRIVATE_KEY;

  console.log(`OpenRouter API Key: ${hasKey ? 'SET' : 'NOT SET'}`);
  console.log(`Wallet Private Key: ${hasWallet ? 'SET' : 'NOT SET'}`);
  console.log(`Max Trade Size: $${process.env.MAX_TRADE_SIZE || 5}`);
  console.log(`Daily Loss Limit: $${process.env.DAILY_LOSS_LIMIT || 15}`);
  console.log(`Scan Interval: ${process.env.SCAN_INTERVAL || 120}s`);
  console.log(`Proxy: ${process.env.PROXY_URL ? 'CONFIGURED' : 'NOT SET'}`);

  testProxy().then(result => {
    console.log(`Outgoing IP: ${result.ip} (proxy ${result.proxyActive ? 'ACTIVE' : 'NOT active'})`);
  });

  botLoop.start();
});
