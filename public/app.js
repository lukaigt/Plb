const REFRESH_INTERVAL = 3000;

async function api(path, method = 'GET', body = null) {
  try {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api${path}`, opts);
    return await res.json();
  } catch (err) {
    console.error(`API error: ${path}`, err);
    return null;
  }
}

function formatTime(iso) {
  if (!iso) return 'N/A';
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getTypeClass(type) {
  if (type.includes('mm_error'))   return 'type-error';
  if (type.includes('mm_close'))   return 'type-safety';
  if (type.includes('mm_'))        return 'type-mm';
  if (type.includes('trade'))      return 'type-trade';
  if (type.includes('error'))      return 'type-error';
  if (type.includes('safety'))     return 'type-safety';
  if (type.includes('scan'))       return 'type-scan';
  if (type.includes('redeem'))     return 'type-redeem';
  if (type.includes('kraken'))     return 'type-kraken';
  return 'type-bot';
}

function getResultBadge(result) {
  if (result === 'win')     return '<span class="badge badge-win">WIN</span>';
  if (result === 'loss')    return '<span class="badge badge-loss">LOSS</span>';
  if (result === 'pending') return '<span class="badge badge-pending">PENDING</span>';
  return '<span class="badge badge-failed">FAILED</span>';
}

function fmtSeconds(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function dirBadge(dir) {
  if (dir === 'RISING')  return '<span class="dir-badge dir-up">RISING</span>';
  if (dir === 'FALLING') return '<span class="dir-badge dir-down">FALLING</span>';
  return '<span class="dir-badge dir-flat">FLAT</span>';
}

function formatChangeVal(change) {
  if (!change) return '--';
  const pct = parseFloat(change.percent);
  const dollars = change.dollars;
  const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
  return `<span class="${cls}">${pct > 0 ? '+' : ''}${dollars}</span>`;
}

async function updateBtcTicker() {
  const data = await api('/btc-price');
  if (!data) return;

  const dot  = document.getElementById('krakenDot');
  const text = document.getElementById('krakenText');

  if (!data.available) {
    document.getElementById('btcPrice').textContent = '--';
    document.getElementById('btcDirection').innerHTML = '<span class="dir-badge dir-flat">NO DATA</span>';
    dot.className = 'kraken-dot dot-red';
    text.textContent = data.connected ? 'Waiting...' : 'Disconnected';
    return;
  }

  document.getElementById('btcPrice').textContent     = '$' + data.currentPrice.toLocaleString();
  document.getElementById('btcDirection').innerHTML   = dirBadge(data.direction);
  document.getElementById('btcChange1m').innerHTML    = formatChangeVal(data.change1m);
  document.getElementById('btcChange5m').innerHTML    = formatChangeVal(data.change5m);
  document.getElementById('btcVolatility').textContent = data.recentVolatility ? '$' + data.recentVolatility : '--';

  dot.className   = 'kraken-dot dot-green';
  text.textContent = 'Kraken Live';

  const ticker = document.getElementById('btcTicker');
  if (data.direction === 'RISING')  ticker.className = 'btc-ticker btc-ticker-up';
  else if (data.direction === 'FALLING') ticker.className = 'btc-ticker btc-ticker-down';
  else ticker.className = 'btc-ticker';
}

function updateMarketCard(type, sessions) {
  const session  = sessions.find(s => s.type === type);
  const suffix   = type.replace('-', '');

  const phaseEl      = document.getElementById(`mc_${suffix}_phase`);
  const timerEl      = document.getElementById(`mc_${suffix}_timer`);
  const questionEl   = document.getElementById(`mc_${suffix}_question`);
  const midEl        = document.getElementById(`mc_${suffix}_mid`);
  const downMidEl    = document.getElementById(`mc_${suffix}_downmid`);
  const bidsEl       = document.getElementById(`mc_${suffix}_bids`);
  const openOrdersEl = document.getElementById(`mc_${suffix}_openorders`);
  const ordersEl     = document.getElementById(`mc_${suffix}_orders`);
  const spentEl      = document.getElementById(`mc_${suffix}_spent`);
  const card         = document.getElementById(`mc_${suffix}`);

  if (!session) {
    phaseEl.textContent      = 'Idle';
    phaseEl.className        = 'mc-phase';
    timerEl.textContent      = '--';
    questionEl.textContent   = 'No active market';
    midEl.textContent        = '--';
    downMidEl.textContent    = '--';
    bidsEl.textContent       = '--';
    openOrdersEl.textContent = '--';
    ordersEl.textContent     = '--';
    spentEl.textContent      = '--';
    card.className           = 'market-card';
    return;
  }

  const phase = session.phase;
  timerEl.textContent = fmtSeconds(session.secondsLeft) + ' left';

  if (phase === 'closing') {
    phaseEl.textContent = 'CLOSING';
    phaseEl.className   = 'mc-phase phase-closing';
    card.className      = 'market-card market-card-closing';
  } else if (phase === 'quoting') {
    phaseEl.textContent = 'QUOTING';
    phaseEl.className   = 'mc-phase phase-quoting';
    card.className      = 'market-card market-card-quoting';
  } else if (phase === 'waiting') {
    phaseEl.textContent = 'WAITING';
    phaseEl.className   = 'mc-phase phase-waiting';
    card.className      = 'market-card';
  } else {
    phaseEl.textContent = phase;
    phaseEl.className   = 'mc-phase';
    card.className      = 'market-card';
  }

  questionEl.textContent = session.question || '--';

  const mid = session.lastMid;
  if (mid !== null && mid !== undefined) {
    const downMid = 1 - mid;
    midEl.textContent     = '$' + mid.toFixed(3);
    downMidEl.textContent = '$' + downMid.toFixed(3);

    if (session.bidsValid && session.bidUp !== null && session.bidDown !== null) {
      bidsEl.innerHTML = `<span class="positive">UP $${parseFloat(session.bidUp).toFixed(3)}</span> / <span class="positive">DOWN $${parseFloat(session.bidDown).toFixed(3)}</span>`;
    } else {
      bidsEl.innerHTML = `<span style="color:#d29922;font-size:12px;">Market too one-sided to quote</span>`;
    }
  } else {
    midEl.textContent     = '--';
    downMidEl.textContent = '--';
    bidsEl.textContent    = '--';
  }

  const openCount = session.openOrderCount || 0;
  openOrdersEl.textContent = openCount > 0
    ? openCount + ' live in book'
    : '0 (none posted yet)';
  openOrdersEl.className = 'mc-val ' + (openCount > 0 ? 'positive' : '');

  ordersEl.textContent = session.ordersPosted || '0';
  spentEl.textContent  = '$' + (session.totalSpent || 0).toFixed(2);
}

async function updateWindowBar() {
  const data = await api('/window-status');
  if (!data) return;

  const timerEl = document.getElementById('windowTimer');
  const openEl  = document.getElementById('windowOpen');
  const leadEl  = document.getElementById('windowLead');
  const sideEl  = document.getElementById('windowSide');
  const bar     = document.getElementById('windowBar');

  if (data.secondsLeft !== undefined && data.secondsLeft !== null) {
    timerEl.textContent = fmtSeconds(data.secondsLeft) + ' left';
    if (data.secondsLeft <= 30 && data.secondsLeft > 0) {
      bar.className = 'window-bar window-scalp-zone';
    } else if (data.secondsLeft <= 90) {
      bar.className = 'window-bar window-approaching';
    } else {
      bar.className = 'window-bar';
    }
  } else {
    timerEl.textContent = '--:--';
  }

  openEl.textContent = data.openPrice ? '$' + data.openPrice.toLocaleString() : '--';

  if (data.btcVsOpenDollars !== null && data.btcVsOpenDollars !== undefined) {
    const sign = data.btcVsOpenRaw >= 0 ? '+' : '-';
    leadEl.textContent  = `${sign}$${Math.abs(data.btcVsOpenDollars).toFixed(0)}`;
    leadEl.className    = `window-value ${data.btcVsOpenRaw >= 0 ? 'positive' : 'negative'}`;
  } else {
    leadEl.textContent = '--';
    leadEl.className   = 'window-value';
  }

  if (data.btcLeadingSide) {
    sideEl.innerHTML = data.btcLeadingSide === 'UP'
      ? '<span class="dir-badge dir-up">UP</span>'
      : '<span class="dir-badge dir-down">DOWN</span>';
  } else {
    sideEl.textContent = '--';
  }
}

async function updateMarketCards(status) {
  if (!status) return;
  const sessions = status.activeSessions || [];
  updateMarketCard('5m',  sessions);
  updateMarketCard('15m', sessions);
}

async function updateStatus() {
  const status = await api('/status');
  if (!status) return;

  const dot = status.isRunning
    ? '<span class="status-dot dot-green"></span>Running'
    : '<span class="status-dot dot-red"></span>Stopped';
  document.getElementById('botStatus').innerHTML = dot;

  if (status.lastScanTime) {
    document.getElementById('lastScan').textContent = formatTime(status.lastScanTime);
  }

  if (status.config) {
    const cfg = status.config;
    document.getElementById('spreadConfig').textContent    = `${(cfg.spread * 100).toFixed(0)}¢ total`;
    document.getElementById('orderSizeConfig').textContent = `$${cfg.orderSize}/side`;
    document.getElementById('scanConfig').textContent      = `Refresh ${cfg.refreshInterval}s | Close ${cfg.closeSeconds}s | Max ${cfg.maxSeconds}s`;
  }

  const safety = status.safety;
  if (safety) {
    document.getElementById('killStatus').innerHTML = safety.killSwitch
      ? '<span class="negative">ON</span>'
      : '<span class="positive">OFF</span>';

    document.getElementById('todayRecord').textContent = `${safety.dailyWinCount || 0}W / ${safety.dailyLossCount || 0}L`;
    document.getElementById('dailyLosses').textContent = `$${safety.dailyLoss || '0.00'} / $${safety.dailyLossLimit || '50.00'}`;

    const netPnL = parseFloat(safety.dailyNetPnL || 0);
    const pnlEl = document.getElementById('dailyNetPnL');
    pnlEl.textContent = `$${safety.dailyNetPnL || '0.00'}`;
    pnlEl.className   = `s-value ${netPnL > 0 ? 'positive' : netPnL < 0 ? 'negative' : ''}`;

    document.getElementById('dailySpent').textContent  = `$${safety.dailySpent || '0.00'}`;
    document.getElementById('tradesToday').textContent = safety.dailyTradeCount || 0;

    const lossPct = safety.dailyLossLimit > 0
      ? (parseFloat(safety.dailyLoss || 0) / parseFloat(safety.dailyLossLimit) * 100) : 0;
    const pb = document.getElementById('lossProgress');
    pb.style.width      = `${Math.min(100, lossPct)}%`;
    pb.style.background = lossPct > 80 ? '#f85149' : lossPct > 50 ? '#d29922' : '#3fb950';

    const sb = document.getElementById('safetyBar');
    if (safety.killSwitch) sb.classList.add('kill-switch-active');
    else sb.classList.remove('kill-switch-active');

    document.getElementById('killBtn').textContent  = safety.killSwitch ? 'Disable Kill Switch' : 'Kill Switch';
    document.getElementById('killBtn').className    = safety.killSwitch ? 'btn btn-green' : 'btn btn-yellow';
  }

  updateMarketCards(status);
}

async function updateStats() {
  const stats = await api('/stats');
  if (!stats) return;

  const pnl = parseFloat(stats.totalPnL);
  const pnlEl = document.getElementById('totalPnl');
  pnlEl.textContent = `$${stats.totalPnL}`;
  pnlEl.className   = `value ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral'}`;

  document.getElementById('todayPnl').textContent  = `Today: $${stats.todayPnL}`;
  document.getElementById('winRate').textContent   = `${stats.winRate}%`;
  document.getElementById('winRate').className     = `value ${parseFloat(stats.winRate) >= 50 ? 'positive' : 'negative'}`;
  document.getElementById('winLoss').textContent   = `${stats.wins}W / ${stats.losses}L`;
  document.getElementById('totalTrades').textContent = stats.totalTrades;
  document.getElementById('pendingTrades').textContent = `Pending: ${stats.pendingTrades}`;
}

async function updateMMLog() {
  const activities = await api('/activities?limit=100');
  if (!activities || activities.length === 0) return;

  const mmEvents = activities.filter(a =>
    a.type.startsWith('mm_') || a.type === 'scan' || a.type.includes('trade')
  );

  const panel  = document.getElementById('mmLogPanel');
  const countEl = document.getElementById('mmLogCount');
  countEl.textContent = `${mmEvents.length} events`;

  if (mmEvents.length === 0) {
    panel.innerHTML = '<div class="empty-state">No market maker events yet. Start the bot to begin quoting.</div>';
    return;
  }

  panel.innerHTML = mmEvents.map(a => {
    const cls  = getTypeClass(a.type);
    let icon = '';
    if (a.type === 'mm_placed') icon = '&#9654; ';
    if (a.type === 'mm_quote')  icon = '&#8635; ';
    if (a.type === 'mm_close')  icon = '&#9724; ';
    if (a.type === 'mm_done')   icon = '&#10003; ';
    if (a.type === 'mm_error')  icon = '&#9888; ';
    return `<div class="activity-item">
      <div class="activity-time">${formatTime(a.timestamp)}</div>
      <span class="activity-type ${cls}">${a.type}</span>
      ${icon}${a.message || ''}
    </div>`;
  }).join('');
}

async function updateActivities() {
  const activities = await api('/activities?limit=60');
  if (!activities || activities.length === 0) return;

  document.getElementById('activityCount').textContent = `${activities.length} events`;
  const panel = document.getElementById('activityPanel');

  panel.innerHTML = activities.map(a => `
    <div class="activity-item">
      <div class="activity-time">${formatTime(a.timestamp)}</div>
      <span class="activity-type ${getTypeClass(a.type)}">${a.type}</span>
      ${a.message || ''}
    </div>
  `).join('');
}

async function updateTrades() {
  const trades = await api('/trades?limit=50');
  if (!trades || trades.length === 0) return;

  document.getElementById('tradeCount').textContent = `${trades.length} trades`;
  const tbody = document.getElementById('tradeBody');

  tbody.innerHTML = trades.map(t => {
    const pnlStr = t.pnl !== undefined && t.pnl !== 0
      ? `$${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '--';
    const pnlCls = t.pnl > 0 ? 'positive' : t.pnl < 0 ? 'negative' : '';
    const market = t.coin ? `BTC-${t.coin}` : 'BTC';
    const side = (t.action || 'MM').replace('BUY_', '');

    return `<tr>
      <td>${formatTime(t.timestamp)}</td>
      <td><span class="coin-badge-sm coin-btc">${market}</span></td>
      <td>${side}</td>
      <td>$${t.price?.toFixed(3) || '0.000'}</td>
      <td>$${t.size?.toFixed(2) || '0.00'}</td>
      <td>${getResultBadge(t.result)}</td>
      <td class="${pnlCls}">${pnlStr}</td>
    </tr>`;
  }).join('');
}

function getRedeemStatusBadge(status) {
  const map = {
    waiting:   '<span class="badge badge-pending">WAITING</span>',
    redeeming: '<span class="badge badge-pending">REDEEMING</span>',
    redeemed:  '<span class="badge badge-win">COLLECTED</span>',
    no_payout: '<span class="badge badge-loss">LOST</span>',
    error:     '<span class="badge badge-failed">ERROR</span>'
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

async function updateRedemptions() {
  const data = await api('/redemptions');
  if (!data) return;

  document.getElementById('redeemCount').textContent =
    `${data.pending.length} pending | ${data.totalRedeemed} collected | ${data.totalLost} lost`;

  const panel = document.getElementById('redeemPanel');
  const total = data.pending.length + data.history.length;
  if (total === 0) {
    panel.innerHTML = '<div class="empty-state">No positions tracked yet.</div>';
    return;
  }

  let html = '';
  if (data.safeAddress) {
    html += `<div class="activity-item" style="border-left:2px solid #58a6ff;"><div class="activity-type type-bot">safe</div> Proxy wallet: ${data.safeAddress}</div>`;
  }
  for (const p of data.pending) {
    html += `<div class="activity-item">
      <div class="activity-time">${formatTime(p.addedAt)}</div>
      ${getRedeemStatusBadge(p.status)}
      <span style="margin-left:6px;">${p.question || 'BTC Trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${p.size?.toFixed(2) || '?'} ${p.side || ''}</span>
    </div>`;
  }
  for (const h of data.history) {
    html += `<div class="activity-item">
      <div class="activity-time">${formatTime(h.redeemedAt)}</div>
      ${getRedeemStatusBadge(h.status)}
      <span style="margin-left:6px;">${h.question || 'BTC Trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${h.size?.toFixed(2) || '?'}${h.txHash ? ' | TX: ' + h.txHash.slice(0, 12) + '...' : ''}</span>
    </div>`;
  }
  panel.innerHTML = html;
}

async function startBot() {
  const res = await api('/bot/start', 'POST');
  if (res) alert(res.message);
  updateStatus();
}

async function stopBot() {
  const res = await api('/bot/stop', 'POST');
  if (res) alert(res.message);
  updateStatus();
}

async function toggleKillSwitch() {
  const res = await api('/killswitch', 'POST');
  if (res) alert(res.message);
  updateStatus();
}

async function scanNow() {
  const btn = document.querySelector('.btn-blue');
  btn.textContent = 'Scanning...';
  btn.disabled = true;
  const res = await api('/bot/scan-now', 'POST');
  if (res) alert(res.message);
  btn.textContent = 'Scan Now';
  btn.disabled = false;
  refreshAll();
}

async function scanWallet() {
  const btn = document.querySelector('.btn-purple');
  btn.textContent = 'Scanning...';
  btn.disabled = true;
  const res = await api('/scan-positions', 'POST');
  if (res) {
    if (res.redeemable > 0) alert(`Found ${res.found} position(s), ${res.redeemable} redeemable!`);
    else if (res.found > 0) alert(`Found ${res.found} position(s), none redeemable yet.`);
    else alert(res.error ? `Scan failed: ${res.error}` : 'No positions found.');
  }
  btn.textContent = 'Scan Wallet';
  btn.disabled = false;
  refreshAll();
}

async function refreshAll() {
  await Promise.all([
    updateBtcTicker(),
    updateWindowBar(),
    updateStatus(),
    updateStats(),
    updateMMLog(),
    updateActivities(),
    updateTrades(),
    updateRedemptions()
  ]);
}

refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL);
