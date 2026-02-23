const REFRESH_INTERVAL = 3000;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];

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
  if (type.includes('scalp_signal')) return 'type-scalp-signal';
  if (type.includes('scalp_trade')) return 'type-trade';
  if (type.includes('scalp')) return 'type-scalp';
  if (type.includes('price_check')) return 'type-price';
  if (type.includes('trade')) return 'type-trade';
  if (type.includes('error')) return 'type-error';
  if (type.includes('safety') || type.includes('skip')) return 'type-safety';
  if (type.includes('scan')) return 'type-scan';
  if (type.includes('kraken')) return 'type-kraken';
  if (type.includes('redeem')) return 'type-redeem';
  return 'type-bot';
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

async function updateBtcTicker() {
  const data = await api('/btc-price');
  if (!data) return;

  const dot = document.getElementById('krakenDot');
  const text = document.getElementById('krakenText');

  if (!data.available) {
    document.getElementById('btcPrice').textContent = '--';
    document.getElementById('btcDirection').innerHTML = '<span class="dir-badge dir-flat">NO DATA</span>';
    dot.className = 'kraken-dot dot-red';
    text.textContent = data.connected ? 'Waiting...' : 'Disconnected';
    return;
  }

  document.getElementById('btcPrice').textContent = '$' + data.currentPrice.toLocaleString();
  document.getElementById('btcDirection').innerHTML = directionBadge(data.direction);

  document.getElementById('btcChange1m').innerHTML = formatChangeVal(data.change1m);
  document.getElementById('btcChange3m').innerHTML = formatChangeVal(data.change3m);
  document.getElementById('btcChange5m').innerHTML = formatChangeVal(data.change5m);
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

async function updateWindowBar() {
  const data = await api('/window-status');
  if (!data) return;

  const timerEl = document.getElementById('windowTimer');
  const openEl = document.getElementById('windowOpen');
  const leadEl = document.getElementById('windowLead');
  const sideEl = document.getElementById('windowSide');
  const bar = document.getElementById('windowBar');

  if (data.secondsLeft !== undefined && data.secondsLeft !== null) {
    const min = Math.floor(data.secondsLeft / 60);
    const sec = Math.floor(data.secondsLeft % 60);
    timerEl.textContent = `${min}:${String(sec).padStart(2, '0')} left`;

    if (data.secondsLeft <= 90 && data.secondsLeft > 0) {
      bar.className = 'window-bar window-scalp-zone';
    } else if (data.secondsLeft <= 120) {
      bar.className = 'window-bar window-approaching';
    } else {
      bar.className = 'window-bar';
    }
  } else {
    timerEl.textContent = '--:--';
  }

  if (data.openPrice) {
    openEl.textContent = '$' + data.openPrice.toLocaleString();
  } else {
    openEl.textContent = '--';
  }

  if (data.btcVsOpenDollars !== null && data.btcVsOpenDollars !== undefined) {
    const sign = data.btcVsOpenRaw >= 0 ? '+' : '-';
    leadEl.textContent = `${sign}$${data.btcVsOpenDollars.toFixed(0)}`;
    leadEl.className = `window-value ${data.btcVsOpenRaw >= 0 ? 'positive' : 'negative'}`;
  } else {
    leadEl.textContent = '--';
    leadEl.className = 'window-value';
  }

  if (data.btcLeadingSide) {
    sideEl.innerHTML = data.btcLeadingSide === 'UP'
      ? '<span class="dir-badge dir-up">UP</span>'
      : '<span class="dir-badge dir-down">DOWN</span>';
  } else {
    sideEl.textContent = '--';
  }
}

function updateMultiCoinCards(status) {
  if (!status || !status.multiCoinStatus) return;

  const mcs = status.multiCoinStatus;

  for (const coin of COINS) {
    const card = document.getElementById(`coinCard_${coin}`);
    const statusEl = document.getElementById(`coinStatus_${coin}`);
    const upEl = document.getElementById(`coinUp_${coin}`);
    const downEl = document.getElementById(`coinDown_${coin}`);
    const timeEl = document.getElementById(`coinTime_${coin}`);

    if (!card) continue;

    const data = mcs[coin];
    if (!data) {
      statusEl.textContent = 'Waiting...';
      statusEl.className = 'coin-status';
      upEl.textContent = '--';
      upEl.className = 'coin-price-val';
      downEl.textContent = '--';
      downEl.className = 'coin-price-val';
      timeEl.textContent = '--';
      card.className = 'coin-card';
      continue;
    }

    const sig = data.signal;
    const sLeft = data.secondsLeft || sig?.secondsLeft;

    if (sig && sig.ready) {
      statusEl.innerHTML = `<span class="badge badge-win">SCALP ${sig.side}</span>`;
      card.className = 'coin-card coin-card-active';
    } else if (sig && sig.reason) {
      const short = sig.reason.length > 40 ? sig.reason.substring(0, 40) + '...' : sig.reason;
      statusEl.textContent = short;
      statusEl.className = 'coin-status';
      card.className = 'coin-card';
    } else {
      statusEl.textContent = 'Monitoring';
      card.className = 'coin-card';
    }

    const up = data.liveUpPrice || sig?.upPrice;
    const down = data.liveDownPrice || sig?.downPrice;

    if (up !== undefined && up !== null) {
      upEl.textContent = '$' + up.toFixed(3);
      upEl.className = 'coin-price-val ' + (up >= 0.85 ? 'positive' : '');
    }
    if (down !== undefined && down !== null) {
      downEl.textContent = '$' + down.toFixed(3);
      downEl.className = 'coin-price-val ' + (down >= 0.85 ? 'positive' : '');
    }

    if (sLeft !== undefined && sLeft !== null) {
      const m = Math.floor(sLeft / 60);
      const s = Math.floor(sLeft % 60);
      timeEl.textContent = `${m}:${String(s).padStart(2, '0')} left`;
    }
  }
}

async function updateScalpBar() {
  const status = await api('/status');
  if (!status) return;

  const signal = status.lastSignalStatus;
  const icon = document.getElementById('scalpIcon');
  const label = document.getElementById('scalpLabel');
  const detail = document.getElementById('scalpDetail');
  const bar = document.getElementById('scalpBar');
  const config = document.getElementById('scalpConfig');

  updateMultiCoinCards(status);

  if (status.config) {
    config.textContent = `Entry: $${status.config.minEntry}-$${status.config.maxEntry} | Window: ${status.config.minSeconds}-${status.config.maxSeconds}s | BTC, ETH, SOL, XRP`;
  }

  if (signal && signal.ready) {
    const coin = signal.market?.coin || 'BTC';
    bar.className = 'scalp-bar scalp-active';
    icon.innerHTML = '&#9889;';
    icon.className = 'scalp-icon scalp-icon-active';
    label.textContent = `SCALP READY: BUY ${signal.side} [${coin}]`;
    label.className = 'scalp-label scalp-label-active';
    detail.textContent = signal.reason;
    detail.className = 'scalp-detail scalp-detail-active';
  } else if (signal) {
    bar.className = 'scalp-bar';
    icon.innerHTML = '&#9679;';
    icon.className = 'scalp-icon';
    label.textContent = 'WATCHING ALL COINS';
    label.className = 'scalp-label';
    detail.textContent = signal.reason || 'Monitoring BTC, ETH, SOL, XRP...';
    detail.className = 'scalp-detail';
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

    const netPnL = parseFloat(safety.dailyNetPnL || 0);
    const pnlEl = document.getElementById('dailyNetPnL');
    pnlEl.textContent = `$${safety.dailyNetPnL || '0.00'}`;
    pnlEl.className = `s-value ${netPnL > 0 ? 'positive' : netPnL < 0 ? 'negative' : ''}`;

    document.getElementById('dailySpent').textContent = `$${safety.dailySpent || '0.00'}`;
    document.getElementById('tradesToday').textContent = safety.dailyTradeCount;

    const lossPct = safety.maxDailyLosses > 0 ? ((safety.dailyLossCount || 0) / safety.maxDailyLosses * 100) : 0;
    const progressBar = document.getElementById('lossProgress');
    progressBar.style.width = `${Math.min(100, lossPct)}%`;
    progressBar.style.background = lossPct > 80 ? '#f85149' : lossPct > 50 ? '#d29922' : '#3fb950';

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

async function updateScalpLog() {
  const activities = await api('/activities?limit=80');
  if (!activities || activities.length === 0) return;

  const scalpEvents = activities.filter(a =>
    a.type.includes('scalp') || a.type.includes('trade') || a.type.includes('strategy') || a.type.includes('price_check')
  );

  const panel = document.getElementById('scalpLogPanel');
  const countEl = document.getElementById('scalpLogCount');
  countEl.textContent = `${scalpEvents.length} events`;

  if (scalpEvents.length === 0) {
    panel.innerHTML = '<div class="empty-state">No scalp events yet. Bot scans BTC, ETH, SOL, XRP — buys winning side at $0.85-$0.95 when 15-120 seconds remain.</div>';
    return;
  }

  panel.innerHTML = scalpEvents.map(a => {
    let cls = getTypeClass(a.type);
    let icon = '';
    if (a.type === 'scalp_signal') icon = '&#9889; ';
    if (a.type === 'scalp_trade') icon = '&#128176; ';
    if (a.type === 'trade_success') icon = '&#9989; ';
    if (a.type === 'scalp_skip') icon = '&#128683; ';

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
    const side = t.action === 'BUY_YES' ? 'UP' : 'DOWN';
    const sideCls = side === 'UP' ? 'action-buy-yes' : 'action-buy-no';
    const payout = t.price > 0 ? (1 / t.price).toFixed(2) : '?';
    const pnlStr = t.pnl !== undefined && t.pnl !== 0 ? `$${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}` : '--';
    const pnlCls = t.pnl > 0 ? 'positive' : t.pnl < 0 ? 'negative' : '';
    const coin = t.coin || 'BTC';

    return `<tr>
      <td>${formatTime(t.timestamp)}</td>
      <td><span class="coin-badge-sm coin-${coin.toLowerCase()}">${coin}</span></td>
      <td><span class="decision-action ${sideCls}">${side}</span></td>
      <td>$${t.price?.toFixed(3) || '0.000'}</td>
      <td>$${t.size?.toFixed(2) || '0.00'}</td>
      <td>${payout}x</td>
      <td>${getResultBadge(t.result)}</td>
      <td class="${pnlCls}">${pnlStr}</td>
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
      <span style="margin-left:6px;">${p.question || 'Trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${p.size?.toFixed(2) || '?'} ${p.side || ''} | ends ${timeStr}</span>
    </div>`;
  }

  for (const h of data.history) {
    html += `<div class="activity-item">
      <div class="activity-time">${formatTime(h.redeemedAt)}</div>
      ${getRedeemStatusBadge(h.status)}
      <span style="margin-left:6px;">${h.question || 'Trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${h.size?.toFixed(2) || '?'} ${h.side || ''}${h.txHash ? ' | TX: ' + h.txHash.substring(0, 12) + '...' : ''}</span>
    </div>`;
  }

  panel.innerHTML = html;
}

async function refreshAll() {
  await Promise.all([
    updateBtcTicker(),
    updateWindowBar(),
    updateScalpBar(),
    updateStatus(),
    updateStats(),
    updateScalpLog(),
    updateActivities(),
    updateTrades(),
    updateRedemptions()
  ]);
}

refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL);
