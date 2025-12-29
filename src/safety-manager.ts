/**
 * Safety Manager
 * Applies safety caps to position sizes (stealth and liquidity limits)
 * Note: Balance control is now handled by BalanceManager (automatic withdrawal)
 */

import { config } from './config';

export class SafetyManager {
  constructor(initialBalance: number) {
    // No longer tracking session balance - BalanceManager handles excess withdrawal
  }

  /**
   * Apply safety caps to position size
   * Only applies stealth and liquidity caps - no balance control needed
   */
  applySafetyCaps(positionSize: number, reserveData?: { reserves?: number }): number {
    let safeSize = positionSize;

    // 1. Hard stealth cap per trade (MANDATORY)
    safeSize = Math.min(safeSize, config.maxSolPerTrade);

    // 2. Maximum position size cap (from config)
    safeSize = Math.min(safeSize, config.maxPositionSize);

    // 3. Optional liquidity/reserve cap (only if data available)
    if (reserveData?.reserves && reserveData.reserves > 0) {
      const maxFromReserves = (reserveData.reserves * config.maxReservePercent) / 100;
      safeSize = Math.min(safeSize, maxFromReserves);
    }

    return safeSize;
  }
}


