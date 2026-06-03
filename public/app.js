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

  // BTC mode: swap header title + show/hide panels
  const btcMode = status.mode === 'BTC';
  const titleEl       = document.getElementById('pageTitle');
  const stratEl       = document.getElementById('strategyBadge');
  const btcCard       = document.getElementById('mc_btc');
  const soccerCard    = document.getElementById('mc_soccer');
  const soccerStatsBar     = document.getElementById('soccerStatsBar');
  const btcAnalyticsSec    = document.getElementById('btcAnalyticsSection');
  if (btcMode) {
    if (titleEl) titleEl.innerHTML = '&#8383; BTC 15m Momentum Bot';
    if (stratEl) stratEl.textContent = 'BUY UP/DOWN — TAKE PROFIT AT $0.75 — STOP LOSS -18¢';
    if (btcCard) btcCard.style.display = '';
    if (soccerCard) soccerCard.closest('.market-grid').style.display = 'none';
    if (soccerStatsBar) soccerStatsBar.style.display = 'none';
    if (btcAnalyticsSec) btcAnalyticsSec.style.display = '';
  } else {
    if (titleEl) titleEl.innerHTML = '&#9917; Soccer Bond Bot';
    if (stratEl) stratEl.textContent = 'BUY YES AT 95¢ — HOLD TO $1.00';
    if (btcCard) btcCard.style.display = 'none';
    if (soccerCard) soccerCard.closest('.market-grid').style.display = '';
    if (soccerStatsBar) soccerStatsBar.style.display = '';
    if (btcAnalyticsSec) btcAnalyticsSec.style.display = 'none';
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


function buildPositionCard(p) {
  const midStr   = p.lastMid   != null ? `$${p.lastMid.toFixed(3)}`   : '--';
  const entryStr = p.entryPrice != null ? `$${p.entryPrice.toFixed(3)}` : '--';
  const bidStr   = p.currentBestBid != null ? `$${p.currentBestBid.toFixed(3)}` : '--';

  let pnlStr = ''; let pnlCls = '';
  const pnlVal = p.unrealizedPnL ?? p.pnl;
  if (pnlVal != null) {
    pnlStr = (pnlVal >= 0 ? '+' : '') + `$${pnlVal.toFixed(3)}`;
    pnlCls = pnlVal >= 0 ? 'positive' : 'negative';
  }

  const question = (p.question || p.eventTitle || '').length > 52
    ? (p.question || p.eventTitle).slice(0, 52) + '…'
    : (p.question || p.eventTitle || 'Market');

  const endStr = p.minutesLeft > 0 ? `${p.minutesLeft}m left` : 'ended';
  const isHeld = ['buying', 'holding', 'liquidating', 'redeeming'].includes(p.phase);

  const canForceSell = ['holding', 'liquidating', 'buying'].includes(p.phase) &&
                       p.yesTokenId && p.filledTokens > 0;

  // Server fetches a fresh CLOB orderbook at click time and uses the actual top bid.
  // Client sends NO price — anything we'd send here is stale.
  const forceSellBtn = canForceSell
    ? `<button class="btn-force-sell" onclick="forceSell('${p.yesTokenId}',${p.remainingTokens || p.filledTokens},${!!p.negRisk},'${p.tickSize || '0.01'}',this)" title="FAK sell at live top bid (fetched server-side)">Force Sell</button>`
    : '';

  const detailLine = isHeld
    ? `bid ${bidStr} | mid ${midStr} | entry ${entryStr} | ${p.filledTokens > 0 ? p.filledTokens.toFixed(4) + ' tokens' : ''} | ${endStr}`
    : `mid ${midStr} | threshold $${(p.threshold || 0.95).toFixed(2)} | ${endStr}`;

  return `<div class="activity-item" style="flex-direction:column;align-items:flex-start;gap:4px;padding:8px 10px;${isHeld ? 'border-left:2px solid #3fb95066;' : ''}">
    <div style="display:flex;align-items:center;gap:6px;width:100%;">
      ${soccerPhaseBadge(p.phase)}
      <span style="flex:1;font-size:12px;color:#e6edf3;line-height:1.3;">${question}</span>
      ${pnlStr ? `<span class="${pnlCls}" style="font-weight:700;font-size:13px;white-space:nowrap;">${pnlStr}</span>` : ''}
      ${forceSellBtn}
    </div>
    <div style="font-size:11px;color:#8b949e;padding-left:2px;">${detailLine}</div>
  </div>`;
}

async function updateSoccerPositions() {
  const positions = await api('/soccer-positions');
  if (!positions) return;

  const watchPanel  = document.getElementById('soccerPanel');
  const heldPanel   = document.getElementById('heldPanel');
  const countEl     = document.getElementById('mc_soccer_count');
  const statusEl    = document.getElementById('mc_soccer_status');
  const heldCountEl = document.getElementById('heldCount');
  const heldStatEl  = document.getElementById('heldStatus');
  if (!watchPanel || !heldPanel) return;

  const heldPhases    = ['buying', 'holding', 'liquidating', 'redeeming'];
  const heldPositions = positions.filter(p => heldPhases.includes(p.phase));
  const watchPositions= positions.filter(p => p.phase === 'watching');
  const done          = positions.filter(p => p.phase === 'done').length;

  // ── Watching panel counter ──
  countEl.textContent = positions.length === 0
    ? '0 watching'
    : `${watchPositions.length} watching${done > 0 ? ` | ${done} done` : ''}`;
  statusEl.textContent = 'Buy YES at 95¢+, hold to $1.00 resolution';

  // ── Held positions panel ──
  if (heldPositions.length === 0) {
    heldCountEl.textContent = '0 held';
    heldStatEl.textContent  = 'No open positions — bot will populate this when entries are made';
    heldPanel.innerHTML     = '';
  } else {
    const totalUnrealized = heldPositions.reduce((s, p) => s + (p.unrealizedPnL || 0), 0);
    const exiting         = heldPositions.filter(p => p.phase === 'liquidating').length;
    heldCountEl.textContent = `${heldPositions.length} held`;
    heldStatEl.textContent  = `unrealized ${totalUnrealized >= 0 ? '+' : ''}$${totalUnrealized.toFixed(3)}${exiting > 0 ? ` | ${exiting} EXITING` : ''}`;
    heldPanel.innerHTML     = heldPositions.map(buildPositionCard).join('');
  }

  // ── Watching panel ──
  if (watchPositions.length === 0) {
    watchPanel.innerHTML = '<div class="empty-state" style="padding:16px 12px;">No live markets being watched right now</div>';
  } else {
    watchPanel.innerHTML = watchPositions.map(buildPositionCard).join('');
  }
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

async function updateBtcPositions() {
  const s = await api('/btc-status');
  if (!s || !s.isRunning) return;

  const countEl  = document.getElementById('btcSessionCount');
  const statusEl = document.getElementById('btcStatusLine');
  const bodyEl   = document.getElementById('btcPanel');
  const priceEl  = document.getElementById('btcPriceBadge');
  if (!countEl || !bodyEl) return;

  // Live BTC price badge
  if (s.btcContext && s.btcContext.available) {
    const ctx = s.btcContext;
    const dir = ctx.direction === 'RISING' ? '▲' : ctx.direction === 'FALLING' ? '▼' : '—';
    priceEl.textContent = `BTC $${(ctx.currentPrice || 0).toLocaleString()} ${dir} ${ctx.change3m?.percent || '0.000'}% 3m`;
  }

  // Only show active sessions (skip done/cancelled)
  const active = (s.activeSessions || []).filter(sess => sess.phase !== 'done');

  countEl.textContent = active.length === 0 ? 'no active session' : `${active.length} session${active.length > 1 ? 's' : ''}`;

  const cfg = s.config || {};
  const sft = s.safety || {};
  statusEl.textContent = `TP $${(cfg.takeProfit || 0.75).toFixed(2)} | SL -${((cfg.stopLossCents || 0.10) * 100).toFixed(0)}¢ | threshold ±${(cfg.momentumThreshold || 0.12)}% | spread max ${((cfg.maxSpread || 0.03) * 100).toFixed(0)}¢ | trades today ${sft.dailyTradeCount || 0}/${cfg.maxDailyTrades || 6} | streak ${sft.consecutiveLosses || 0}/${sft.losingStreakStop || 3}${sft.cooldownRemaining > 0 ? ` | cooldown ${sft.cooldownRemaining}s` : ''}`;

  if (active.length === 0) {
    let waitMsg = 'No active BTC sessions — waiting for next 15m window or entry signal';
    if (sft.cooldownRemaining > 0) waitMsg = `⏸ Loss cooldown active — ${sft.cooldownRemaining}s remaining before next entry allowed`;
    else if ((sft.consecutiveLosses || 0) >= (sft.losingStreakStop || 3)) waitMsg = `🛑 Losing streak limit (${sft.consecutiveLosses}) reached — paused for this window`;
    else if ((sft.dailyTradeCount || 0) >= (cfg.maxDailyTrades || 6)) waitMsg = `🛑 Daily trade limit (${sft.dailyTradeCount}/${cfg.maxDailyTrades}) reached — no more entries today`;
    bodyEl.innerHTML = `<div class="empty-state" style="padding:16px 12px;">${waitMsg}</div>`;
    return;
  }

  const phaseBadgeMap = {
    waiting:  '<span class="badge" style="background:#1c2128;color:#8b949e;border:1px solid #30363d;">WATCHING</span>',
    entering: '<span class="badge" style="background:#2d2000;color:#d29922;border:1px solid #d2992244;">ENTERING</span>',
    managing: '<span class="badge" style="background:#0d1f0d;color:#3fb950;border:1px solid #3fb95044;">HOLDING</span>',
    exiting:  '<span class="badge" style="background:#2d1a00;color:#f0883e;border:1px solid #f0883e44;">EXITING</span>',
    flipping: '<span class="badge" style="background:#1a1a3d;color:#58a6ff;border:1px solid #58a6ff44;">FLIPPING</span>'
  };

  bodyEl.innerHTML = active.map(sess => {
    const phaseBadge = phaseBadgeMap[sess.phase] || `<span class="badge">${(sess.phase || '').toUpperCase()}</span>`;

    const dirBadge = sess.signal === 'UP'
      ? '<span class="badge" style="background:#1a3d1a;color:#3fb950;border:1px solid #3fb95044;">▲ UP</span>'
      : sess.signal === 'DOWN'
      ? '<span class="badge" style="background:#3d1a1a;color:#f85149;border:1px solid #f8514944;">▼ DOWN</span>'
      : '';

    // Regime badge
    const regimeBadge = sess.regime === 'TREND'
      ? '<span class="badge" style="background:#0d1f2d;color:#58a6ff;border:1px solid #58a6ff33;font-size:10px;">TREND</span>'
      : sess.regime === 'MIXED'
      ? '<span class="badge" style="background:#2d1a00;color:#d29922;border:1px solid #d2992233;font-size:10px;">MIXED</span>'
      : '';

    let pnlStr = ''; let pnlCls = '';
    if (sess.unrealizedPnL != null) {
      pnlStr = (sess.unrealizedPnL >= 0 ? '+' : '') + `$${sess.unrealizedPnL.toFixed(3)}`;
      pnlCls = sess.unrealizedPnL >= 0 ? 'positive' : 'negative';
    }

    // Line 1: price/execution info
    const priceparts = [];
    if (sess.lastBid != null && sess.lastAsk != null) {
      priceparts.push(`bid $${sess.lastBid.toFixed(3)} / ask $${sess.lastAsk.toFixed(3)}`);
    }
    if (sess.lastSpread != null) priceparts.push(`spread ${(sess.lastSpread * 100).toFixed(1)}¢`);
    if (sess.lastAskDepth != null) priceparts.push(`depth $${sess.lastAskDepth.toFixed(0)}`);

    // Line 2: position/signal info
    const parts = [];
    if (sess.entryPrice != null)      parts.push(`entry $${sess.entryPrice.toFixed(3)} (ask)`);
    if (sess.lastMid != null)         parts.push(`mid $${sess.lastMid.toFixed(3)}`);
    if (sess.takeProfitPrice != null) parts.push(`TP $${sess.takeProfitPrice.toFixed(2)}`);
    if (sess.stopLossPrice != null)   parts.push(`SL $${sess.stopLossPrice.toFixed(3)}`);
    if (sess.trailingActive)          parts.push(`trail $${(sess.trailingStopLevel || 0).toFixed(3)}`);
    parts.push(`${sess.secondsLeft}s left`);
    if (sess.btcChange3m != null)     parts.push(`BTC 3m: ${sess.btcChange3m > 0 ? '+' : ''}${sess.btcChange3m.toFixed(3)}%`);

    // Line 3: signal quality
    const qualparts = [];
    if (sess.confidence != null)    qualparts.push(`conf ${(sess.confidence * 100).toFixed(0)}%`);
    if (sess.estimatedEdge != null) qualparts.push(`edge +${(sess.estimatedEdge * 100).toFixed(2)}¢/tok`);
    if (sess.skipReason)            qualparts.push(`skip: ${sess.skipReason}`);

    const question  = (sess.question || 'BTC 15m').slice(0, 52);
    const isHolding = sess.phase === 'managing';

    return `<div class="activity-item" style="flex-direction:column;align-items:flex-start;gap:4px;padding:8px 10px;${isHolding ? 'border-left:2px solid #3fb95066;' : ''}">
      <div style="display:flex;align-items:center;gap:6px;width:100%;flex-wrap:wrap;">
        ${phaseBadge}
        ${dirBadge}
        ${regimeBadge}
        <span style="flex:1;font-size:12px;color:#e6edf3;line-height:1.3;min-width:120px;">${question}</span>
        ${pnlStr ? `<span class="${pnlCls}" style="font-weight:700;font-size:13px;white-space:nowrap;">${pnlStr}</span>` : ''}
      </div>
      ${priceparts.length ? `<div style="font-size:11px;color:#58a6ff;padding-left:2px;">${priceparts.join(' | ')}</div>` : ''}
      <div style="font-size:11px;color:#8b949e;padding-left:2px;">${parts.join(' | ')}</div>
      ${qualparts.length ? `<div style="font-size:11px;color:#d29922;padding-left:2px;">${qualparts.join(' | ')}</div>` : ''}
    </div>`;
  }).join('');
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

async function forceSell(tokenId, size, negRisk, tickSize, btn) {
  if (!confirm(`Force-sell ${parseFloat(size).toFixed(4)} tokens?\n\nServer will fetch the live CLOB orderbook NOW and place a Fill-or-Kill at the actual top bid. If there is no bid liquidity, nothing will be sold.`)) return;
  const origText = btn.textContent;
  btn.textContent = 'Selling...';
  btn.disabled    = true;
  try {
    const res = await api('/force-sell', 'POST', { tokenId, size, negRisk, tickSize });
    if (res && res.success) {
      const msg = `Sold @ $${(res.sellPrice || 0).toFixed(3)} (live top bid)\nFilled: ${res.filled.toFixed(4)} tokens\nRemaining: ${res.remaining.toFixed(4)} tokens${res.orderId ? '\nOrder: ' + res.orderId : ''}${res.remaining > 0.01 ? '\n\nPartial fill — click Force Sell again to retry on the next available bid.' : ''}`;
      alert(msg);
    } else if (res?.reason === 'NO_BID_LIQUIDITY') {
      alert(`No bid liquidity right now — nothing was sold.\n\n${res.detail || ''}\n\nTry again in a few seconds when buyers return to the book.`);
    } else if (res?.reason === 'NO_FILL') {
      alert(`Order accepted but ZERO matched at $${(res.sellPrice || 0).toFixed(3)} — no buyer hit it before the FAK expired.\n\nNothing was sold. Click again to retry on the next book snapshot.`);
    } else if (res?.reason === 'FAK_REJECTED') {
      alert(`FAK rejected at $${(res.sellPrice || 0).toFixed(3)}: ${res.detail || 'unknown'}\n\nClick again to retry on the next book snapshot.`);
    } else {
      alert(`Force sell failed: ${res?.error || res?.reason || 'unknown error'}`);
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

function _pnlClass(n) { return n > 0 ? 'positive' : n < 0 ? 'negative' : ''; }
function _pnlStr(n)   { return (n >= 0 ? '+' : '') + '$' + n.toFixed(4); }
function _wrClass(n)  { return n >= 50 ? 'positive' : n < 40 ? 'negative' : 'warn'; }

async function updateBtcAnalytics() {
  const sec = document.getElementById('btcAnalyticsSection');
  if (!sec || sec.style.display === 'none') return;

  const data = await api('/btc-analytics');
  if (!data) return;

  const { summary: s, byExitReason, byPriceBand, dailySummary, trades } = data;

  // ── Summary bar ──
  const countEl = document.getElementById('btcAnalyticsCount');
  if (countEl) countEl.textContent = `${s.total} completed trades`;

  const set = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls !== undefined) el.className = `s-value ${cls}`;
  };

  set('ba_total',  s.total,  '');
  set('ba_wr',     s.total ? s.win_rate + '%' : '—', s.total ? _wrClass(s.win_rate) : '');
  set('ba_exp',    s.total ? _pnlStr(s.expectancy)   : '—', s.total ? _pnlClass(s.expectancy)   : '');
  set('ba_netpnl', s.total ? _pnlStr(s.total_net_pnl): '—', s.total ? _pnlClass(s.total_net_pnl): '');
  set('ba_fees',   s.total ? '-$' + s.total_fees      : '—', s.total ? 'negative' : '');
  set('ba_agw',    s.wins   ? _pnlStr(s.avg_gross_win) : '—', s.wins ? 'positive' : '');
  set('ba_agl',    s.losses ? _pnlStr(s.avg_gross_loss): '—', s.losses ? 'negative' : '');
  set('ba_anw',    s.wins   ? _pnlStr(s.avg_net_win)   : '—', s.wins ? 'positive' : '');
  set('ba_anl',    s.losses ? _pnlStr(s.avg_net_loss)  : '—', s.losses ? 'negative' : '');
  set('ba_hold',   s.avg_hold_secs ? Math.round(s.avg_hold_secs) + 's' : '—', '');
  set('ba_spin',   s.avg_spread_in  ? (s.avg_spread_in  * 100).toFixed(1) + '¢' : '—', '');
  set('ba_spout',  s.avg_spread_out ? (s.avg_spread_out * 100).toFixed(1) + '¢' : '—', '');

  // ── Exit reason table ──
  const rb = document.getElementById('btcReasonBody');
  if (rb) {
    rb.innerHTML = byExitReason.length ? byExitReason.map(r => `<tr>
      <td>${r.reason}</td>
      <td>${r.count}</td>
      <td class="${_wrClass(r.win_rate)}">${r.win_rate}%</td>
      <td class="${_pnlClass(r.avg_net)}">${_pnlStr(r.avg_net)}</td>
      <td class="${_pnlClass(r.net_pnl)}">${_pnlStr(r.net_pnl)}</td>
      <td class="negative">-$${r.fees.toFixed(4)}</td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-state">No data yet</td></tr>';
  }

  // ── Price band table ──
  const bb = document.getElementById('btcBandBody');
  if (bb) {
    bb.innerHTML = byPriceBand.length ? byPriceBand.map(b => `<tr>
      <td>${b.band}</td>
      <td>${b.count}</td>
      <td class="${b.count ? _wrClass(b.win_rate) : ''}">${b.count ? b.win_rate + '%' : '—'}</td>
      <td class="${b.count ? _pnlClass(b.avg_net) : ''}">${b.count ? _pnlStr(b.avg_net) : '—'}</td>
      <td class="${b.count ? _pnlClass(b.net_pnl) : ''}">${b.count ? _pnlStr(b.net_pnl) : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No data yet</td></tr>';
  }

  // ── Daily summary table ──
  const db = document.getElementById('btcDailyBody');
  if (db) {
    db.innerHTML = dailySummary.length ? dailySummary.map(d => `<tr>
      <td>${d.date}</td>
      <td>${d.trades}</td>
      <td class="${_wrClass(d.win_rate)}">${d.win_rate}%</td>
      <td class="${_pnlClass(d.net_pnl)}">${_pnlStr(d.net_pnl)}</td>
      <td class="negative">-$${d.fees.toFixed(4)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No daily data yet</td></tr>';
  }

  // ── Full trades table ──
  const tc = document.getElementById('btcTradeCount');
  if (tc) tc.textContent = `${trades.length} trades`;

  const tb = document.getElementById('btcFullTradeBody');
  if (!tb) return;

  if (!trades.length) {
    tb.innerHTML = '<tr><td colspan="15" class="empty-state">No completed BTC trades yet</td></tr>';
    return;
  }

  tb.innerHTML = trades.map(t => {
    const dir = t.direction === 'UP'
      ? '<span class="badge" style="background:#1a3d1a;color:#3fb950;font-size:10px;padding:1px 5px;">▲ UP</span>'
      : '<span class="badge" style="background:#3d1a1a;color:#f85149;font-size:10px;padding:1px 5px;">▼ DN</span>';
    const res = t.result === 'win'
      ? '<span class="badge badge-win" style="font-size:10px;">W</span>'
      : '<span class="badge badge-loss" style="font-size:10px;">L</span>';
    const hold  = t.hold_seconds != null ? t.hold_seconds + 's' : '—';
    const spIn  = t.spread_at_entry != null ? (t.spread_at_entry * 100).toFixed(1) + '¢' : '—';
    const spOut = t.spread_at_exit  != null ? (t.spread_at_exit  * 100).toFixed(1) + '¢' : '—';
    const sig   = t.btc_signal_at_entry != null ? (t.btc_signal_at_entry >= 0 ? '+' : '') + t.btc_signal_at_entry.toFixed(2) + '%' : '—';
    const sle   = t.seconds_left_at_entry != null ? t.seconds_left_at_entry + 's' : '—';
    const closeTime = t.timestamp_close ? new Date(t.timestamp_close).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    const gross = (t.gross_pnl || 0), fees = (t.estimated_fees || 0), net = (t.net_pnl || 0);

    return `<tr>
      <td style="white-space:nowrap;">${closeTime}</td>
      <td>${dir}</td>
      <td>$${(t.entry_price || 0).toFixed(3)}</td>
      <td>$${(t.exit_price  || 0).toFixed(3)}</td>
      <td>${(t.shares || 0).toFixed(2)}</td>
      <td>${hold}</td>
      <td>${spIn}</td>
      <td>${spOut}</td>
      <td class="${_pnlClass(gross)}">${_pnlStr(gross)}</td>
      <td class="negative">-$${fees.toFixed(4)}</td>
      <td class="${_pnlClass(net)}">${_pnlStr(net)}</td>
      <td style="white-space:nowrap;">${t.exit_reason || '—'}</td>
      <td>${t.was_flip_reentry ? '✓' : '—'}</td>
      <td>${sig}</td>
      <td>${sle}</td>
    </tr>`;
  }).join('');
}

async function refreshAll() {
  await Promise.all([
    updateStatus(),
    updateStats(),
    updateBtcPositions(),
    updateBtcAnalytics(),
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
