import { Connection } from '@solana/web3.js';
import { Position, PositionStats, TokenCandidate, ClassifiedToken, StrategyContext } from './types';
import { Strategy } from './strategies/strategy.interface';
import { config } from './config';
import { logger } from './logger';
import { tradeLogger } from './trade-logger';
import { getCurrentTimestamp, sleep } from './utils';
import { priceFetcher } from './price-fetcher';
import { checkTokenReadiness } from './readiness-checker';
import { ITradingAdapter } from './trading/trading-adapter.interface';

/**
 * PositionManager — ОРКЕСТРАТОР
 * 
 * Задачи:
 * - Управление слотами (maxOpenPositions)
 * - Управление балансом
 * - Проверка readiness
 * - Запуск monitor loop
 * - Делегирование торговых решений стратегиям
 * 
 * НЕ делает:
 * - Принятие торговых решений (это делают стратегии)
 * - Фильтрацию (это делает AntiHoneypotFilter)
 * - Классификацию (это делает TokenClassifier)
 */
export class PositionManagerNew {
  private connection: Connection;
  private adapter: ITradingAdapter;
  private positions: Map<string, Position> = new Map();
  private account: Account;
  private monitoringTokens = new Set<string>();

  constructor(connection: Connection, initialDeposit: number, adapter: ITradingAdapter) {
    this.connection = connection;
    this.adapter = adapter;
    this.account = new Account(initialDeposit);
  }

