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
  if (type.includes('bond_done'))      return 'type-trade';
  if (type.includes('bond_fill'))      return 'type-trade';
  if (type.includes('bond_entry'))     return 'type-mm';
  if (type.includes('bond_loss'))      return 'type-safety';
  if (type.includes('bond_cancelled')) return 'type-safety';
  if (type.includes('bond_error'))     return 'type-error';
  if (type.includes('bond_'))          return 'type-bot';
  if (type.includes('soccer_scan'))    return 'type-scan';
  if (type.includes('trade'))          return 'type-trade';
  if (type.includes('error'))          return 'type-error';
  if (type.includes('safety'))         return 'type-safety';
  if (type.includes('scan'))           return 'type-scan';
  if (type.includes('redeem'))         return 'type-redeem';
  return 'type-bot';
}

function getResultBadge(result) {
  if (result === 'win')     return '<span class="badge badge-win">WIN</span>';
  if (result === 'loss')    return '<span class="badge badge-loss">LOSS</span>';
  if (result === 'pending') return '<span class="badge badge-pending">PENDING</span>';
  return '<span class="badge badge-failed">FAILED</span>';
}

function soccerPhaseBadge(phase) {
  const map = {
    watching:    '<span class="badge" style="background:#1f2d3d;color:#79c0ff;border:1px solid #1f6feb55;">WATCHING</span>',
    buying:      '<span class="badge badge-pending">ENTERED</span>',
    holding:     '<span class="badge" style="background:#1a2f1a;color:#3fb950;border:1px solid #3fb95044;">HOLDING</span>',
    liquidating: '<span class="badge" style="background:#3d2200;color:#f0883e;border:1px solid #f0883e55;">EXITING</span>',
    redeeming:   '<span class="badge" style="background:#1f2d3d;color:#58a6ff;border:1px solid #58a6ff55;">REDEEMING</span>',
    done:        '<span class="badge badge-win">DONE</span>',
    lost:        '<span class="badge badge-loss">LOST</span>'
  };
  return map[phase] || `<span class="badge">${phase}</span>`;
}

async function updateStatus() {
  const status = await api('/status');
  if (!status) return;

  const dot = status.isRunning
    ? '<span class="status-dot dot-green"></span>Running'
    : '<span class="status-dot dot-red"></span>Stopped';
  document.getElementById('botStatus').innerHTML = dot;

  const badge = document.getElementById('envBadge');
  if (badge) {
    if (status.port === 4000) {
      badge.className   = 'env-badge env-live';
      badge.textContent = '● LIVE — VPS :4000';
    } else if (status.port === 5000) {
      badge.className   = 'env-badge env-dev';
      badge.textContent = '● DEV — Replit :5000 (not the live bot)';
    } else {
      badge.className   = 'env-badge env-unknown';
      badge.textContent = `● PORT :${status.port || '?'}`;
    }
  }

  const safety = status.safety;
  if (safety) {
    document.getElementById('killStatus').innerHTML = safety.killSwitch
      ? '<span class="negative">ON</span>'
      : '<span class="positive">OFF</span>';

    document.getElementById('todayRecord').textContent = `${safety.dailyWinCount || 0}W / ${safety.dailyLossCount || 0}L`;

    const lossCount    = safety.dailyLossCount   || 0;
    const maxLosses    = safety.maxDailyLosses   || 50;
    const lcEl         = document.getElementById('lossTradeCount');
    if (lcEl) {
      lcEl.textContent = `${lossCount} / ${maxLosses}`;
      lcEl.className   = `s-value ${lossCount >= maxLosses ? 'negative' : lossCount >= maxLosses * 0.7 ? 'warn' : ''}`;
    }

    document.getElementById('dailyLosses').textContent = `$${safety.dailyLoss || '0.00'} / $${safety.dailyLossLimit || '50.00'}`;

    const netPnL = parseFloat(safety.dailyNetPnL || 0);
    const pnlEl  = document.getElementById('dailyNetPnL');
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

    document.getElementById('killBtn').textContent = safety.killSwitch ? 'Disable Kill Switch' : 'Kill Switch';
    document.getElementById('killBtn').className   = safety.killSwitch ? 'btn btn-green' : 'btn btn-yellow';

    // Halt banner — shows exactly why trading stopped
    const banner = document.getElementById('haltBanner');
    if (banner) {
      if (!safety.canTradeAllowed) {
        banner.style.display = 'block';
        banner.innerHTML = `&#128721; <strong>TRADING HALTED</strong> &mdash; ${safety.canTradeReason || 'Safety limit reached'} &nbsp;&nbsp;<button class="btn btn-blue" style="padding:3px 10px;font-size:11px;" onclick="resetDailyCounters()">Reset Counters</button>`;
      } else {
        banner.style.display = 'none';
      }
    }
  }
}

