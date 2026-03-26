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
  if (type.includes('mom_error'))     return 'type-error';
  if (type.includes('mom_tp_hit'))    return 'type-trade';
  if (type.includes('mom_sl'))        return 'type-safety';
  if (type.includes('mom_flip'))      return 'type-trade';
  if (type.includes('mom_peak'))      return 'type-mm';
  if (type.includes('mom_trailing'))  return 'type-mm';
  if (type.includes('mom_filled'))    return 'type-trade';
  if (type.includes('mom_entry'))     return 'type-mm';
  if (type.includes('mom_signal'))    return 'type-mm';
  if (type.includes('mom_'))          return 'type-bot';
  if (type.includes('mm_error'))      return 'type-error';
  if (type.includes('mm_takeprofit')) return 'type-trade';
  if (type.includes('mm_close'))      return 'type-safety';
  if (type.includes('mm_'))           return 'type-mm';
  if (type.includes('take_profit'))   return 'type-trade';
  if (type.includes('trade'))         return 'type-trade';
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

function signalBadge(signal) {
  if (signal === 'UP')   return '<span class="dir-badge dir-up">UP</span>';
  if (signal === 'DOWN') return '<span class="dir-badge dir-down">DOWN</span>';
  return '<span class="dir-badge dir-flat">NONE</span>';
}

function phaseBadge(phase) {
  const map = {
    waiting:   { label: 'WAITING',   cls: 'phase-waiting' },
    entering:  { label: 'ENTERING',  cls: 'phase-quoting' },
    managing:  { label: 'MANAGING',  cls: 'phase-quoting' },
    exiting:   { label: 'EXITING',   cls: 'phase-quoting' },
    flipping:  { label: 'FLIPPING',  cls: 'phase-quoting' },
    closing:   { label: 'CLOSING',   cls: 'phase-closing' },
    done:      { label: 'DONE',      cls: 'phase-closing' },
    no_signal: { label: 'NO SIGNAL', cls: '' },
  };
  return map[phase] || { label: phase?.toUpperCase() || 'IDLE', cls: '' };
}

