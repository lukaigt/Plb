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

const app  = express();
const PORT = parseInt(process.env.PORT) || 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.get('/api/status', (req, res) => res.json({
  isRunning: soccerLoop.getSoccerRunning(),
  safety:    safety.getStatus(),
  port:      PORT
}));

app.get('/api/activities',  (req, res) => res.json(logger.getActivities(parseInt(req.query.limit) || 60)));
app.get('/api/errors',      (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const all   = logger.getActivities(limit);
  const errorTypes = ['error', 'bond_error', 'bond_cancelled', 'safety_block', 'data_error', 'position_scanner_error'];
  const errors = all.filter(a => errorTypes.some(t => a.type.includes(t)) || (a.message && /error|fail|null|timeout|cancel/i.test(a.message)));
  res.json(errors);
});
app.get('/api/trades',       (req, res) => res.json(logger.getTradeHistory(parseInt(req.query.limit) || 50)));
app.get('/api/stats',        (req, res) => res.json(logger.getStats()));
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

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`Wallet Key: ${process.env.WALLET_PRIVATE_KEY ? 'SET' : 'NOT SET'}`);
  console.log(`Proxy:      ${process.env.PROXY_URL ? 'CONFIGURED' : 'NOT SET'}`);

  testProxy().then(result => {
    console.log(`Outgoing IP: ${result.ip} (proxy ${result.proxyActive ? 'ACTIVE' : 'NOT active'})`);
  });

  const soccerEnabled = process.env.SOCCER_ENABLED !== 'false';
  if (soccerEnabled && process.env.WALLET_PRIVATE_KEY) {
    soccerLoop.start();
  } else {
    console.log(`Soccer Bot: ${!soccerEnabled ? 'DISABLED (SOCCER_ENABLED=false)' : 'SKIPPED (no WALLET_PRIVATE_KEY)'}`);
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
