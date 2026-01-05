/**
 * Early Activity Tracker
 * Observes tokens for 300-800ms to detect early trading activity
 * Uses ONLY in-memory data from WebSocket notifications
 */

interface TokenObservation {
  mint: string;
  detectedAt: number;
  activityCount: number; // Number of transactions seen for this token
  hasActivity: boolean;
  uniqueBuyers: Set<string>; // Unique buyer addresses
  totalVolumeSol: number; // Total volume in SOL
  hasSells: boolean; // Whether any sells were detected
}

export class EarlyActivityTracker {
  private observations = new Map<string, TokenObservation>();
  private readonly OBSERVATION_WINDOW_MS = 500; // 500ms observation window
  private readonly MIN_ACTIVITY_COUNT = 1; // At least 1 transaction = activity

  /**
   * Start observing a token when first detected
   * Returns true if token should be allowed (has activity or window not expired)
   */
  startObservation(mint: string): boolean {
    const now = Date.now();
    const existing = this.observations.get(mint);

    if (existing) {
      // Token already being observed
      // If we've seen activity, allow immediately
      if (existing.hasActivity) {
        return true;
      }
      // If window expired and no activity, reject
      if (now - existing.detectedAt > this.OBSERVATION_WINDOW_MS) {
        this.observations.delete(mint);
        return false;
      }
      // Still in window, continue observing
      return true;
    }

    // Start new observation
    this.observations.set(mint, {
      mint,
      detectedAt: now,
      activityCount: 0,
      hasActivity: false,
      uniqueBuyers: new Set<string>(),
      totalVolumeSol: 0,
      hasSells: false,
    });

    // Allow entry immediately (we'll observe in background)
    // If no activity is seen, we'll reject on next check
    return true;
  }

  /**
   * Record activity for a token (called when we see another transaction from PumpPortal)
   * @param mint - Token mint address
   * @param traderPublicKey - Trader's public key (optional)
   * @param solAmount - Amount in SOL (optional)
   * @param txType - Transaction type: 'buy' or 'sell' (optional)
   */
  recordActivity(mint: string, traderPublicKey?: string, solAmount?: number, txType?: 'buy' | 'sell'): void {
    const observation = this.observations.get(mint);
    if (observation) {
      observation.activityCount++;

      // Track unique buyers
      if (traderPublicKey && txType === 'buy') {
        observation.uniqueBuyers.add(traderPublicKey);
      }

      // Track volume
      if (solAmount && solAmount > 0) {
        observation.totalVolumeSol += solAmount;
      }

      // Track sells
      if (txType === 'sell') {
        observation.hasSells = true;
      }

      if (observation.activityCount >= this.MIN_ACTIVITY_COUNT) {
        observation.hasActivity = true;
      }
    }
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

