/**
 * Early Activity Tracker
 * Observes tokens for 300-800ms to detect early trading activity
 * Uses ONLY in-memory data from WebSocket notifications
 */

interface TokenObservation {
  mint: string;
  detectedAt: number;
  activityCount: number; // Total transactions seen for this token
  buyCount: number;      // Number of 'buy' transactions
  volumeSol: number;    // Total SOL volume from buys
  uniqueBuyers: Set<string>; // Set of unique buyer public keys
  hasSells: boolean;    // Whether at least one sell transaction was seen
  hasActivity: boolean;
}

export class EarlyActivityTracker {
  private observations = new Map<string, TokenObservation>();
  private readonly OBSERVATION_WINDOW_MS = 60000; // Increased to 60s for filter data collection
  private readonly MIN_ACTIVITY_COUNT = 1;

  /**
   * Start observing a token when first detected
   */
  startObservation(mint: string): boolean {
    const now = Date.now();
    const existing = this.observations.get(mint);

    if (existing) {
      return true;
    }

    // Start new observation
    this.observations.set(mint, {
      mint,
      detectedAt: now,
      activityCount: 0,
      buyCount: 0,
      volumeSol: 0,
      uniqueBuyers: new Set<string>(),
      hasSells: false,
      hasActivity: false,
    });

    return true;
  }

  /**
   * Record activity for a token
   */
  recordActivity(mint: string, trader?: string, solAmount?: number, txType?: string): void {
    const observation = this.observations.get(mint);
    if (observation) {
      observation.activityCount++;
      observation.hasActivity = true;

      // Tracking advanced metrics for filtering
      if (txType === 'buy') {
        observation.buyCount++;
        if (solAmount) {
          observation.volumeSol += solAmount;
        }
        if (trader) {
          observation.uniqueBuyers.add(trader);
        }
      } else if (txType === 'sell') {
        observation.hasSells = true;
      }
    }
  }

  /**
   * Get metrics for a token
   */
  getMetrics(mint: string) {
    const obs = this.observations.get(mint);
    if (!obs) return null;

    return {
      buyCount: obs.buyCount,
      volumeSol: obs.volumeSol,
      uniqueBuyers: obs.uniqueBuyers.size,
      hasSells: obs.hasSells,
      ageMs: Date.now() - obs.detectedAt,
    };
  }

  /**
   * Check if token has shown early activity
   * Called before entry decision
   * Returns false only if window expired AND no activity was seen
   */
  hasEarlyActivity(mint: string): boolean {
    const observation = this.observations.get(mint);
    if (!observation) {
      // Not being observed - allow (fallback, shouldn't happen)
      return true;
    }

    const now = Date.now();
    const elapsed = now - observation.detectedAt;

    // If we've seen activity, always allow
    if (observation.hasActivity) {
      return true;
    }

    // If window expired and no activity, reject (dead token)
    if (elapsed > this.OBSERVATION_WINDOW_MS) {
      this.observations.delete(mint);
      return false;
    }

    // Still in observation window, no activity yet - allow for now
    // Will check again on next attempt
    return true;
  }

  /**
   * Get momentum metrics (velocity) for a token
   */
  getMomentum(mint: string) {
    const obs = this.observations.get(mint);
    if (!obs) return null;

    const now = Date.now();
    const elapsedSec = (now - obs.detectedAt) / 1000;

    if (elapsedSec < 1) return null; // Avoid division by zero or jitter

    return {
      mint,
      uniqueBuyers: obs.uniqueBuyers.size,
      volumeSol: obs.volumeSol,
      buyCount: obs.buyCount,
      buyersPerSec: obs.uniqueBuyers.size / elapsedSec,
      volumeSolPerSec: obs.volumeSol / elapsedSec,
      ageSeconds: elapsedSec,
      hasSells: obs.hasSells
    };
  }

  /**
   * Clean up expired observations
   */
  cleanup(): void {
    const now = Date.now();
    for (const [mint, observation] of this.observations.entries()) {
      if (now - observation.detectedAt > this.OBSERVATION_WINDOW_MS * 2) {
        this.observations.delete(mint);
      }
    }
  }

  /**
   * ⭐ КРИТИЧНО: Полная очистка всех наблюдений
   * Вызывается при старте бота для предотвращения повторной обработки токенов
   * @returns Количество очищенных наблюдений
   */
  clearAll(): number {
    const size = this.observations.size;
    this.observations.clear();
    return size;
  }
}

export const earlyActivityTracker = new EarlyActivityTracker();

// Cleanup every 5 seconds
setInterval(() => {
  earlyActivityTracker.cleanup();
}, 5000);