async function updateStats() {
  const stats = await api('/stats');
  if (!stats) return;

  const pnl   = parseFloat(stats.totalPnL);
  const pnlEl = document.getElementById('totalPnl');
  pnlEl.textContent = `$${stats.totalPnL}`;
  pnlEl.className   = `value ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'neutral'}`;

  document.getElementById('todayPnl').textContent      = `Today: $${stats.todayPnL}`;
  document.getElementById('winRate').textContent       = `${stats.winRate}%`;
  document.getElementById('winRate').className         = `value ${parseFloat(stats.winRate) >= 50 ? 'positive' : 'negative'}`;
  document.getElementById('winLoss').textContent       = `${stats.wins}W / ${stats.losses}L`;
  document.getElementById('totalTrades').textContent   = stats.totalTrades;
  document.getElementById('pendingTrades').textContent = `Pending: ${stats.pendingTrades}`;
}

function isSoccerEvent(type) {
  return type.startsWith('bond_') || type.startsWith('soccer_');
}

async function updateSoccerStats() {
  const s = await api('/soccer-stats');
  if (!s) return;

  const statusEl = document.getElementById('soccerBotStatus');
  if (statusEl) {
    statusEl.innerHTML = s.isRunning
      ? '<span class="status-dot dot-green"></span>Running'
      : '<span class="status-dot dot-red"></span>Off';
  }

  const posEl = document.getElementById('soccerPositionsCount');
  if (posEl) {
    const parts = [];
    if (s.activePositions > 0) parts.push(`${s.activePositions} active`);
    if (s.watchingCount > 0)   parts.push(`${s.watchingCount} watching`);
    posEl.textContent = parts.length ? parts.join(' | ') : '0 active';
  }

  const recEl = document.getElementById('soccerRecord');
  if (recEl) recEl.textContent = `${s.winsToday}W / ${s.lossesToday}L`;

  const wrEl = document.getElementById('soccerWinRate');
  if (wrEl) {
    if (s.winRate !== null) {
      wrEl.textContent = `${s.winRate}%`;
      wrEl.className = `ss-value ${s.winRate >= 50 ? 'positive' : 'negative'}`;
    } else {
      wrEl.textContent = '--';
      wrEl.className = 'ss-value';
    }
  }

  const yieldEl = document.getElementById('soccerYield');
  if (yieldEl) {
    const val = s.yieldCollected;
    yieldEl.textContent = `${val >= 0 ? '+' : ''}$${val.toFixed(3)}`;
    yieldEl.className = `ss-value ${val > 0 ? 'positive' : val < 0 ? 'negative' : ''}`;
  }
}

let _activityFilter = 'all';

function setActivityFilter(filter) {
  _activityFilter = filter;
  document.getElementById('filterAll').className    = filter === 'all'    ? 'btn-filter btn-filter-active' : 'btn-filter';
  document.getElementById('filterSoccer').className = filter === 'soccer' ? 'btn-filter btn-filter-active' : 'btn-filter';
  updateActivities();
}


