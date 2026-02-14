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
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getTypeClass(type) {
  if (type.includes('spike')) return 'type-spike';
  if (type.includes('kraken')) return 'type-kraken';
  if (type.includes('price_block')) return 'type-price-block';
  if (type.includes('scan')) return 'type-scan';
  if (type.includes('trade')) return 'type-trade';
  if (type.includes('error')) return 'type-error';
  if (type.includes('safety') || type.includes('skip')) return 'type-safety';
  if (type.includes('redeem')) return 'type-redeem';
  return 'type-bot';
}

function getActionClass(action) {
  if (action === 'BUY_YES') return 'action-buy-yes';
  if (action === 'BUY_NO') return 'action-buy-no';
  return 'action-skip';
}

function getResultBadge(result) {
  if (result === 'win') return '<span class="badge badge-win">WIN</span>';
  if (result === 'loss') return '<span class="badge badge-loss">LOSS</span>';
  if (result === 'pending') return '<span class="badge badge-pending">PENDING</span>';
  return '<span class="badge badge-failed">FAILED</span>';
}

function formatChangeVal(change) {
  if (!change) return '--';
  const pct = parseFloat(change.percent);
  const dollars = change.dollars;
  const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
  return `<span class="${cls}">${pct > 0 ? '+' : ''}${dollars}</span>`;
}

function directionBadge(dir) {
  if (dir === 'RISING') return '<span class="dir-badge dir-up">RISING</span>';
  if (dir === 'FALLING') return '<span class="dir-badge dir-down">FALLING</span>';
  return '<span class="dir-badge dir-flat">FLAT</span>';
}

function momentumBadge(mom) {
  if (mom === 'ACCELERATING') return '<span class="mom-badge mom-accel">ACCELERATING</span>';
  if (mom === 'DECELERATING') return '<span class="mom-badge mom-decel">DECELERATING</span>';
  return '<span class="mom-badge mom-stable">STABLE</span>';
}

async function updateBtcTicker() {
  const data = await api('/btc-price');
  if (!data) return;

  const dot = document.getElementById('krakenDot');
  const text = document.getElementById('krakenText');

  if (!data.available) {
    document.getElementById('btcPrice').textContent = '--';
    document.getElementById('btcDirection').innerHTML = '<span class="dir-badge dir-flat">NO DATA</span>';
    document.getElementById('btcMomentum').innerHTML = '';
    dot.className = 'kraken-dot dot-red';
    text.textContent = data.connected ? 'Waiting...' : 'Disconnected';
    return;
  }

  document.getElementById('btcPrice').textContent = '$' + data.currentPrice.toLocaleString();
  document.getElementById('btcDirection').innerHTML = directionBadge(data.direction);
  document.getElementById('btcMomentum').innerHTML = momentumBadge(data.momentum);

  document.getElementById('btcChange1m').innerHTML = formatChangeVal(data.change1m);
  document.getElementById('btcChange3m').innerHTML = formatChangeVal(data.change3m);
  document.getElementById('btcChange5m').innerHTML = formatChangeVal(data.change5m);
  document.getElementById('btcChange10m').innerHTML = formatChangeVal(data.change10m);
  document.getElementById('btcVolatility').textContent = data.recentVolatility ? '$' + data.recentVolatility : '--';

  dot.className = 'kraken-dot dot-green';
  text.textContent = 'Kraken Live';

  const ticker = document.getElementById('btcTicker');
  if (data.direction === 'RISING') {
    ticker.className = 'btc-ticker btc-ticker-up';
  } else if (data.direction === 'FALLING') {
    ticker.className = 'btc-ticker btc-ticker-down';
  } else {
    ticker.className = 'btc-ticker';
  }
}

