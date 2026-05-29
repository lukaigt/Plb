const EventEmitter = require('events');
const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

class Logger extends EventEmitter {
  constructor() {
    super();
    this.activityLog  = [];
    this.tradeHistory = [];
    this.aiDecisions  = [];
    this.maxLogSize   = 500;
    this._loadTrades();
  }

  _loadTrades() {
    try {
      if (fs.existsSync(TRADES_FILE)) {
        const raw = fs.readFileSync(TRADES_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          this.tradeHistory = data.slice(-this.maxLogSize);
          console.log(`[Logger] Loaded ${this.tradeHistory.length} historical trades from disk`);
        }
      }
    } catch (err) {
      console.log(`[Logger] Could not load trade history: ${err.message}`);
    }
  }

  _saveTrades() {
    try {
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.tradeHistory, null, 2), 'utf8');
    } catch (err) {
      console.log(`[Logger] Could not save trade history: ${err.message}`);
    }
  }

  addActivity(type, data) {
    const entry = {
      id:        Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      type,
      ...data
    };
    this.activityLog.unshift(entry);
    if (this.activityLog.length > this.maxLogSize) {
      this.activityLog = this.activityLog.slice(0, this.maxLogSize);
    }
    this.emit('activity', entry);
    console.log(`[${entry.timestamp}] [${type}] ${data.message || JSON.stringify(data)}`);
    return entry;
  }

  addAiDecision(decision) {
    const entry = {
      id:        Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      ...decision
    };
    this.aiDecisions.unshift(entry);
    if (this.aiDecisions.length > this.maxLogSize) {
      this.aiDecisions = this.aiDecisions.slice(0, this.maxLogSize);
    }
    this.emit('aiDecision', entry);
    return entry;
  }

  addTrade(trade) {
    const entry = {
      id:        Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      ...trade
    };
    this.tradeHistory.unshift(entry);
    if (this.tradeHistory.length > this.maxLogSize) {
      this.tradeHistory = this.tradeHistory.slice(0, this.maxLogSize);
    }
    this.emit('trade', entry);
    this._saveTrades();
    return entry;
  }

  updateTrade(tradeId, updates) {
    const trade = this.tradeHistory.find(t => t.id === tradeId);
    if (trade) {
      Object.assign(trade, updates);
      this._saveTrades();
    }
    return trade;
  }

  getActivities(limit = 50) {
    return this.activityLog.slice(0, limit);
  }

  getAiDecisions(limit = 50) {
    return this.aiDecisions.slice(0, limit);
  }

  getTradeHistory(limit = 50) {
    return this.tradeHistory.slice(0, limit);
  }

  getStats() {
    const trades     = this.tradeHistory.filter(t => t.result !== 'pending');
    const wins       = trades.filter(t => t.result === 'win');
    const losses     = trades.filter(t => t.result === 'loss');
    const totalPnL   = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalFees  = trades.reduce((sum, t) => sum + (t.estimatedFee || 0), 0);
    const netPnL     = totalPnL - totalFees;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades   = trades.filter(t => new Date(t.timestamp) >= todayStart);
    const todayPnL      = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const todayFees     = todayTrades.reduce((sum, t) => sum + (t.estimatedFee || 0), 0);
    const todayNetPnL   = todayPnL - todayFees;

    const exitReasons = {};
    for (const t of trades) {
      if (t.exitReason) {
        exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
      }
    }

    return {
      totalTrades:    trades.length,
      wins:           wins.length,
      losses:         losses.length,
      winRate:        trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : '0.0',
      totalPnL:       totalPnL.toFixed(2),
      totalFees:      totalFees.toFixed(2),
      netPnL:         netPnL.toFixed(2),
      todayPnL:       todayPnL.toFixed(2),
      todayFees:      todayFees.toFixed(2),
      todayNetPnL:    todayNetPnL.toFixed(2),
      todayTrades:    todayTrades.length,
      pendingTrades:  this.tradeHistory.filter(t => t.result === 'pending').length,
      exitReasons
    };
  }

  getBtcTrades(limit = 200) {
    return this.tradeHistory
      .filter(t => t.strategy === 'btc_momentum')
      .slice(0, limit);
  }

  getBtcAnalytics() {
    const trades = this.tradeHistory.filter(
      t => t.strategy === 'btc_momentum' && t.result !== 'pending'
    );

    const wins   = trades.filter(t => t.result === 'win');
    const losses = trades.filter(t => t.result === 'loss');

    const _sum = (arr, fn) => arr.reduce((s, t) => s + (fn(t) || 0), 0);
    const _avg = (arr, fn) => arr.length ? _sum(arr, fn) / arr.length : 0;
    const _f4  = n => parseFloat(n.toFixed(4));

    const summary = {
      total:          trades.length,
      wins:           wins.length,
      losses:         losses.length,
      win_rate:       trades.length ? _f4(wins.length / trades.length * 100) : 0,
      avg_gross_win:  _f4(_avg(wins,   t => t.gross_pnl)),
      avg_gross_loss: _f4(_avg(losses, t => t.gross_pnl)),
      avg_net_win:    _f4(_avg(wins,   t => t.net_pnl)),
      avg_net_loss:   _f4(_avg(losses, t => t.net_pnl)),
      total_fees:     _f4(_sum(trades, t => t.estimated_fees)),
      total_net_pnl:  _f4(_sum(trades, t => t.net_pnl)),
      expectancy:     trades.length ? _f4(_sum(trades, t => t.net_pnl) / trades.length) : 0,
      avg_hold_secs:  _f4(_avg(trades.filter(t => t.hold_seconds), t => t.hold_seconds)),
      avg_spread_in:  _f4(_avg(trades.filter(t => t.spread_at_entry != null), t => t.spread_at_entry)),
      avg_spread_out: _f4(_avg(trades.filter(t => t.spread_at_exit  != null), t => t.spread_at_exit))
    };

    const reasonMap = {};
    for (const t of trades) {
      const r = t.exit_reason || t.exitReason || 'unknown';
      if (!reasonMap[r]) reasonMap[r] = { count: 0, wins: 0, net_pnl: 0, fees: 0 };
      reasonMap[r].count++;
      if (t.result === 'win') reasonMap[r].wins++;
      reasonMap[r].net_pnl += (t.net_pnl || 0);
      reasonMap[r].fees    += (t.estimated_fees || 0);
    }
    const byExitReason = Object.entries(reasonMap).map(([reason, s]) => ({
      reason,
      count:    s.count,
      wins:     s.wins,
      win_rate: _f4(s.wins / s.count * 100),
      net_pnl:  _f4(s.net_pnl),
      avg_net:  _f4(s.net_pnl / s.count),
      fees:     _f4(s.fees)
    })).sort((a, b) => b.count - a.count);

    const bands = [
      { label: '0.18–0.30', min: 0.18, max: 0.30 },
      { label: '0.30–0.45', min: 0.30, max: 0.45 },
      { label: '0.45–0.60', min: 0.45, max: 0.60 },
      { label: '0.60–0.82', min: 0.60, max: 0.83 }
    ];
    const byPriceBand = bands.map(b => {
      const bt = trades.filter(t => {
        const p = t.entry_price || t.entryPrice || 0;
        return p >= b.min && p < b.max;
      });
      const bw = bt.filter(t => t.result === 'win');
      return {
        band:     b.label,
        count:    bt.length,
        wins:     bw.length,
        win_rate: bt.length ? _f4(bw.length / bt.length * 100) : 0,
        net_pnl:  _f4(_sum(bt, t => t.net_pnl)),
        avg_net:  bt.length ? _f4(_sum(bt, t => t.net_pnl) / bt.length) : 0
      };
    });

    const dayMap = {};
    for (const t of trades) {
      const d = (t.timestamp_close || t.timestamp || '').slice(0, 10);
      if (!d) continue;
      if (!dayMap[d]) dayMap[d] = { date: d, trades: 0, wins: 0, losses: 0, net_pnl: 0, fees: 0 };
      dayMap[d].trades++;
      if (t.result === 'win') dayMap[d].wins++;
      else dayMap[d].losses++;
      dayMap[d].net_pnl += (t.net_pnl || 0);
      dayMap[d].fees    += (t.estimated_fees || 0);
    }
    const dailySummary = Object.values(dayMap)
      .map(d => ({
        ...d,
        net_pnl:  _f4(d.net_pnl),
        fees:     _f4(d.fees),
        win_rate: _f4(d.wins / d.trades * 100)
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    return { summary, byExitReason, byPriceBand, dailySummary, trades: trades.slice(0, 200) };
  }
}

module.exports = new Logger();