async function updateSoccerPositions() {
  const positions = await api('/soccer-positions');
  if (!positions) return;

  const panel    = document.getElementById('soccerPanel');
  const countEl  = document.getElementById('mc_soccer_count');
  const statusEl = document.getElementById('mc_soccer_status');
  if (!panel) return;

  const watching = positions.filter(p => p.phase === 'watching').length;
  const active   = positions.filter(p => ['buying', 'holding', 'liquidating', 'redeeming'].includes(p.phase)).length;
  const done     = positions.filter(p => p.phase === 'done').length;

  countEl.textContent = positions.length === 0
    ? '0 watching'
    : `${watching} watching | ${active} active${done > 0 ? ` | ${done} done` : ''}`;

  if (active > 0) {
    const held = positions.filter(p => ['holding', 'liquidating'].includes(p.phase));
    const totalUnrealized = held.reduce((s, p) => s + (p.unrealizedPnL || 0), 0);
    const exiting = positions.filter(p => p.phase === 'liquidating').length;
    statusEl.textContent = `${active} position(s) held${exiting > 0 ? ` | ${exiting} EXITING` : ''} | unrealized ${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toFixed(3)}`;
  } else {
    statusEl.textContent = 'Buy YES at 95¢+, hold to $1.00 resolution';
  }

  if (positions.length === 0) {
    panel.innerHTML = '<div class="empty-state" style="padding:24px 12px;">No live soccer markets yet — scanning every 2 min</div>';
    return;
  }

  panel.innerHTML = positions.map(p => {
    const midStr   = p.lastMid   !== null && p.lastMid   !== undefined ? `$${p.lastMid.toFixed(3)}`   : '--';
    const entryStr = p.entryPrice !== null && p.entryPrice !== undefined ? `$${p.entryPrice.toFixed(3)}` : '--';
    let pnlStr = ''; let pnlCls = '';
    if (p.unrealizedPnL !== null && p.unrealizedPnL !== undefined) {
      pnlStr = (p.unrealizedPnL >= 0 ? '+' : '') + `$${p.unrealizedPnL.toFixed(3)}`;
      pnlCls = p.unrealizedPnL >= 0 ? 'positive' : 'negative';
    } else if (p.pnl !== null && p.pnl !== undefined) {
      pnlStr = (p.pnl >= 0 ? '+' : '') + `$${p.pnl.toFixed(3)}`;
      pnlCls = p.pnl >= 0 ? 'positive' : 'negative';
    }

    const question = (p.question || p.eventTitle || '').length > 52
      ? (p.question || p.eventTitle).slice(0, 52) + '…'
      : (p.question || p.eventTitle || 'Soccer market');

    const endStr = p.minutesLeft > 0 ? `${p.minutesLeft}m left` : 'ended';

    const canForceSell = ['holding', 'liquidating', 'buying'].includes(p.phase) &&
                         p.yesTokenId && p.filledTokens > 0;

    const sellPrice = p.lastMid || p.currentBestBid || p.entryPrice || 0.95;

    const forceSellBtn = canForceSell
      ? `<button class="btn-force-sell" onclick="forceSell('${p.yesTokenId}',${p.remainingTokens || p.filledTokens},${sellPrice.toFixed(4)},${!!p.negRisk},'${p.tickSize || '0.01'}',this)" title="FAK sell at current mid — fills what it can">Force Sell</button>`
      : '';

    return `<div class="activity-item" style="flex-direction:column;align-items:flex-start;gap:4px;padding:8px 10px;">
      <div style="display:flex;align-items:center;gap:6px;width:100%;">
        ${soccerPhaseBadge(p.phase)}
        <span style="flex:1;font-size:12px;color:#e6edf3;line-height:1.3;">${question}</span>
        ${pnlStr ? `<span class="${pnlCls}" style="font-weight:700;font-size:13px;white-space:nowrap;">${pnlStr}</span>` : ''}
        ${forceSellBtn}
      </div>
      <div style="font-size:11px;color:#8b949e;padding-left:2px;">
        mid ${midStr}${p.phase !== 'watching' ? ` | entry ${entryStr} | ${p.filledTokens > 0 ? p.filledTokens.toFixed(4)+' tokens' : ''}` : ` | threshold $${(p.threshold || 0.95).toFixed(2)}`} | ${endStr}
      </div>
    </div>`;
  }).join('');
}

async function updateSoccerLog() {
  const activities = await api('/activities?limit=100');
  if (!activities || activities.length === 0) return;

  const events = activities.filter(a =>
    a.type.startsWith('bond_') || a.type.startsWith('soccer_') || a.type === 'bot'
  );

  const panel   = document.getElementById('mmLogPanel');
  const countEl = document.getElementById('mmLogCount');
  countEl.textContent = `${events.length} events`;

  if (events.length === 0) {
    panel.innerHTML = '<div class="empty-state">No soccer events yet. Bot will start scanning soon.</div>';
    return;
  }

  panel.innerHTML = events.map(a => `
    <div class="activity-item">
      <div class="activity-time">${formatTime(a.timestamp)}</div>
      <span class="activity-type ${getTypeClass(a.type)}">${a.type}</span>
      ${a.message || ''}
    </div>
  `).join('');
}

