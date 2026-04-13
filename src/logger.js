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
}

module.exports = new Logger();
