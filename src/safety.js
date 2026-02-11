const logger = require('./logger');

class SafetySystem {
  constructor() {
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 15;
    this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE) || 5;
    this.maxDailyTrades = parseInt(process.env.MAX_DAILY_TRADES) || 6;
    this.killSwitch = false;
    this.dailyLoss = 0;
    this.dailySpent = 0;
    this.dailyTradeCount = 0;
    this.lastResetDate = new Date().toDateString();
    this.tradedWindows = {};
  }

  reload() {
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 15;
    this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE) || 5;
    this.maxDailyTrades = parseInt(process.env.MAX_DAILY_TRADES) || 6;
  }

  resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss = 0;
      this.dailySpent = 0;
      this.dailyTradeCount = 0;
      this.tradedWindows = {};
      this.lastResetDate = today;
      logger.addActivity('safety', { message: 'Daily counters reset for new day' });
    }
  }

  canTrade() {
    this.resetDailyIfNeeded();

    if (this.killSwitch) {
      return { allowed: false, reason: 'Kill switch is ON - trading stopped' };
    }

    if (this.dailyLoss >= this.dailyLossLimit) {
      return { allowed: false, reason: `Daily loss limit reached: $${this.dailyLoss.toFixed(2)} / $${this.dailyLossLimit}` };
    }

    if (this.dailyTradeCount >= this.maxDailyTrades) {
      return { allowed: false, reason: `Max daily trades reached: ${this.dailyTradeCount} / ${this.maxDailyTrades}` };
    }

    return { allowed: true, reason: 'All checks passed' };
  }

  hasTraded(coin, windowKey) {
    const key = `${coin}_${windowKey}`;
    return !!this.tradedWindows[key];
  }

  markTraded(coin, windowKey) {
    const key = `${coin}_${windowKey}`;
    this.tradedWindows[key] = true;
    logger.addActivity('safety', { message: `Marked ${coin} as traded for window ${windowKey}` });
  }

  getWindowKey(endTime) {
    if (!endTime) return 'unknown';
    const d = new Date(endTime);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}_${String(d.getUTCHours()).padStart(2,'0')}${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }

  getTradeSize(confidence) {
    this.resetDailyIfNeeded();

    let size = this.maxTradeSize;
    if (confidence === 'MEDIUM') {
      size = this.maxTradeSize * 0.5;
    } else if (confidence === 'HIGH') {
      size = this.maxTradeSize;
    } else {
      return 0;
    }

    const remainingBudget = this.dailyLossLimit - this.dailyLoss;
    if (size > remainingBudget) {
      size = remainingBudget;
    }

    return Math.max(0, parseFloat(size.toFixed(2)));
  }

  recordTrade(amount) {
    this.dailyTradeCount++;
    this.dailySpent += Math.abs(amount);
    logger.addActivity('safety', {
      message: `Trade placed: $${Math.abs(amount).toFixed(2)}. Daily trades: ${this.dailyTradeCount}, Daily spent: $${this.dailySpent.toFixed(2)}, Daily losses: $${this.dailyLoss.toFixed(2)} / $${this.dailyLossLimit}`
    });
  }

  recordLoss(amount) {
    this.dailyLoss += Math.abs(amount);
    logger.addActivity('safety', {
      message: `Loss recorded: $${Math.abs(amount).toFixed(2)}. Daily losses: $${this.dailyLoss.toFixed(2)} / $${this.dailyLossLimit}`
    });
  }

  recordWin(amount) {
    logger.addActivity('safety', {
      message: `Win recorded: +$${Math.abs(amount).toFixed(2)}`
    });
  }

  toggleKillSwitch() {
    this.killSwitch = !this.killSwitch;
    logger.addActivity('safety', {
      message: `Kill switch ${this.killSwitch ? 'ACTIVATED' : 'DEACTIVATED'}`
    });
    return this.killSwitch;
  }

  setKillSwitch(value) {
    this.killSwitch = !!value;
    logger.addActivity('safety', {
      message: `Kill switch ${this.killSwitch ? 'ACTIVATED' : 'DEACTIVATED'}`
    });
    return this.killSwitch;
  }

  getStatus() {
    this.resetDailyIfNeeded();
    return {
      killSwitch: this.killSwitch,
      dailyLoss: this.dailyLoss.toFixed(2),
      dailySpent: this.dailySpent.toFixed(2),
      dailyLossLimit: this.dailyLossLimit.toFixed(2),
      dailyLossPercent: ((this.dailyLoss / this.dailyLossLimit) * 100).toFixed(1),
      dailyTradeCount: this.dailyTradeCount,
      maxTradeSize: this.maxTradeSize.toFixed(2),
      maxDailyTrades: this.maxDailyTrades,
      remainingBudget: Math.max(0, this.dailyLossLimit - this.dailyLoss).toFixed(2),
      remainingTrades: Math.max(0, this.maxDailyTrades - this.dailyTradeCount),
      tradedWindows: Object.keys(this.tradedWindows).length,
      canTrade: this.canTrade()
    };
  }
}

module.exports = new SafetySystem();