async function updateActivities() {
  const activities = await api('/activities?limit=100');
  if (!activities || activities.length === 0) return;

  const filtered = _activityFilter === 'soccer'
    ? activities.filter(a => isSoccerEvent(a.type))
    : activities;

  document.getElementById('activityCount').textContent = `${filtered.length} events${_activityFilter === 'soccer' ? ' (soccer)' : ''}`;
  const panel = document.getElementById('activityPanel');

  if (filtered.length === 0) {
    panel.innerHTML = '<div class="empty-state">No soccer events yet.</div>';
    return;
  }

  panel.innerHTML = filtered.map(a => `
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
    const market = (t.eventTitle || t.question || 'SOCCER').slice(0, 30);

    return `<tr>
      <td>${formatTime(t.timestamp)}</td>
      <td><span class="coin-badge-sm coin-soccer">${market}</span></td>
      <td>YES</td>
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
    const addr  = data.safeAddress;
    const short = addr.length > 12 ? `${addr.slice(0, 10)}...${addr.slice(-6)}` : addr;
    html += `<div class="activity-item" style="border-left:2px solid #58a6ff;"><span class="activity-type type-bot">proxy wallet</span> ${short}</div>`;
  }
  for (const p of data.pending) {
    html += `<div class="activity-item">
      <div class="activity-time">${formatTime(p.addedAt)}</div>
      ${getRedeemStatusBadge(p.status)}
      <span style="margin-left:6px;">${p.question || 'Soccer Trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${p.size?.toFixed(2) || '?'} ${p.side || ''}</span>
    </div>`;
  }
  for (const h of data.history) {
    html += `<div class="activity-item">
      <div class="activity-time">${formatTime(h.redeemedAt)}</div>
      ${getRedeemStatusBadge(h.status)}
      <span style="margin-left:6px;">${h.question || 'Soccer Trade'}</span>
      <span style="color:#484f58;font-size:11px;margin-left:auto;">$${h.size?.toFixed(2) || '?'}${h.txHash ? ' | TX: ' + h.txHash.slice(0, 12) + '...' : ''}</span>
    </div>`;
  }
  panel.innerHTML = html;
}

async function toggleKillSwitch() {
  const res = await api('/killswitch', 'POST');
  if (res) alert(res.message);
  updateStatus();
}

async function resetDailyCounters() {
  if (!confirm('Reset all daily counters (loss count, spent, P&L)? Kill switch will NOT be changed.')) return;
  const res = await api('/safety-reset', 'POST');
  if (res && res.success) alert('Daily counters reset. Bot will resume trading if all other limits are clear.');
  else alert(res?.error || 'Reset failed');
  updateStatus();
}

async function scanWallet() {
  const btn = document.querySelector('.btn-purple');
  btn.textContent = 'Scanning...';
  btn.disabled    = true;
  const res = await api('/scan-positions', 'POST');
  if (res) {
    if (res.redeemable > 0) alert(`Found ${res.found} position(s), queued ${res.redeemable} for on-chain check. Press Force Redeem to collect resolved ones.`);
    else if (res.found > 0) alert(`Found ${res.found} position(s) but could not queue any (missing IDs).`);
    else alert(res.error ? `Scan failed: ${res.error}` : 'No positions found.');
  }
  btn.textContent = 'Scan Wallet';
  btn.disabled    = false;
  refreshAll();
}

async function forceRedeem() {
  const btn = document.querySelector('.btn-orange');
  btn.textContent = 'Redeeming...';
  btn.disabled    = true;
  const res = await api('/force-redeem', 'POST');
  if (res) {
    if (res.redeemed > 0) alert(`Redeemed ${res.redeemed} position(s)!`);
    else if (res.pending > 0) alert(`${res.pending} position(s) pending — may not be resolved yet or RPC issue. Check activity log.`);
    else alert(res.error ? `Redeem failed: ${res.error}` : 'No positions to redeem.');
  }
  btn.textContent = 'Force Redeem';
  btn.disabled    = false;
  refreshAll();
}

