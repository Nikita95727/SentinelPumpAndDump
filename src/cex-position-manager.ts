/**
 * CEX Position Manager
 * Управляет позициями на Bybit Spot с логикой импульса
 * Вход на валидном импульсе, выход при затухании или достижении цели
 */

import { Position, PositionStats } from './types';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';
import { BybitClient } from './bybit-client';
import { OrderExecutor } from './order-executor';
import { RiskManager } from './risk-manager';
import { MomentumSignal } from './pair-watcher';

const CHECK_INTERVAL = 2000; // Проверка каждые 2 секунды
const MAX_HOLD_TIME = config.exitTimerSeconds * 1000; // В миллисекундах
const MIN_PROFIT_PCT = 0.4; // Минимальный целевой профит (0.4% с учетом комиссий 0.2%)
const TARGET_PROFIT_PCT = 0.8; // Целевой профит (0.8-1.5%)

/**
 * Single source of truth for account balance
 */
class Account {
  private totalBalance: number; // USD
  private lockedBalance: number;
  private peakBalance: number;

  constructor(initialBalance: number) {
    this.totalBalance = initialBalance;
    this.lockedBalance = 0;
    this.peakBalance = initialBalance;
  }

  getFreeBalance(): number {
    return this.totalBalance - this.lockedBalance;
  }

  getTotalBalance(): number {
    return this.totalBalance;
  }

  getPeakBalance(): number {
    return this.peakBalance;
  }

  reserve(amount: number): boolean {
    if (this.getFreeBalance() < amount || amount <= 0) {
      return false;
    }
    this.lockedBalance += amount;
    if (this.getFreeBalance() < 0) {
      this.lockedBalance -= amount;
      return false;
    }
    return true;
  }

  release(reservedAmount: number, proceeds: number): void {
    if (reservedAmount < 0 || this.lockedBalance < reservedAmount) {
      return;
    }
    this.lockedBalance -= reservedAmount;
    this.totalBalance += proceeds;
    if (this.totalBalance > this.peakBalance) {
      this.peakBalance = this.totalBalance;
    }
    if (this.lockedBalance < 0) {
      this.lockedBalance = 0;
    }
    if (this.totalBalance < 0) {
      this.totalBalance = 0;
    }
  }

  syncTotalBalance(realBalance: number): void {
    if (realBalance < 0) return;
    this.totalBalance = realBalance;
    if (this.totalBalance > this.peakBalance) {
      this.peakBalance = this.totalBalance;
    }
    if (this.lockedBalance > this.totalBalance) {
      this.lockedBalance = Math.max(0, this.totalBalance);
    }
  }
}

export class CEXPositionManager {
  private positions = new Map<string, Position>();
  private account: Account;
  private bybitClient: BybitClient;
  private orderExecutor: OrderExecutor;
  private riskManager: RiskManager;
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor(bybitClient: BybitClient, initialBalance: number) {
    this.bybitClient = bybitClient;
    this.orderExecutor = new OrderExecutor(bybitClient);
    this.account = new Account(initialBalance);
    this.riskManager = new RiskManager(initialBalance);
  }