function updateMarketCard15m(sessions) {
  const session  = sessions.find(s => s.type === '15m');
  const card     = document.getElementById('mc_15m');
  const phaseEl  = document.getElementById('mc_15m_phase');
  const timerEl  = document.getElementById('mc_15m_timer');
  const qEl      = document.getElementById('mc_15m_question');
  const sigEl    = document.getElementById('mc_15m_signal');
  const btcEl    = document.getElementById('mc_15m_btcchange');
  const midEl    = document.getElementById('mc_15m_mid');
  const entryEl  = document.getElementById('mc_15m_entry');
  const peakEl   = document.getElementById('mc_15m_peak');
  const trailEl  = document.getElementById('mc_15m_trail');
  const slEl     = document.getElementById('mc_15m_sl');
  const flipEl   = document.getElementById('mc_15m_flips');
  const pnlEl    = document.getElementById('mc_15m_pnl');
  const cpnlEl   = document.getElementById('mc_15m_cpnl');

  if (!session) {
    phaseEl.textContent = 'Idle';  phaseEl.className = 'mc-phase';
    timerEl.textContent = '--';    qEl.textContent   = 'No active 15-min market';
    sigEl.innerHTML = '--';       btcEl.textContent = '--';
    midEl.textContent = '--';     entryEl.textContent = '--';
    if (peakEl)  peakEl.textContent  = '--';
    if (trailEl) trailEl.textContent = '--';
    if (slEl)    slEl.textContent    = '--';
    if (flipEl)  flipEl.textContent  = '0';
    pnlEl.textContent  = '--';
    if (cpnlEl) cpnlEl.textContent = '--';
    card.className = 'market-card';
    return;
  }

  timerEl.textContent = fmtSeconds(session.secondsLeft) + ' left';
  qEl.textContent = session.question || '--';

  const pb = phaseBadge(session.phase);
  phaseEl.textContent = pb.label;
  phaseEl.className   = `mc-phase ${pb.cls}`;

  const isActive = ['entering', 'managing', 'exiting', 'flipping'].includes(session.phase);
  card.className = isActive ? 'market-card market-card-quoting' : 'market-card';

  sigEl.innerHTML = session.signal ? signalBadge(session.signal) : '<span class="dir-badge dir-flat">WAITING</span>';

  if (session.btcChange3m !== null && session.btcChange3m !== undefined) {
    const pct = parseFloat(session.btcChange3m);
    const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
    btcEl.innerHTML = `<span class="${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(3)}%</span>`;
  } else {
    btcEl.textContent = '--';
  }

  midEl.textContent   = session.lastMid   !== null ? '$' + session.lastMid.toFixed(3)   : '--';
  entryEl.textContent = session.entryPrice !== null ? `$${session.entryPrice.toFixed(3)} (${session.signal || '--'})` : '--';

  if (peakEl) {
    if (session.peakMid !== null && session.peakMid !== undefined) {
      const trailingActive = session.trailingActive;
      peakEl.innerHTML = trailingActive
        ? `<span class="positive">$${session.peakMid.toFixed(3)}</span>`
        : `<span class="neutral">$${session.peakMid.toFixed(3)} (not yet active)</span>`;
    } else {
      peakEl.textContent = '--';
    }
  }

  if (trailEl) {
    if (session.trailingStopLevel !== null && session.trailingStopLevel !== undefined) {
      trailEl.innerHTML = `<span class="negative">$${session.trailingStopLevel.toFixed(3)}</span>`;
    } else {
      const activateOffset = (window._botConfig && window._botConfig.trailingActivate) ? window._botConfig.trailingActivate : 0.01;
      trailEl.textContent = session.entryPrice ? `activates at $${(session.entryPrice + activateOffset).toFixed(3)}` : '--';
    }
  }

  if (slEl) {
    slEl.textContent = session.stopLossPrice !== null && session.stopLossPrice !== undefined
      ? `$${session.stopLossPrice.toFixed(3)}`
      : '--';
  }

  if (flipEl) {
    const maxFlips = (window._botConfig && window._botConfig.maxFlips) ? window._botConfig.maxFlips : 3;
    flipEl.textContent = `${session.flipCount || 0} / ${maxFlips}`;
  }

  if (session.unrealizedPnL !== null && session.unrealizedPnL !== undefined) {
    const val = session.unrealizedPnL;
    const cls = val > 0 ? 'positive' : val < 0 ? 'negative' : 'neutral';
    pnlEl.innerHTML = `<span class="${cls}">${val >= 0 ? '+' : ''}$${val.toFixed(3)}</span>`;
  } else if (session.tradePnl !== null && session.tradePnl !== undefined && session.phase !== 'managing') {
    const val = session.tradePnl;
    const cls = val > 0 ? 'positive' : val < 0 ? 'negative' : 'neutral';
    pnlEl.innerHTML = `<span class="${cls}">LAST ${val >= 0 ? '+' : ''}$${val.toFixed(3)}</span>`;
  } else {
    pnlEl.textContent = '--';
  }

  if (cpnlEl) {
    const cum = session.cumulativePnl || 0;
    if (cum !== 0) {
      const cls = cum > 0 ? 'positive' : 'negative';
      cpnlEl.innerHTML = `<span class="${cls}">${cum >= 0 ? '+' : ''}$${cum.toFixed(3)}</span>`;
    } else {
      cpnlEl.textContent = '$0.00';
    }
  }
}

