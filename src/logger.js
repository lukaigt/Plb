const EventEmitter = require('events');

class Logger extends EventEmitter {
  constructor() {
    super();
    this.activityLog = [];
    this.tradeHistory = [];
    this.aiDecisions = [];
    this.maxLogSize = 500;
  }

  addActivity(type, data) {
    const entry = {
      id: Date.now() + Math.random().toString(36).substr(2, 5),
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
      id: Date.now() + Math.random().toString(36).substr(2, 5),
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
      id: Date.now() + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      ...trade
    };
    this.tradeHistory.unshift(entry);
    if (this.tradeHistory.length > this.maxLogSize) {
      this.tradeHistory = this.tradeHistory.slice(0, this.maxLogSize);
    }
    this.emit('trade', entry);
    return entry;
  }

  updateTrade(tradeId, updates) {
    const trade = this.tradeHistory.find(t => t.id === tradeId);
    if (trade) {
      Object.assign(trade, updates);
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
    const trades = this.tradeHistory.filter(t => t.result !== 'pending');
    const wins = trades.filter(t => t.result === 'win');
    const losses = trades.filter(t => t.result === 'loss');
    const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = trades.filter(t => new Date(t.timestamp) >= todayStart);
    const todayPnL = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    const coinStats = {};
    for (const coin of ['BTC', 'ETH', 'SOL', 'XRP']) {
      const coinTrades = trades.filter(t => t.coin === coin);
      const coinWins = coinTrades.filter(t => t.result === 'win');
      coinStats[coin] = {
        totalTrades: coinTrades.length,
        wins: coinWins.length,
        losses: coinTrades.length - coinWins.length,
        winRate: coinTrades.length > 0 ? ((coinWins.length / coinTrades.length) * 100).toFixed(1) : '0.0',
        pnl: coinTrades.reduce((sum, t) => sum + (t.pnl || 0), 0).toFixed(2)
      };
    }

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : '0.0',
      totalPnL: totalPnL.toFixed(2),
      todayPnL: todayPnL.toFixed(2),
      todayTrades: todayTrades.length,
      pendingTrades: this.tradeHistory.filter(t => t.result === 'pending').length,
      coinStats
    };
  }
}

module.exports = new Logger();
