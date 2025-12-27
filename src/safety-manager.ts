/**
 * Safety Manager
 * Protects account from self-destruction due to growth, visibility, or unattended trading
 */

import { config } from './config';

export class SafetyManager {
  private sessionStartBalance: number;
  private sessionPeakBalance: number;
  private sessionLowestBalance: number;
  private lockedProfit: number = 0;
  private isTradingHalted: boolean = false;

  constructor(initialBalance: number) {
    this.sessionStartBalance = initialBalance;
    this.sessionPeakBalance = initialBalance;
    this.sessionLowestBalance = initialBalance;
  }

  /**
   * Update session tracking with current balance
   */
  updateSessionBalance(currentBalance: number): void {
    if (currentBalance > this.sessionPeakBalance) {
      this.sessionPeakBalance = currentBalance;
    }
    if (currentBalance < this.sessionLowestBalance) {
      this.sessionLowestBalance = currentBalance;
    }

    // Check for session drawdown stop
    const drawdown = ((this.sessionPeakBalance - currentBalance) / this.sessionPeakBalance) * 100;
    if (drawdown > config.sessionMaxDrawdownPct) {
      this.isTradingHalted = true;
    }

    // Profit lock mechanism
    if (config.profitLockEnabled && currentBalance > this.sessionStartBalance) {
      const profitPct = ((currentBalance - this.sessionStartBalance) / this.sessionStartBalance) * 100;
      if (profitPct > config.profitLockThresholdPct) {
        const profit = currentBalance - this.sessionStartBalance;
        const lockAmount = (profit * config.profitLockPercent) / 100;
        this.lockedProfit = Math.max(this.lockedProfit, lockAmount);
      }
    }
  }

  /**
   * Check if trading is halted due to drawdown
   */
  isHalted(): boolean {
    return this.isTradingHalted;
  }

  /**
   * Get working balance (total - locked profit)
   */
  getWorkingBalance(totalBalance: number): number {
    return Math.max(0, totalBalance - this.lockedProfit);
  }

  /**
   * Apply safety caps to position size
   */
  applySafetyCaps(positionSize: number, reserveData?: { reserves?: number }): number {
    let safeSize = positionSize;

    // 1. Hard stealth cap per trade (MANDATORY)
    safeSize = Math.min(safeSize, config.maxSolPerTrade);

    // 2. Optional liquidity/reserve cap (only if data available)
    if (reserveData?.reserves && reserveData.reserves > 0) {
      const maxFromReserves = (reserveData.reserves * config.maxReservePercent) / 100;
      safeSize = Math.min(safeSize, maxFromReserves);
    }

    // 3. Night/unattended risk mode
    if (config.nightModeEnabled && this.isNightMode()) {
      safeSize = safeSize * config.nightModePositionMultiplier;
    }

    return safeSize;
  }

  /**
   * Check if current time is in night mode hours
   */
  private isNightMode(): boolean {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const start = config.nightModeStartHour;
    const end = config.nightModeEndHour;

    if (start <= end) {
      // Normal case: e.g., 0-8
      return utcHour >= start && utcHour < end;
    } else {
      // Wraps midnight: e.g., 22-6
      return utcHour >= start || utcHour < end;
    }
  }

  /**
   * Reset session (for manual restart or new session)
   */
  resetSession(newBalance: number): void {
    this.sessionStartBalance = newBalance;
    this.sessionPeakBalance = newBalance;
    this.sessionLowestBalance = newBalance;
    this.isTradingHalted = false;
    // Keep locked profit across resets (preserve gains)
  }

  /**
   * Get session statistics
   */
  getSessionStats() {
    return {
      startBalance: this.sessionStartBalance,
      peakBalance: this.sessionPeakBalance,
      lowestBalance: this.sessionLowestBalance,
      lockedProfit: this.lockedProfit,
      isHalted: this.isTradingHalted,
    };
  }
}