async function updateSpikeBar() {
  const status = await api('/status');
  if (!status || !status.lastSpikeStatus) return;

  const spike = status.lastSpikeStatus;
  const icon = document.getElementById('spikeIcon');
  const label = document.getElementById('spikeLabel');
  const detail = document.getElementById('spikeDetail');
  const bar = document.getElementById('spikeBar');

  if (spike.detected) {
    bar.className = 'spike-bar spike-active';
    icon.innerHTML = '&#9889;';
    icon.className = 'spike-icon spike-icon-active';
    label.textContent = `SPIKE ${spike.direction}`;
    label.className = 'spike-label spike-label-active';
    detail.textContent = spike.reason;
    detail.className = 'spike-detail spike-detail-active';
  } else {
    bar.className = 'spike-bar';
    icon.innerHTML = '&#9679;';
    icon.className = 'spike-icon';
    label.textContent = 'WATCHING';
    label.className = 'spike-label';
    detail.textContent = spike.reason || 'Monitoring BTC for spikes...';
    detail.className = 'spike-detail';
  }
}

async function updateStatus() {
  const status = await api('/status');
  if (!status) return;

  const dot = status.isRunning ? '<span class="status-dot dot-green"></span>Running' : '<span class="status-dot dot-red"></span>Stopped';
  document.getElementById('botStatus').innerHTML = dot;

  if (status.lastScanTime) {
    document.getElementById('lastScan').textContent = formatTime(status.lastScanTime);
  }

  const safety = status.safety;
  if (safety) {
    document.getElementById('killStatus').innerHTML = safety.killSwitch
      ? '<span class="negative">ON</span>'
      : '<span class="positive">OFF</span>';

    document.getElementById('todayRecord').textContent = `${safety.dailyWinCount || 0}W / ${safety.dailyLossCount || 0}L`;
    document.getElementById('dailyLosses').textContent = `${safety.dailyLossCount || 0} / ${safety.maxDailyLosses || 6}`;
    document.getElementById('dailyLoss').textContent = `$${safety.dailyLoss} / $${safety.dailyLossLimit}`;
    document.getElementById('dailySpent').textContent = `$${safety.dailySpent || '0.00'}`;
    document.getElementById('tradesToday').textContent = safety.dailyTradeCount;

    const lossPct = safety.maxDailyLosses > 0 ? ((safety.dailyLossCount || 0) / safety.maxDailyLosses * 100) : 0;
    const bar = document.getElementById('lossProgress');
    bar.style.width = `${Math.min(100, lossPct)}%`;
    bar.style.background = lossPct > 80 ? '#f85149' : lossPct > 50 ? '#d29922' : '#3fb950';

    const safetyBar = document.getElementById('safetyBar');
    if (safety.killSwitch) {
      safetyBar.classList.add('kill-switch-active');
    } else {
      safetyBar.classList.remove('kill-switch-active');
    }

    document.getElementById('killBtn').textContent = safety.killSwitch ? 'Disable Kill Switch' : 'Kill Switch';
    document.getElementById('killBtn').className = safety.killSwitch ? 'btn btn-green' : 'btn btn-yellow';
  }
}

async function updateStats() {
  const stats = await api('/stats');
  if (!stats) return;

  const pnl = parseFloat(stats.totalPnL);
  const pnlEl = document.getElementById('totalPnl');
  pnlEl.textContent = `$${stats.totalPnL}`;
  pnlEl.className = `value ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral'}`;

  document.getElementById('todayPnl').textContent = `Today: $${stats.todayPnL}`;
  document.getElementById('winRate').textContent = `${stats.winRate}%`;
  document.getElementById('winRate').className = `value ${parseFloat(stats.winRate) >= 50 ? 'positive' : 'negative'}`;
  document.getElementById('winLoss').textContent = `${stats.wins}W / ${stats.losses}L`;
  document.getElementById('totalTrades').textContent = stats.totalTrades;
  document.getElementById('pendingTrades').textContent = `Pending: ${stats.pendingTrades}`;
}