async function recoverPositions() {
  const btn = document.getElementById('recoverBtn');
  btn.textContent = 'Recovering...';
  btn.disabled    = true;
  const res = await api('/recover-positions', 'POST');
  if (res) {
    if (res.success) alert(`Recovery complete — ${res.positions} position(s) now tracked by exit engine.`);
    else alert(`Recovery failed: ${res.error || 'unknown error'}`);
  }
  btn.textContent = 'Recover Positions';
  btn.disabled    = false;
  refreshAll();
}

async function forceSell(tokenId, size, price, negRisk, tickSize, btn) {
  if (!confirm(`FAK sell ${parseFloat(size).toFixed(4)} tokens @ $${parseFloat(price).toFixed(3)}?\n\nThis is a Fill-or-Kill order — it will fill what it can at the current bid and leave any remainder in your wallet.`)) return;
  const origText = btn.textContent;
  btn.textContent = 'Selling...';
  btn.disabled    = true;
  try {
    const res = await api('/force-sell', 'POST', { tokenId, size, price, negRisk, tickSize });
    if (res && res.success) {
      const msg = `Filled: ${res.filled.toFixed(4)} tokens\nRemaining: ${res.remaining.toFixed(4)} tokens${res.orderId ? '\nOrder: ' + res.orderId : ''}`;
      alert(msg);
    } else {
      alert(`Force sell failed: ${res?.error || 'unknown error'}`);
    }
  } catch (e) {
    alert(`Force sell error: ${e.message}`);
  }
  btn.textContent = origText;
  btn.disabled    = false;
  refreshAll();
}

let _errorPanelCleared = false;

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getErrorTypeClass(type) {
  if (type.includes('error'))  return 'error-type-error';
  if (type.includes('safety')) return 'error-type-warn';
  return 'error-type-debug';
}

async function updateErrorPanel() {
  if (_errorPanelCleared) return;
  const errors = await api('/errors?limit=200');
  if (!errors) return;

  const panel   = document.getElementById('errorPanel');
  const countEl = document.getElementById('errorCount');
  countEl.textContent = `${errors.length} events`;

  if (errors.length === 0) {
    panel.innerHTML = '<div class="empty-state">No errors or debug logs yet.</div>';
    return;
  }

  panel.innerHTML = errors.map(e => {
    const shortType = e.type.replace('bond_error', 'ERROR').replace('safety_block', 'SAFETY').replace('data_error', 'DATA_ERR');
    return `<div class="error-item">
      <span class="error-time">${escapeHtml(formatTime(e.timestamp))}</span>
      <span class="error-type ${getErrorTypeClass(e.type)}">${escapeHtml(shortType)}</span>
      ${escapeHtml(e.message || '')}
    </div>`;
  }).join('');
}

function copyErrors() {
  const panel = document.getElementById('errorPanel');
  const items = panel.querySelectorAll('.error-item');
  if (items.length === 0) { alert('No errors to copy'); return; }

  const lines = Array.from(items).map(item => {
    const time = item.querySelector('.error-time')?.textContent || '';
    const type = item.querySelector('.error-type')?.textContent || '';
    const msg  = item.textContent.replace(time, '').replace(type, '').trim();
    return `[${time}] [${type.trim()}] ${msg}`;
  });

  const text = lines.join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const toast = document.getElementById('copyToast');
    toast.className = 'copy-toast show';
    setTimeout(() => { toast.className = 'copy-toast'; }, 1500);
  }).catch(() => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    const toast = document.getElementById('copyToast');
    toast.className = 'copy-toast show';
    setTimeout(() => { toast.className = 'copy-toast'; }, 1500);
  });
}

function clearErrorPanel() {
  _errorPanelCleared = true;
  document.getElementById('errorPanel').innerHTML = '<div class="empty-state">Cleared. New errors will appear on next refresh.</div>';
  document.getElementById('errorCount').textContent = 'cleared';
  setTimeout(() => { _errorPanelCleared = false; }, 30000);
}

async function refreshAll() {
  await Promise.all([
    updateStatus(),
    updateStats(),
    updateSoccerPositions(),
    updateSoccerStats(),
    updateSoccerLog(),
    updateActivities(),
    updateTrades(),
    updateRedemptions(),
    updateErrorPanel()
  ]);
}

refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL);
