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
  if (type.includes('scan')) return 'type-scan';
  if (type.includes('ai') || type.includes('decision')) return 'type-ai';
  if (type.includes('trade')) return 'type-trade';
  if (type.includes('error')) return 'type-error';
  if (type.includes('safety')) return 'type-safety';
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
    document.getElementById('dailyLoss').textContent = `$${safety.dailyLoss} / $${safety.dailyLossLimit}`;
    document.getElementById('remainingBudget').textContent = `$${safety.remainingBudget}`;
    document.getElementById('maxTrade').textContent = `$${safety.maxTradeSize}`;
    document.getElementById('tradesToday').textContent = safety.dailyTradeCount;

    const pct = parseFloat(safety.dailyLossPercent);
    const bar = document.getElementById('lossProgress');
    bar.style.width = `${Math.min(100, pct)}%`;
    bar.style.background = pct > 80 ? '#f85149' : pct > 50 ? '#d29922' : '#3fb950';

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

  if (stats.coinStats) {
    const container = document.getElementById('coinStats');
    container.innerHTML = ['BTC', 'ETH', 'SOL', 'XRP'].map(coin => {
      const s = stats.coinStats[coin];
      const pnlVal = parseFloat(s.pnl);
      return `<div class="coin-stat-card">
        <div class="coin-name">${coin}</div>
        <div class="coin-detail">${s.totalTrades} trades | ${s.winRate}% WR</div>
        <div class="coin-detail">${s.wins}W / ${s.losses}L</div>
        <div class="coin-detail ${pnlVal > 0 ? 'positive' : pnlVal < 0 ? 'negative' : ''}">
          P&L: $${s.pnl}
        </div>
      </div>`;
    }).join('');
  }
}

async function updateDecisions() {
  const decisions = await api('/decisions?limit=20');
  if (!decisions || decisions.length === 0) return;

  document.getElementById('decisionCount').textContent = `${decisions.length} decisions`;
  const panel = document.getElementById('decisionsPanel');

  panel.innerHTML = decisions.map(d => `
    <div class="decision-card">
      <div class="decision-header">
        <span class="decision-coin">${d.coin || 'N/A'}</span>
        <span class="decision-action ${getActionClass(d.action)}">${d.action}</span>
      </div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:6px;">${d.question || ''}</div>
      <div class="decision-reasoning">${d.reasoning || 'No reasoning provided'}</div>
      <div class="decision-meta">
        <span>Confidence: <strong>${d.confidence}</strong></span>
        <span>YES: ${d.yesPrice?.toFixed(3) || 'N/A'}</span>
        <span>Trend: ${d.trendDirection || 'N/A'}</span>
        <span>Momentum: ${d.momentum || 'N/A'}</span>
        <span>${formatTime(d.timestamp)}</span>
      </div>
    </div>
  `).join('');
}

async function updateActivities() {
  const activities = await api('/activities?limit=40');
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
    const pnl = t.pnl || 0;
    return `<tr>
      <td>${formatTime(t.timestamp)}</td>
      <td><strong>${t.coin || 'N/A'}</strong></td>
      <td><span class="decision-action ${getActionClass(t.action)}">${t.action}</span></td>
      <td>${t.confidence || 'N/A'}</td>
      <td>$${t.size?.toFixed(2) || '0.00'}</td>
      <td>$${t.price?.toFixed(3) || '0.000'}</td>
      <td>${getResultBadge(t.result)}</td>
      <td class="${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}">$${pnl.toFixed(2)}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${(t.reasoning || '').replace(/"/g, '&quot;')}">${t.reasoning || 'N/A'}</td>
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

async function refreshAll() {
  await Promise.all([
    updateStatus(),
    updateStats(),
    updateDecisions(),
    updateActivities(),
    updateTrades()
  ]);
}

refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL);