  /**
   * ====================================
   * ГЛАВНЫЙ МЕТОД: tryOpenPosition
   * ====================================
   * 
   * Гейты открытия (строго по порядку):
   * 1. free slots
   * 2. free balance
   * 3. shouldEnter (стратегия)
   * 4. readiness
   * 5. buy success
   */
  async tryOpenPosition(
    candidate: TokenCandidate, 
    classified: ClassifiedToken, 
    strategy: Strategy
  ): Promise<void> {
    const mint = candidate.mint;

    try {
      // GATE 1: Free slots
      if (this.positions.size >= config.maxOpenPositions) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `❌ OPEN_SKIPPED: no free slots (${this.positions.size}/${config.maxOpenPositions})`,
        });
        return;
      }

      // GATE 2: Free balance
      const freeBalance = this.account.getFreeBalance();
      if (freeBalance < 0.005) { // минимальный резерв
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `❌ OPEN_SKIPPED: insufficient balance (${freeBalance.toFixed(6)} SOL)`,
        });
        return;
      }

      // Создаём контекст для стратегии
      const ctx: StrategyContext = {
        token: mint,
        metrics: classified.metrics,
        timestamp: Date.now(),
      };

      // GATE 3: shouldEnter (стратегия)
      const enterDecision = strategy.shouldEnter(ctx);
      if (!enterDecision.enter) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `❌ OPEN_SKIPPED: strategy rejected: ${enterDecision.reason}`,
        });
        return;
      }

      // GATE 4: Readiness
      const readinessResult = await checkTokenReadiness(mint);
      if (!readinessResult.ready) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `❌ OPEN_SKIPPED: not ready: ${readinessResult.reason}`,
        });
        return;
      }

      // Вычисляем параметры входа через стратегию
      const entryParams = strategy.entryParams(ctx, freeBalance);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `🎯 OPEN_ATTEMPT: ${strategy.type} | positionSize=${entryParams.positionSize.toFixed(6)} SOL, stopLoss=${entryParams.stopLossPct}%, timeout=${entryParams.timeoutSeconds}s`,
      });

      // Резервируем баланс
      const reserved = this.account.reserve(entryParams.positionSize);
      if (!reserved) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: mint,
          message: `❌ OPEN_FAIL: failed to reserve balance`,
        });
        return;
      }

      // GATE 5: Buy
      const buyResult = await this.adapter.buy(
        mint,
        entryParams.positionSize,
        0.20, // slippage
      );

      if (!buyResult.success) {
        // Освобождаем резерв
        this.account.release(entryParams.positionSize, 0);
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: mint,
          message: `❌ OPEN_FAIL: buy failed: ${buyResult.error}`,
        });
        return;
      }

      // Создаём позицию
      const now = Date.now();
      const position: Position = {
        token: mint,
        tokenType: classified.type,
        strategyId: strategy.type,
        entryPrice: buyResult.entryPrice || 0,
        executionPrice: buyResult.executionPrice,
        investedSol: buyResult.investedSol || entryParams.positionSize,
        reservedAmount: entryParams.positionSize,
        entryTime: now,
        peakPrice: buyResult.entryPrice || 0,
        lastRealPriceUpdate: now,
        status: 'active',
        stopLossTarget: entryParams.stopLossPct ? (buyResult.entryPrice || 0) * (1 - entryParams.stopLossPct / 100) : undefined,
        takeProfitTarget: entryParams.takeProfitMultiplier ? (buyResult.entryPrice || 0) * entryParams.takeProfitMultiplier : undefined,
        exitTimer: entryParams.timeoutSeconds ? now + entryParams.timeoutSeconds * 1000 : undefined,
        priceHistory: [],
      };

      this.positions.set(mint, position);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'buy',
        token: mint,
        investedSol: position.investedSol,
        entryPrice: position.entryPrice,
        message: `✅ OPEN_SUCCESS: ${strategy.type} | invested=${position.investedSol.toFixed(6)} SOL, price=${position.entryPrice.toFixed(10)}`,
      });

      tradeLogger.logBuy({
        token: mint,
        investedSol: position.investedSol,
        entryPrice: position.entryPrice,
        signature: buyResult.signature || '',
      });

      // Запускаем мониторинг
      this.startMonitoring(position, strategy);

    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ OPEN_FAIL: error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Запуск мониторинга позиции
   */
  private startMonitoring(position: Position, strategy: Strategy): void {
    if (this.monitoringTokens.has(position.token)) {
      return;
    }

    this.monitoringTokens.add(position.token);

    const monitorLoop = async () => {
      while (true) {
        if (position.status !== 'active') {
          break;
        }

        try {
          // Получаем текущую цену
          const currentPrice = await priceFetcher.getPrice(position.token);
          
          if (currentPrice > 0) {
            position.lastRealPriceUpdate = Date.now();
          }

          // Создаём актуальный контекст
          const ctx: StrategyContext = {
            token: position.token,
            metrics: {} as any, // метрики уже не нужны для мониторинга
            position,
            currentPrice,
            timestamp: Date.now(),
          };

          // Вызываем стратегию для принятия решения
          const decision = strategy.monitorTick(position, ctx);

          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: position.token,
            message: `📊 MONITOR_TICK: ${strategy.type} | price=${currentPrice.toFixed(10)}, multiplier=${(currentPrice / position.entryPrice).toFixed(2)}x | action=${decision.action}, reason=${decision.reason}`,
          });

          if (decision.action === 'exit') {
            // Закрываем позицию
            await this.closePosition(position, strategy, decision.reason || 'strategy exit');
            break;
          }

        } catch (error) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: position.token,
            message: `Error in monitor loop: ${error instanceof Error ? error.message : String(error)}`,
          });
        }

        await sleep(1000); // проверка каждую секунду
      }

      this.monitoringTokens.delete(position.token);
    };

    // Запускаем мониторинг в фоне
    monitorLoop().catch((error) => {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: position.token,
        message: `Monitor loop crashed: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.monitoringTokens.delete(position.token);
    });
  }

  /**
   * Закрытие позиции
   */
  private async closePosition(position: Position, strategy: Strategy, reason: string): Promise<void> {
    if (position.status !== 'active') {
      return;
    }

    position.status = 'closing';

    try {
      // Создаём план выхода через стратегию
      const ctx: StrategyContext = {
        token: position.token,
        metrics: {} as any,
        position,
        timestamp: Date.now(),
      };

      const exitPlan = strategy.exitPlan(position, ctx, reason);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: position.token,
        message: `🚪 EXIT_DECISION: ${exitPlan.exitType} | reason=${reason}, jitoTip=${exitPlan.jitoTip}, slippage=${exitPlan.slippage}, urgent=${exitPlan.urgent}`,
      });

      // Продаём
      const sellResult = await this.adapter.sell(
        position.token,
        exitPlan.slippage || 0.25,
        exitPlan.jitoTip,
      );

      if (sellResult.success) {
        const proceeds = sellResult.receivedSol || 0;
        const multiplier = sellResult.exitPrice && position.entryPrice > 0 
          ? sellResult.exitPrice / position.entryPrice 
          : 0;

        // Освобождаем резерв и добавляем proceeds
        this.account.release(position.reservedAmount || 0, proceeds);

        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'sell',
          token: position.token,
          exitPrice: sellResult.exitPrice,
          multiplier,
          profitSol: proceeds - position.investedSol,
          message: `✅ SELL_SUCCESS: ${strategy.type} | proceeds=${proceeds.toFixed(6)} SOL, multiplier=${multiplier.toFixed(2)}x, profit=${(proceeds - position.investedSol).toFixed(6)} SOL`,
        });

        tradeLogger.logSell({
          token: position.token,
          exitPrice: sellResult.exitPrice || 0,
          receivedSol: proceeds,
          profitSol: proceeds - position.investedSol,
          signature: sellResult.signature || '',
        });

        position.status = 'closed';
      } else {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: position.token,
          message: `❌ SELL_FAIL: ${sellResult.error}`,
        });

        // В случае ошибки продажи - помечаем как abandoned
        position.status = 'abandoned';
        this.account.commitLoss(position.reservedAmount || 0, position.investedSol);
      }

      this.positions.delete(position.token);

    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: position.token,
        message: `Error closing position: ${error instanceof Error ? error.message : String(error)}`,
      });
      
      position.status = 'abandoned';
      this.account.commitLoss(position.reservedAmount || 0, position.investedSol);
      this.positions.delete(position.token);
    }
  }

  /**
   * Получить статистику
   */
  getStats(): PositionStats {
    const positions = Array.from(this.positions.values())
      .filter(p => p.status === 'active')
      .map(p => ({
        token: p.token.substring(0, 8) + '...',
        multiplier: p.entryPrice > 0 && p.currentPrice
          ? `${(p.currentPrice / p.entryPrice).toFixed(2)}x`
          : 'N/A',
        age: `${Math.floor((Date.now() - p.entryTime) / 1000)}s`,
      }));

    return {
      activePositions: this.positions.size,
      availableSlots: config.maxOpenPositions - this.positions.size,
      positions,
    };
  }

  hasEnoughBalanceForTrading(): boolean {
    return this.account.getFreeBalance() >= 0.005;
  }

  getCurrentDepositSync(): number {
    return this.account.getTotalBalance();
  }

  async getCurrentDeposit(): Promise<number> {
    return this.account.getTotalBalance();
  }

  getPeakDeposit(): number {
    return this.account.getPeakBalance();
  }

  async closeAllPositions(): Promise<void> {
    // Закрываем все позиции
    for (const position of this.positions.values()) {
      if (position.status === 'active') {
        // Используем дефолтную стратегию для закрытия
        const { StrategyRouter } = await import('./strategy-router');
        const router = new StrategyRouter();
        const strategy = router.getStrategyByType(position.tokenType);
        
        if (strategy) {
          await this.closePosition(position, strategy, 'shutdown');
        }
      }
    }
  }
}

/**
 * Account — управление балансом
 */
class Account {
  private totalBalance: number;
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

  getLockedBalance(): number {
    return this.lockedBalance;
  }

  getPeakBalance(): number {
    return this.peakBalance;
  }

  reserve(amount: number): boolean {
    if (this.getFreeBalance() < amount || amount <= 0) {
      return false;
    }
    this.lockedBalance += amount;
    return true;
  }

  release(reservedAmount: number, proceeds: number): void {
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

  commitLoss(reservedAmount: number, lossAmount: number): void {
    this.lockedBalance -= reservedAmount;
    this.totalBalance -= lossAmount;

    if (this.lockedBalance < 0) {
      this.lockedBalance = 0;
    }
    if (this.totalBalance < 0) {
      this.totalBalance = 0;
    }
  }
}