async function updateSpikeLog() {
  const activities = await api('/activities?limit=60');
  if (!activities || activities.length === 0) return;

  const spikeEvents = activities.filter(a =>
    a.type.includes('spike') || a.type.includes('trade') || a.type.includes('price_block')
  );

  const panel = document.getElementById('spikeLogPanel');
  const countEl = document.getElementById('spikeLogCount');
  countEl.textContent = `${spikeEvents.length} events`;

  if (spikeEvents.length === 0) {
    panel.innerHTML = '<div class="empty-state">No spike events yet. Bot watches BTC for $30+ moves and trades instantly.</div>';
    return;
  }

  panel.innerHTML = spikeEvents.map(a => {
    let cls = getTypeClass(a.type);
    let icon = '';
    if (a.type === 'spike_detected') icon = '&#9889; ';
    if (a.type === 'spike_trade') icon = '&#128176; ';
    if (a.type === 'trade_success') icon = '&#9989; ';
    if (a.type === 'price_block') icon = '&#128683; ';

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
    return `<tr>
      <td>${formatTime(t.timestamp)}</td>
      <td><span class="decision-action ${getActionClass(t.action)}">${t.action}</span></td>
      <td>${t.pattern || 'N/A'}</td>
      <td>${t.confidence || 'N/A'}</td>
      <td>$${t.size?.toFixed(2) || '0.00'}</td>
      <td>$${t.price?.toFixed(3) || '0.000'}</td>
      <td>${getResultBadge(t.result)}</td>
      <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(t.reasoning || '').replace(/"/g, '&quot;')}">${t.reasoning || 'N/A'}</td>
    </tr>`;
  }).join('');
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
  btn.textContent = 'Scanning Wallet...';
  btn.disabled = true;
  const res = await api('/scan-positions', 'POST');
  if (res) {
    if (res.redeemable > 0) {
      alert(`Found ${res.found} position(s), ${res.redeemable} redeemable! Redeeming now...`);
    } else if (res.found > 0) {
      alert(`Found ${res.found} position(s), but none are redeemable right now.`);
    } else {
      alert(res.error ? `Scan failed: ${res.error}` : 'No positions found on wallet.');
    }
  }
  btn.textContent = 'Scan Wallet';
  btn.disabled = false;
  refreshAll();
}

function getRedeemStatusBadge(status) {
  const map = {
    waiting: '<span class="badge badge-pending">WAITING</span>',
    redeeming: '<span class="badge badge-pending">REDEEMING</span>',
    redeemed: '<span class="badge badge-win">COLLECTED</span>',
    no_payout: '<span class="badge badge-loss">LOST</span>',
    error: '<span class="badge badge-failed">ERROR</span>'
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
    panel.innerHTML = '<div class="empty-state">No positions tracked yet. Trades will appear here for auto-redemption.</div>';
    return;
  }

  let html = '';

  if (data.safeAddress) {
    html += `<div class="activity-item" style="border-left:2px solid #58a6ff;"><div class="activity-type type-bot">safe</div> Proxy wallet: ${data.safeAddress}</div>`;
  }

  for (const p of data.pending) {
    const timeStr = p.marketEndTime ? formatTime(p.marketEndTime) : '?';
    html += `<div class="activity-item">
      <div class="activity-time">${formatTime(p.addedAt)}</div>
      ${getRedeemStatusBadge(p.status)}
      <span style="margin-left:6px;">${p.question || 'BTC trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${p.size?.toFixed(2) || '?'} ${p.side || ''} | ends ${timeStr}</span>
    </div>`;
  }

  for (const h of data.history) {
    html += `<div class="activity-item">
      <div class="activity-time">${formatTime(h.redeemedAt)}</div>
      ${getRedeemStatusBadge(h.status)}
      <span style="margin-left:6px;">${h.question || 'BTC trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${h.size?.toFixed(2) || '?'} ${h.side || ''}${h.txHash ? ' | TX: ' + h.txHash.substring(0, 12) + '...' : ''}</span>
    </div>`;
  }

  panel.innerHTML = html;
}

async function refreshAll() {
  await Promise.all([
    updateBtcTicker(),
    updateSpikeBar(),
    updateStatus(),
    updateStats(),
    updateSpikeLog(),
    updateActivities(),
    updateTrades(),
    updateRedemptions()
  ]);
}

refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL);
