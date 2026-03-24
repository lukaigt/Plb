const logger = require('./logger');

class SafetySystem {
  constructor() {
    this.dailyLossLimit  = parseFloat(process.env.DAILY_LOSS_LIMIT)  || 50;
    this.maxTradeSize    = parseFloat(process.env.MAX_TRADE_SIZE)     || 10;
    this.maxDailyLosses  = parseInt(process.env.MAX_DAILY_LOSSES)     || 10;
    this.killSwitch      = false;
    this.dailyLoss       = 0;
    this.dailySpent      = 0;
    this.dailyTradeCount = 0;
    this.dailyWinCount   = 0;
    this.dailyLossCount  = 0;
    this.dailyProfit     = 0;
    this.lastResetDate   = new Date().toDateString();
  }

  reload() {
    this.dailyLossLimit = parseFloat(process.env.DAILY_LOSS_LIMIT) || 50;
    this.maxTradeSize   = parseFloat(process.env.MAX_TRADE_SIZE)    || 10;
    this.maxDailyLosses = parseInt(process.env.MAX_DAILY_LOSSES)    || 10;
  }

  resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss       = 0;
      this.dailySpent      = 0;
      this.dailyTradeCount = 0;
      this.dailyWinCount   = 0;
      this.dailyLossCount  = 0;
      this.dailyProfit     = 0;
      this.lastResetDate   = today;
      logger.addActivity('safety', { message: 'Daily counters reset for new day' });
    }
  }

  canTrade() {
    this.resetDailyIfNeeded();

    if (this.killSwitch) {
      return { allowed: false, reason: 'Kill switch is ON' };
    }
    if (this.dailyLoss >= this.dailyLossLimit) {
      return { allowed: false, reason: `Daily loss limit reached: $${this.dailyLoss.toFixed(2)} / $${this.dailyLossLimit}` };
    }
    if (this.dailyLossCount >= this.maxDailyLosses) {
      return { allowed: false, reason: `Max daily losing trades: ${this.dailyLossCount} / ${this.maxDailyLosses}` };
    }
    return { allowed: true, reason: 'All checks passed' };
  }

  recordTrade(amount) {
    this.dailyTradeCount++;
    this.dailySpent += Math.abs(amount);
  }

  recordLoss(amount) {
    this.dailyLoss += Math.abs(amount);
    this.dailyLossCount++;
    const canStill = this.canTrade();
    logger.addActivity('safety', {
      message: `LOSS: -$${Math.abs(amount).toFixed(2)} | Total losses: $${this.dailyLoss.toFixed(2)}/$${this.dailyLossLimit} | ${canStill.allowed ? 'Still trading' : 'STOPPED: ' + canStill.reason}`
    });
  }

  recordWin(amount) {
    this.dailyWinCount++;
    this.dailyProfit += Math.abs(amount);
    logger.addActivity('safety', {
      message: `WIN: +$${Math.abs(amount).toFixed(2)} | Record: ${this.dailyWinCount}W/${this.dailyLossCount}L | Net: $${(this.dailyProfit - this.dailyLoss).toFixed(2)}`
    });
  }

  toggleKillSwitch() {
    this.killSwitch = !this.killSwitch;
    logger.addActivity('safety', { message: `Kill switch ${this.killSwitch ? 'ACTIVATED' : 'DEACTIVATED'}` });
    return this.killSwitch;
  }

  setKillSwitch(value) {
    this.killSwitch = !!value;
    logger.addActivity('safety', { message: `Kill switch ${this.killSwitch ? 'ACTIVATED' : 'DEACTIVATED'}` });
    return this.killSwitch;
  }

  getStatus() {
    this.resetDailyIfNeeded();
    const netPnL = this.dailyProfit - this.dailyLoss;
    return {
      killSwitch:       this.killSwitch,
      dailyLoss:        this.dailyLoss.toFixed(2),
      dailySpent:       this.dailySpent.toFixed(2),
      dailyLossLimit:   this.dailyLossLimit.toFixed(2),
      dailyLossPercent: ((this.dailyLoss / this.dailyLossLimit) * 100).toFixed(1),
      dailyTradeCount:  this.dailyTradeCount,
      dailyWinCount:    this.dailyWinCount,
      dailyLossCount:   this.dailyLossCount,
      dailyProfit:      this.dailyProfit.toFixed(2),
      dailyNetPnL:      netPnL.toFixed(2),
      maxDailyLosses:   this.maxDailyLosses,
      maxTradeSize:     this.maxTradeSize.toFixed(2),
      remainingBudget:  Math.max(0, this.dailyLossLimit - this.dailyLoss).toFixed(2),
      canTrade:         this.canTrade()
    };
  }
}

module.exports = new SafetySystem();