  /**
   * Начинает мониторинг позиций
   */
  startMonitoring(): void {
    if (this.monitoringInterval) {
      return;
    }

    this.monitoringInterval = setInterval(() => {
      this.checkAllPositions().catch(error => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `Error checking positions: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }, CHECK_INTERVAL);
  }

  /**
   * Останавливает мониторинг
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
  }

  /**
   * Открывает позицию на основе валидного импульса
   */
  async openPosition(symbol: string, signal: MomentumSignal): Promise<boolean> {
    // Проверка рисков
    const riskState = this.riskManager.canOpenPosition(config.maxOpenPositions, this.positions.size);
    if (!riskState.canTrade) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        symbol,
        message: `⚠️ Cannot open position: ${riskState.reason}`,
      });
      return false;
    }

    // Проверяем, не открыта ли уже позиция
    if (this.positions.has(symbol)) {
      return false;
    }

    try {
      // Рассчитываем размер позиции (фиксированный процент депозита)
      const positionSizePercent = 20; // 20% депозита на позицию
      const positionSize = (this.account.getFreeBalance() * positionSizePercent) / 100;
      const minPositionSize = config.minPositionSize;
      const maxPositionSize = config.maxPositionSize;

      if (positionSize < minPositionSize) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          symbol,
          message: `⚠️ Insufficient balance for ${symbol}: ${positionSize.toFixed(2)} USD < ${minPositionSize} USD`,
        });
        return false;
      }

      const actualPositionSize = Math.min(positionSize, maxPositionSize);

      // Резервируем средства (с учетом комиссии 0.1%)
      const reservedAmount = actualPositionSize * 1.001; // +0.1% комиссия
      if (!this.account.reserve(reservedAmount)) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          symbol,
          message: `⚠️ Failed to reserve funds for ${symbol}`,
        });
        return false;
      }

      // Выполняем покупку
      const buyResult = await this.orderExecutor.executeBuy(symbol, actualPositionSize);

      if (!buyResult.success) {
        // Освобождаем резерв при ошибке
        this.account.release(reservedAmount, 0);
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          symbol,
          message: `❌ Failed to buy ${symbol}: ${buyResult.error}`,
        });
        return false;
      }

      // Рассчитываем количество купленных активов
      const quantity = buyResult.filled || (actualPositionSize / (buyResult.averagePrice || signal.predictedPrice));
      const entryPrice = buyResult.averagePrice || signal.predictedPrice;

      // Создаем позицию
      const position: Position = {
        symbol,
        entryPrice,
        investedUsd: actualPositionSize,
        quantity,
        entryTime: Date.now(),
        peakPrice: entryPrice,
        lastPriceUpdate: Date.now(),
        priceHistory: [{ price: entryPrice, timestamp: Date.now() }],
        takeProfitTarget: entryPrice * (1 + TARGET_PROFIT_PCT / 100), // 0.8% целевой профит
        exitTimer: Date.now() + MAX_HOLD_TIME,
        status: 'active',
      };

      this.positions.set(symbol, position);
      this.riskManager.onPositionOpened();

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'buy',
        symbol,
        investedUsd: actualPositionSize,
        entryPrice,
        message: `✅ Position opened: ${symbol} | invested=${actualPositionSize.toFixed(2)} USD, quantity=${quantity.toFixed(8)}, entryPrice=${entryPrice.toFixed(8)}, predictedChange=${signal.predictedChange.toFixed(3)}%, confidence=${signal.confidence.toFixed(3)}`,
      });

      return true;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        symbol,
        message: `❌ Error opening position for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Проверяет все открытые позиции
   */
  private async checkAllPositions(): Promise<void> {
    if (this.positions.size === 0) {
      return;
    }

    const now = Date.now();
    const positionsToClose: Array<{ symbol: string; reason: string }> = [];

    for (const [symbol, position] of this.positions.entries()) {
      if (position.status !== 'active') {
        continue;
      }

      try {
        // Получаем текущую цену
        const ticker = await this.bybitClient.getTicker(symbol);
        if (!ticker || ticker.lastPrice <= 0) {
          continue;
        }

        const currentPrice = ticker.lastPrice;
        const elapsed = now - position.entryTime;
        const currentMultiplier = currentPrice / position.entryPrice;
        const profitPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        const timeHeldSeconds = elapsed / 1000;

        // Обновляем пик
        if (currentPrice > position.peakPrice) {
          position.peakPrice = currentPrice;
        }

        // Обновляем историю цен
        if (!position.priceHistory) {
          position.priceHistory = [];
        }
        position.priceHistory.push({ price: currentPrice, timestamp: now });
        if (position.priceHistory.length > 10) {
          position.priceHistory.shift();
        }

        // Рассчитываем momentum для проверки затухания импульса
        const momentum = this.calculateMomentum(position.priceHistory);

        // ЛОГИКА ВЫХОДА
        let shouldClose = false;
        let closeReason = '';

        // 1. Timeout
        if (elapsed >= MAX_HOLD_TIME) {
          shouldClose = true;
          closeReason = 'timeout';
        }
        // 2. Take Profit (0.8-1.5%)
        else if (profitPct >= TARGET_PROFIT_PCT) {
          shouldClose = true;
          closeReason = 'take_profit';
        }
        // 3. Затухание импульса (velocity <= 0 или отрицательное ускорение)
        else if (momentum.velocity <= 0 || momentum.acceleration < -0.00001) {
          // Выходим только если есть минимальная прибыль
          if (profitPct >= MIN_PROFIT_PCT) {
            shouldClose = true;
            closeReason = 'momentum_fade';
          }
        }
        // 4. Защита: если цена не обновляется X секунд
        else if (now - position.lastPriceUpdate > 10000) { // 10 секунд
          shouldClose = true;
          closeReason = 'price_stale';
        }
        // 5. Stop Loss: если упало больше чем на 0.5% от входа
        else if (profitPct < -0.5) {
          shouldClose = true;
          closeReason = 'stop_loss';
        }

        // Логируем состояние каждые 10 секунд
        if (elapsed % 10000 < CHECK_INTERVAL) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            symbol,
            message: `📊 Position: ${symbol} | price=${currentPrice.toFixed(8)}, profit=${profitPct.toFixed(3)}%, momentum=${momentum.velocity.toFixed(6)}x/sec, timeHeld=${timeHeldSeconds.toFixed(1)}s`,
          });
        }

        if (shouldClose) {
          positionsToClose.push({ symbol, reason: closeReason });
        }
      } catch (error) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          symbol,
          message: `Error checking position ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Закрываем позиции
    for (const { symbol, reason } of positionsToClose) {
      await this.closePosition(symbol, reason);
    }
  }

  /**
   * Рассчитывает momentum на основе истории цен
   */
  private calculateMomentum(priceHistory: Array<{ price: number; timestamp: number }>): { velocity: number; acceleration: number } {
    if (priceHistory.length < 3) {
      return { velocity: 0, acceleration: 0 };
    }

    const recent = priceHistory.slice(-5);
    const basePrice = recent[0].price;
    const timeChange = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000;
    
    if (timeChange <= 0) {
      return { velocity: 0, acceleration: 0 };
    }

    const priceChange = recent[recent.length - 1].price - recent[0].price;
    const velocity = (priceChange / basePrice) / timeChange;

    const midPoint = Math.floor(recent.length / 2);
    const firstHalfVelocity = (recent[midPoint].price - recent[0].price) / basePrice / ((recent[midPoint].timestamp - recent[0].timestamp) / 1000);
    const secondHalfVelocity = (recent[recent.length - 1].price - recent[midPoint].price) / basePrice / ((recent[recent.length - 1].timestamp - recent[midPoint].timestamp) / 1000);
    const timeForAcceleration = (recent[recent.length - 1].timestamp - recent[midPoint].timestamp) / 1000;
    
    const acceleration = timeForAcceleration > 0 
      ? (secondHalfVelocity - firstHalfVelocity) / timeForAcceleration 
      : 0;

    return { velocity, acceleration };
  }

  /**
   * Закрывает позицию
   * ⚠️ ВАЖНО: Полная продажа, НЕТ partial sells
   */
  private async closePosition(symbol: string, reason: string): Promise<void> {
    const position = this.positions.get(symbol);
    if (!position || position.status !== 'active') {
      return;
    }

    position.status = 'closing';

    try {
      // Получаем текущую цену
      const ticker = await this.bybitClient.getTicker(symbol);
      const exitPrice = ticker?.lastPrice || position.entryPrice;

      // ⚠️ ПОЛНАЯ ПРОДАЖА - никаких partial sells
      const sellResult = await this.orderExecutor.executeSell(symbol, position.quantity);

      if (!sellResult.success) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          symbol,
          message: `❌ Failed to sell ${symbol}: ${sellResult.error}`,
        });
        position.status = 'active'; // Возвращаем в active при ошибке
        return;
      }

      // Рассчитываем прибыль
      const proceeds = (sellResult.filled || position.quantity) * (sellResult.averagePrice || exitPrice);
      const profit = proceeds - position.investedUsd;
      const profitPct = (profit / position.investedUsd) * 100;
      const multiplier = (sellResult.averagePrice || exitPrice) / position.entryPrice;
      const timeHeld = (Date.now() - position.entryTime) / 1000;

      // Обновляем баланс
      this.account.release(position.investedUsd, proceeds);
      this.riskManager.updateBalance(this.account.getTotalBalance());
      this.riskManager.onPositionClosed(profit);

      // Удаляем позицию
      this.positions.delete(symbol);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'sell',
        symbol,
        exitPrice: sellResult.averagePrice || exitPrice,
        multiplier,
        profitUsd: profit,
        profitPct,
        reason,
        message: `✅ Position closed: ${symbol} | reason=${reason}, multiplier=${multiplier.toFixed(4)}x, profit=${profit.toFixed(2)} USD (${profitPct.toFixed(3)}%), timeHeld=${timeHeld.toFixed(1)}s`,
      });
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        symbol,
        message: `❌ Error closing position ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      });
      position.status = 'active';
    }
  }

  /**
   * Получает статистику позиций
   */
  getStats(): PositionStats {
    const positions = Array.from(this.positions.values()).map(pos => {
      const age = ((Date.now() - pos.entryTime) / 1000).toFixed(1);
      const multiplier = pos.currentPrice && pos.entryPrice
        ? (pos.currentPrice / pos.entryPrice).toFixed(4)
        : '1.0000';
      return {
        symbol: pos.symbol,
        multiplier,
        age: `${age}s`,
      };
    });

    return {
      activePositions: this.positions.size,
      availableSlots: config.maxOpenPositions - this.positions.size,
      positions,
    };
  }

  /**
   * Получает текущий баланс
   */
  getCurrentDeposit(): number {
    return this.account.getTotalBalance();
  }

  getCurrentDepositSync(): number {
    return this.account.getTotalBalance();
  }

  /**
   * Получает пиковый баланс
   */
  getPeakDeposit(): number {
    return this.account.getPeakBalance();
  }

  /**
   * Проверяет, достаточно ли баланса для торговли
   */
  hasEnoughBalanceForTrading(): boolean {
    return this.account.getFreeBalance() >= config.minPositionSize;
  }

  /**
   * Закрывает все позиции
   */
  async closeAllPositions(): Promise<void> {
    const symbols = Array.from(this.positions.keys());
    for (const symbol of symbols) {
      await this.closePosition(symbol, 'shutdown');
    }
  }

  /**
   * Получает Risk Manager
   */
  getRiskManager(): RiskManager {
    return this.riskManager;
  }
}

