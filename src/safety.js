const logger = require('./logger');

class SafetySystem {
  constructor() {
    this.dailyLossLimit    = parseFloat(process.env.DAILY_LOSS_LIMIT)  || 100;
    this.maxTradeSize      = parseFloat(process.env.MAX_TRADE_SIZE)    || 10;
    this.maxDailyLosses    = parseInt(process.env.MAX_DAILY_LOSSES)    || 999;
    this.losingStreakStop  = parseInt(process.env.LOSING_STREAK_STOP)  || 3;
    this.cooldownSeconds   = parseInt(process.env.LOSS_COOLDOWN_SEC)   || 120;

    this.killSwitch        = false;
    this.dailyLoss         = 0;
    this.dailySpent        = 0;
    this.dailyTradeCount   = 0;
    this.dailyWinCount     = 0;
    this.dailyLossCount    = 0;
    this.dailyProfit       = 0;
    this.lastResetDate     = new Date().toDateString();

    // NEW: consecutive loss tracking and cooldown
    this.consecutiveLosses = 0;
    this.lastLossTime      = null;
  }

  reload() {
    this.dailyLossLimit   = parseFloat(process.env.DAILY_LOSS_LIMIT)  || 100;
    this.maxTradeSize     = parseFloat(process.env.MAX_TRADE_SIZE)     || 10;
    this.maxDailyLosses   = parseInt(process.env.MAX_DAILY_LOSSES)     || 999;
    this.losingStreakStop = parseInt(process.env.LOSING_STREAK_STOP)   || 3;
    this.cooldownSeconds  = parseInt(process.env.LOSS_COOLDOWN_SEC)    || 120;
  }

  resetDailyIfNeeded() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLoss         = 0;
      this.dailySpent        = 0;
      this.dailyTradeCount   = 0;
      this.dailyWinCount     = 0;
      this.dailyLossCount    = 0;
      this.dailyProfit       = 0;
      this.consecutiveLosses = 0;
      this.lastLossTime      = null;
      this.lastResetDate     = today;
      logger.addActivity('safety', { message: 'Daily counters reset for new day' });
    }
  }

  resetDailyCounters() {
    this.dailyLoss         = 0;
    this.dailySpent        = 0;
    this.dailyTradeCount   = 0;
    this.dailyWinCount     = 0;
    this.dailyLossCount    = 0;
    this.dailyProfit       = 0;
    this.consecutiveLosses = 0;
    this.lastLossTime      = null;
    this.lastResetDate     = new Date().toDateString();
    logger.addActivity('safety', { message: 'Daily counters manually reset (kill switch unchanged)' });
  }

  // Returns seconds remaining in loss cooldown, or 0 if no cooldown active.
  getCooldownRemaining() {
    if (!this.lastLossTime || this.cooldownSeconds <= 0) return 0;
    const elapsed = (Date.now() - this.lastLossTime) / 1000;
    const remaining = this.cooldownSeconds - elapsed;
    return remaining > 0 ? remaining : 0;
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
    if (this.consecutiveLosses >= this.losingStreakStop) {
      return { allowed: false, reason: `Losing streak (${this.consecutiveLosses}) hit limit (${this.losingStreakStop})` };
    }
    const cooldown = this.getCooldownRemaining();
    if (cooldown > 0) {
      return { allowed: false, reason: `Loss cooldown: ${Math.ceil(cooldown)}s remaining` };
    }
    return { allowed: true, reason: 'All checks passed' };
  }

  recordTrade(amount) {
    this.dailyTradeCount++;
    this.dailySpent += Math.abs(amount);
  }

  recordLoss(amount) {
    this.dailyLoss         += Math.abs(amount);
    this.dailyLossCount++;
    this.consecutiveLosses++;
    this.lastLossTime       = Date.now();
    const canStill          = this.canTrade();
    logger.addActivity('safety', {
      message: `LOSS: -$${Math.abs(amount).toFixed(2)} | Daily: $${this.dailyLoss.toFixed(2)}/$${this.dailyLossLimit} | Streak: ${this.consecutiveLosses}/${this.losingStreakStop} | Cooldown: ${this.cooldownSeconds}s | ${canStill.allowed ? 'Still trading' : 'STOPPED: ' + canStill.reason}`
    });
  }

  recordWin(amount) {
    this.dailyWinCount++;
    this.dailyProfit      += Math.abs(amount);
    this.consecutiveLosses = 0;
    this.lastLossTime      = null;
    logger.addActivity('safety', {
      message: `WIN: +$${Math.abs(amount).toFixed(2)} | Record: ${this.dailyWinCount}W/${this.dailyLossCount}L | Net: $${(this.dailyProfit - this.dailyLoss).toFixed(2)} | Streak reset`
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
    const netPnL   = this.dailyProfit - this.dailyLoss;
    const canTrade = this.canTrade();
    return {
      killSwitch:          this.killSwitch,
      dailyLoss:           this.dailyLoss.toFixed(2),
      dailySpent:          this.dailySpent.toFixed(2),
      dailyLossLimit:      this.dailyLossLimit.toFixed(2),
      dailyLossPercent:    ((this.dailyLoss / this.dailyLossLimit) * 100).toFixed(1),
      dailyTradeCount:     this.dailyTradeCount,
      dailyWinCount:       this.dailyWinCount,
      dailyLossCount:      this.dailyLossCount,
      maxDailyLosses:      this.maxDailyLosses,
      dailyProfit:         this.dailyProfit.toFixed(2),
      dailyNetPnL:         netPnL.toFixed(2),
      maxTradeSize:        this.maxTradeSize.toFixed(2),
      remainingBudget:     Math.max(0, this.dailyLossLimit - this.dailyLoss).toFixed(2),
      consecutiveLosses:   this.consecutiveLosses,
      losingStreakStop:    this.losingStreakStop,
      cooldownRemaining:   Math.ceil(Math.max(0, this.getCooldownRemaining())),
      cooldownSeconds:     this.cooldownSeconds,
      canTrade,
      canTradeAllowed:     canTrade.allowed,
      canTradeReason:      canTrade.reason
    };
  }
}

module.exports = new SafetySystem();