function updateMarketCard5m(sessions) {
  const session = sessions.find(s => s.type === '5m');
  const timerEl = document.getElementById('mc_5m_timer');
  const qEl     = document.getElementById('mc_5m_question');
  const midEl   = document.getElementById('mc_5m_mid');
  const tlEl    = document.getElementById('mc_5m_timeleft');

  if (!session) {
    timerEl.textContent = '--';
    qEl.textContent = 'Monitoring only — strategy uses 15-min';
    if (midEl) midEl.textContent = '--';
    if (tlEl) tlEl.textContent = '--';
    return;
  }
  timerEl.textContent = fmtSeconds(session.secondsLeft) + ' left';
  if (midEl) midEl.textContent = session.lastMid ? '$' + session.lastMid.toFixed(3) : '--';
  if (tlEl) tlEl.textContent = fmtSeconds(session.secondsLeft);
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
  updateMarketCard15m(sessions);
  updateMarketCard5m(sessions);
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
    window._botConfig = cfg;
    const spreadEl = document.getElementById('spreadConfig');
    if (spreadEl) spreadEl.textContent = `Trail ${(cfg.trailingStop * 100).toFixed(0)}¢ | SL -${(cfg.stopLossCents * 100).toFixed(0)}¢`;
    document.getElementById('orderSizeConfig').textContent = `$${cfg.orderSize} / trade`;
    document.getElementById('scanConfig').textContent      = `Swing ${cfg.marketType} | ±${cfg.momentumThreshold}% signal | ${cfg.maxFlips} flips max`;
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
    a.type.startsWith('mom_') || a.type.startsWith('mm_') ||
    a.type === 'scan' || a.type.includes('trade') || a.type.includes('take_profit')
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

function getPositionStatusBadge(status) {
  const map = {
    open:               '<span class="badge badge-pending">OPEN</span>',
    filled:             '<span class="badge badge-pending" style="background:#1f6feb33;color:#79c0ff;">FILLED</span>',
    take_profit_sent:   '<span class="badge badge-win">TP SENT</span>',
    cancelled:          '<span class="badge badge-failed">CANCELLED</span>',
    tp_failed:          '<span class="badge badge-loss">TP FAIL</span>'
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

async function updatePositions() {
  const data = await api('/positions');
  if (!data) return;

  const open   = data.open   || [];
  const closed = data.closed || [];

  const panel   = document.getElementById('positionsPanel');
  const countEl = document.getElementById('positionsCount');
  const tpPct   = open.length > 0 ? (open[0].takeProfitPct * 100).toFixed(0) : '50';
  countEl.textContent = `${open.length} open | ${closed.length} closed | TP at ${tpPct}% of max gain`;

  if (open.length === 0 && closed.length === 0) {
    panel.innerHTML = '<div class="empty-state">No position fills detected yet. Orders fill when market takers hit our bids.</div>';
    return;
  }

  let html = '';

  for (const p of open) {
    const entryStr  = p.avgFillPrice != null ? `$${p.avgFillPrice.toFixed(3)}` : `$${p.bidPrice?.toFixed(3)}`;
    const midStr    = p.currentMid   != null ? `$${p.currentMid.toFixed(3)}`   : '--';
    let pnlStr = '--'; let pnlCls = '';
    if (p.unrealizedPnL != null) {
      pnlStr = (p.unrealizedPnL >= 0 ? '+' : '') + `$${p.unrealizedPnL.toFixed(3)}`;
      pnlCls = p.unrealizedPnL >= 0 ? 'positive' : 'negative';
    }
    const tpPct = p.takeProfitPct != null ? (p.takeProfitPct * 100).toFixed(0) : '50';
    html += `<div class="activity-item position-row">
      <div class="activity-time">${formatTime(p.addedAt)}</div>
      ${getPositionStatusBadge(p.status)}
      <span class="coin-badge-sm coin-btc" style="margin-left:6px;">BTC-${p.type}</span>
      <span class="${p.side === 'UP' ? 'positive' : 'negative'}" style="margin-left:6px;font-weight:700;">${p.side}</span>
      <span style="margin-left:8px;color:#8b949e;font-size:12px;">in ${entryStr} → now ${midStr} | ${p.filledTokens?.toFixed(2) || '?'} tokens</span>
      <span class="${pnlCls}" style="margin-left:auto;font-weight:600;font-size:13px;">${pnlStr}</span>
    </div>`;
  }

  if (closed.length > 0) {
    html += `<div style="font-size:11px;color:#484f58;padding:6px 0 2px;border-top:1px solid #21262d;margin-top:4px;">Recent exits</div>`;
    for (const p of closed) {
      const pnlPerToken = p.exitPrice && p.entryPrice ? (p.exitPrice - p.entryPrice) : null;
      const pnlTotal    = pnlPerToken !== null && p.filledTokens ? pnlPerToken * p.filledTokens : null;
      const pnlStr      = pnlTotal !== null ? `${pnlTotal > 0 ? '+' : ''}$${pnlTotal.toFixed(3)}` : '--';
      const pnlCls      = pnlTotal !== null ? (pnlTotal > 0 ? 'positive' : 'negative') : '';
      html += `<div class="activity-item">
        <div class="activity-time">${formatTime(p.closedAt)}</div>
        ${getPositionStatusBadge(p.status)}
        <span class="coin-badge-sm coin-btc" style="margin-left:6px;">BTC-${p.type}</span>
        <span style="margin-left:6px;font-size:12px;color:#8b949e;">${p.side} | in $${p.entryPrice?.toFixed(3)} → out $${p.exitPrice?.toFixed(3)}</span>
        <span class="${pnlCls}" style="margin-left:auto;font-weight:600;">${pnlStr}</span>
      </div>`;
    }
  }

  panel.innerHTML = html;
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
    const addr = data.safeAddress;
    const short = addr.length > 12 ? `${addr.slice(0, 10)}...${addr.slice(-6)}` : addr;
    html += `<div class="activity-item" style="border-left:2px solid #58a6ff;"><span class="activity-type type-bot">proxy wallet</span> ${short}</div>`;
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
    updatePositions(),
    updateRedemptions()
  ]);
}

refreshAll();
setInterval(refreshAll, REFRESH_INTERVAL);
