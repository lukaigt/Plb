const logger = require('./logger');

class SafetySystem {
  constructor() {
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 15;
    this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE) || 5;
    this.killSwitch = false;
    this.dailyLoss = 0;
    this.dailyTradeCount = 0;
    this.lastResetDate = new Date().toDateString();
  }

  reload() {
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 15;
    this.maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE) || 5;
  }

  resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss = 0;
      this.dailyTradeCount = 0;
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

    return { allowed: true, reason: 'All checks passed' };
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
  }

  recordLoss(amount) {
    this.dailyLoss += Math.abs(amount);
    logger.addActivity('safety', {
      message: `Loss recorded: $${Math.abs(amount).toFixed(2)}. Daily total: $${this.dailyLoss.toFixed(2)} / $${this.dailyLossLimit}`
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
      dailyLossLimit: this.dailyLossLimit.toFixed(2),
      dailyLossPercent: ((this.dailyLoss / this.dailyLossLimit) * 100).toFixed(1),
      dailyTradeCount: this.dailyTradeCount,
      maxTradeSize: this.maxTradeSize.toFixed(2),
      remainingBudget: Math.max(0, this.dailyLossLimit - this.dailyLoss).toFixed(2),
      canTrade: this.canTrade()
    };
  }
}

module.exports = new SafetySystem();
