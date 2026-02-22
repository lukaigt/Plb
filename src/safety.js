const logger = require('./logger');

class SafetySystem {
  constructor() {
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 25;
    this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE) || 5;
    this.maxDailyLosses = parseInt(process.env.MAX_DAILY_LOSSES) || 6;
    this.killSwitch = false;
    this.dailyLoss = 0;
    this.dailySpent = 0;
    this.dailyTradeCount = 0;
    this.dailyWinCount = 0;
    this.dailyLossCount = 0;
    this.dailyProfit = 0;
    this.lastResetDate = new Date().toDateString();
    this.tradedWindows = {};
  }

  reload() {
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 25;
    this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE) || 5;
    this.maxDailyLosses = parseInt(process.env.MAX_DAILY_LOSSES) || 6;
  }

  resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss = 0;
      this.dailySpent = 0;
      this.dailyTradeCount = 0;
      this.dailyWinCount = 0;
      this.dailyLossCount = 0;
      this.dailyProfit = 0;
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

    if (this.dailyLossCount >= this.maxDailyLosses) {
      return { allowed: false, reason: `Max daily losing trades reached: ${this.dailyLossCount} / ${this.maxDailyLosses} losses` };
    }

    return { allowed: true, reason: 'All checks passed' };
  }

  hasTraded(coin, windowKey) {
    const key = `${coin}_${windowKey}`;
    return !!this.tradedWindows[key];
  }

  getWindowTrade(coin, windowKey) {
    const key = `${coin}_${windowKey}`;
    return this.tradedWindows[key] || null;
  }

  markTraded(coin, windowKey, direction, magnitude) {
    const key = `${coin}_${windowKey}`;
    this.tradedWindows[key] = { direction, magnitude: magnitude || 0 };
    logger.addActivity('safety', { message: `Marked ${coin} as traded for window ${windowKey} (${direction})` });
  }

  getWindowKey(endTime) {
    if (!endTime) return 'unknown';
    const d = new Date(endTime);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}_${String(d.getUTCHours()).padStart(2,'0')}${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }

  getTradeSize(confidence) {
    this.resetDailyIfNeeded();
    if (confidence === 'HIGH') return this.maxTradeSize;
    if (confidence === 'MEDIUM') return this.maxTradeSize;
    return 0;
  }

  recordTrade(amount) {
    this.dailyTradeCount++;
    this.dailySpent += Math.abs(amount);
    logger.addActivity('safety', {
      message: `Trade #${this.dailyTradeCount}: $${Math.abs(amount).toFixed(2)} | Today: ${this.dailyWinCount}W/${this.dailyLossCount}L | Spent: $${this.dailySpent.toFixed(2)}`
    });
  }

  recordLoss(amount) {
    this.dailyLoss += Math.abs(amount);
    this.dailyLossCount++;
    const canStill = this.canTrade();
    logger.addActivity('safety', {
      message: `LOSS #${this.dailyLossCount}: -$${Math.abs(amount).toFixed(2)} | Total losses: $${this.dailyLoss.toFixed(2)}/$${this.dailyLossLimit} | ${canStill.allowed ? 'Can still trade' : 'STOPPED: ' + canStill.reason}`
    });
  }

  recordWin(amount) {
    this.dailyWinCount++;
    this.dailyProfit += Math.abs(amount);
    logger.addActivity('safety', {
      message: `WIN #${this.dailyWinCount}: +$${Math.abs(amount).toFixed(2)} | Record: ${this.dailyWinCount}W/${this.dailyLossCount}L | Net: $${(this.dailyProfit - this.dailyLoss).toFixed(2)}`
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
    const netPnL = this.dailyProfit - this.dailyLoss;
    return {
      killSwitch: this.killSwitch,
      dailyLoss: this.dailyLoss.toFixed(2),
      dailySpent: this.dailySpent.toFixed(2),
      dailyLossLimit: this.dailyLossLimit.toFixed(2),
      dailyLossPercent: ((this.dailyLoss / this.dailyLossLimit) * 100).toFixed(1),
      dailyTradeCount: this.dailyTradeCount,
      dailyWinCount: this.dailyWinCount,
      dailyLossCount: this.dailyLossCount,
      dailyProfit: this.dailyProfit.toFixed(2),
      dailyNetPnL: netPnL.toFixed(2),
      maxDailyLosses: this.maxDailyLosses,
      maxTradeSize: this.maxTradeSize.toFixed(2),
      remainingBudget: Math.max(0, this.dailyLossLimit - this.dailyLoss).toFixed(2),
      remainingLosses: Math.max(0, this.maxDailyLosses - this.dailyLossCount),
      tradedWindows: Object.keys(this.tradedWindows).length,
      canTrade: this.canTrade()
    };
  }
}

module.exports = new SafetySystem();
