/**
 * Gem Simulator - Реалистичный симулятор стратегии выявления самородков
 * 
 * Адаптирован для тестирования гипотезы:
 * 1. Мониторит токены без входа
 * 2. Выявляет самородки на ранней стадии
 * 3. Входит только в подтвержденные самородки
 * 4. Выходит на обратном импульсе
 * 
 * Детальное неблокирующее логирование для анализа закономерностей
 */

import { Connection } from '@solana/web3.js';
import { config } from './config';
import { Position, TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, calculateSlippage, calculateProfit, formatUsd, sleep } from './utils';
import { TokenFilters } from './filters';
import { GemTracker } from './gem-tracker';
import { priceFetcher } from './price-fetcher';

interface GemSimulationStats {
  totalMonitored: number; // Всего токенов под мониторингом
  gemsDetected: number; // Самородков обнаружено
  positionsOpened: number; // Позиций открыто
  positionsClosed: number; // Позиций закрыто
  profitableTrades: number; // Прибыльных сделок
  losingTrades: number; // Убыточных сделок
  totalProfitSol: number; // Общая прибыль в SOL
  avgEntryMultiplier: number; // Средний multiplier при входе
  avgExitMultiplier: number; // Средний multiplier при выходе
  avgHoldTime: number; // Среднее время удержания (сек)
  gemScoreDistribution: Array<{ range: string; count: number }>; // Распределение gem score
  priceMomentumDistribution: Array<{ range: string; count: number }>; // Распределение price momentum
}

export class GemSimulator {
  private connection: Connection;
  private filters: TokenFilters;
  private gemTracker: GemTracker;
  private currentDeposit: number;
  private peakDeposit: number;
  private openPositions: Map<string, Position> = new Map();
  private stats: GemSimulationStats;
  private isRunning = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private positionCheckInterval: NodeJS.Timeout | null = null;

  constructor(connection: Connection) {
    this.connection = connection;
    this.filters = new TokenFilters(connection);
    this.gemTracker = new GemTracker(connection, this.filters);
    this.currentDeposit = config.initialDeposit;
    this.peakDeposit = config.initialDeposit;
    
    this.stats = {
      totalMonitored: 0,
      gemsDetected: 0,
      positionsOpened: 0,
      positionsClosed: 0,
      profitableTrades: 0,
      losingTrades: 0,
      totalProfitSol: 0,
      avgEntryMultiplier: 0,
      avgExitMultiplier: 0,
      avgHoldTime: 0,
      gemScoreDistribution: [
        { range: '0.0-0.2', count: 0 },
        { range: '0.2-0.4', count: 0 },
        { range: '0.4-0.6', count: 0 },
        { range: '0.6-0.8', count: 0 },
        { range: '0.8-1.0', count: 0 },
      ],
      priceMomentumDistribution: [
        { range: '0.00-0.02', count: 0 },
        { range: '0.02-0.05', count: 0 },
        { range: '0.05-0.10', count: 0 },
        { range: '0.10-0.20', count: 0 },
        { range: '0.20+', count: 0 },
      ],
    };

    // Настраиваем callback для обнаружения самородков
    this.gemTracker.setOnGemDetected(async (candidate, observation) => {
      await this.handleGemDetected(candidate, observation);
    });
  }

  /**
   * Начинает симуляцию
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🚀 GEM SIMULATOR: Starting simulation with initial deposit: ${this.currentDeposit.toFixed(6)} SOL`,
    });

    // Периодическая проверка позиций (каждые 2 секунды)
    this.positionCheckInterval = setInterval(() => {
      this.checkPositions().catch(error => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `Error checking positions: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }, 2000);

    // Периодическая статистика (каждые 60 секунд)
    setInterval(() => {
      this.logStats();
    }, 60000);
  }

  /**
   * Останавливает симуляцию
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    if (this.positionCheckInterval) {
      clearInterval(this.positionCheckInterval);
      this.positionCheckInterval = null;
    }

    // Закрываем все открытые позиции
    await this.closeAllPositions();

    // Финальная статистика
    this.logFinalStats();
  }

  /**
   * Добавляет токен для мониторинга (после honeypot check)
   */
  async addTokenForMonitoring(candidate: TokenCandidate): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Быстрая проверка honeypot
    const honeypotCheck = await this.filters.simplifiedFilter(candidate);
    
    if (!honeypotCheck.passed) {
      // Логируем отклонение (неблокирующее)
      setImmediate(() => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `❌ GEM SIM: Token rejected (honeypot): ${candidate.mint.substring(0, 8)}... | reason=${honeypotCheck.reason || 'unknown'}`,
        });
      });
      return;
    }

    // Начинаем мониторинг
    this.stats.totalMonitored++;
    
    setImmediate(() => {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🔍 GEM SIM: Starting monitoring ${candidate.mint.substring(0, 8)}... | totalMonitored=${this.stats.totalMonitored}`,
      });
    });

    // Запускаем мониторинг в фоне (не блокируем)
    this.gemTracker.startMonitoring(candidate).catch(error => {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        message: `❌ GEM SIM: Error monitoring ${candidate.mint.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  }

  /**
   * Обрабатывает обнаруженный самородок
   */
  private async handleGemDetected(candidate: TokenCandidate, observation: any): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Проверяем, не открыта ли уже позиция
    if (this.openPositions.has(candidate.mint)) {
      return;
    }

    // Проверяем лимит открытых позиций
    if (this.openPositions.size >= config.maxOpenPositions) {
      setImmediate(() => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: candidate.mint,
          message: `⚠️ GEM SIM: Max positions reached, skipping gem ${candidate.mint.substring(0, 8)}... | openPositions=${this.openPositions.size}`,
        });
      });
      return;
    }

    this.stats.gemsDetected++;

    // Детальное логирование обнаружения самородка (неблокирующее)
    setImmediate(() => {
      const entryMultiplier = observation.currentPrice / observation.initialPrice;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `💎 GEM DETECTED: ${candidate.mint.substring(0, 8)}... | entryMultiplier=${entryMultiplier.toFixed(3)}x, gemScore=${observation.gemScore.toFixed(3)}, priceMomentum=${observation.priceMomentum.toFixed(4)}x/sec, volumeGrowth=${(observation.volumeGrowth * 100).toFixed(1)}%, holderGrowth=${(observation.holderGrowth * 100).toFixed(1)}%, marketCapGrowth=${(observation.marketCapGrowth * 100).toFixed(1)}%, timeElapsed=${((Date.now() - observation.detectedAt) / 1000).toFixed(1)}s`,
      });

      // Обновляем распределения
      this.updateDistributions(observation);
    });

    // Открываем позицию
    await this.openPosition(candidate, observation);
  }

  /**
   * Открывает позицию для самородка
   */
  private async openPosition(candidate: TokenCandidate, observation: any): Promise<void> {
    try {
      const entryStartTime = Date.now();
      
      // Получаем текущую цену (реалистичная задержка)
      const entryPrice = await priceFetcher.getPrice(candidate.mint);
      if (entryPrice <= 0) {
        setImmediate(() => {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: candidate.mint,
            message: `❌ GEM SIM: Invalid entry price for ${candidate.mint.substring(0, 8)}..., skipping`,
          });
        });
        return;
      }

      // Рассчитываем размер позиции
      const positionSize = this.currentDeposit / Math.max(1, config.maxOpenPositions - this.openPositions.size);
      const fees = config.priorityFee + config.signatureFee;
      const invested = positionSize - fees;

      if (invested <= 0) {
        setImmediate(() => {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: candidate.mint,
            message: `❌ GEM SIM: Insufficient funds for ${candidate.mint.substring(0, 8)}..., invested=${invested}`,
          });
        });
        return;
      }

      // Реалистичный slippage при входе
      const entrySlippage = calculateSlippage();
      const actualEntryPrice = entryPrice * (1 + entrySlippage);
      const entryMultiplier = actualEntryPrice / observation.initialPrice;

      // Создаем позицию
      const position: Position = {
        token: candidate.mint,
        entryPrice: actualEntryPrice,
        investedSol: invested,
        entryTime: Date.now(),
        lastRealPriceUpdate: Date.now(),
        peakPrice: actualEntryPrice,
        localHigh: actualEntryPrice,
        status: 'active',
        priceHistory: [{ price: actualEntryPrice, timestamp: Date.now() }],
      };

      this.openPositions.set(candidate.mint, position);
      this.stats.positionsOpened++;

      const entryDuration = Date.now() - entryStartTime;

      // Детальное логирование открытия позиции (неблокирующее)
      setImmediate(() => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'buy',
          token: candidate.mint,
          investedSol: invested,
          entryPrice: actualEntryPrice,
          message: `✅ GEM SIM: Position opened ${candidate.mint.substring(0, 8)}... | entryMultiplier=${entryMultiplier.toFixed(3)}x, invested=${invested.toFixed(6)} SOL, entryPrice=${actualEntryPrice.toFixed(10)} SOL, entrySlippage=${(entrySlippage * 100).toFixed(2)}%, gemScore=${observation.gemScore.toFixed(3)}, priceMomentum=${observation.priceMomentum.toFixed(4)}x/sec, duration=${entryDuration}ms`,
        });
      });

      // Обновляем средний multiplier при входе
      this.stats.avgEntryMultiplier = (this.stats.avgEntryMultiplier * (this.stats.positionsOpened - 1) + entryMultiplier) / this.stats.positionsOpened;
    } catch (error) {
      setImmediate(() => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: candidate.mint,
          message: `❌ GEM SIM: Error opening position for ${candidate.mint.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
  }

  /**
   * Проверяет открытые позиции и закрывает при необходимости
   */
  private async checkPositions(): Promise<void> {
    if (this.openPositions.size === 0) {
      return;
    }

    const now = Date.now();
    const positionsToClose: Array<{ token: string; reason: string; exitPrice: number }> = [];

    for (const [token, position] of this.openPositions.entries()) {
      try {
        // Получаем текущую цену (реалистичная задержка)
        const currentPrice = await priceFetcher.getPrice(token);
        if (currentPrice <= 0) {
          continue;
        }

        const elapsed = now - position.entryTime;
        const currentMultiplier = currentPrice / position.entryPrice;
        const timeHeldSeconds = elapsed / 1000;

        // Обновляем пик
        if (currentPrice > position.peakPrice) {
          position.peakPrice = currentPrice;
        }

        const peakMultiplier = position.peakPrice / position.entryPrice;
        const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice;

        // Обновляем историю цен для расчета импульса
        if (!position.priceHistory) {
          position.priceHistory = [];
        }
        position.priceHistory.push({ price: currentPrice, timestamp: now });
        if (position.priceHistory.length > 10) {
          position.priceHistory.shift();
        }

        // Рассчитываем price momentum (обратный импульс)
        let priceMomentum = 0;
        if (position.priceHistory.length >= 3) {
          const recentPrices = position.priceHistory.slice(-3);
          const priceChange = recentPrices[recentPrices.length - 1].price - recentPrices[0].price;
          const timeChange = (recentPrices[recentPrices.length - 1].timestamp - recentPrices[0].timestamp) / 1000;
          if (timeChange > 0) {
            priceMomentum = priceChange / position.entryPrice / timeChange; // x/сек
          }
        }

        // ЛОГИКА ВЫХОДА НА ОБРАТНОМ ИМПУЛЬСЕ
        let shouldClose = false;
        let closeReason = '';

        // 1. Timeout (45 секунд)
        if (elapsed >= 45_000) {
          shouldClose = true;
          closeReason = 'timeout';
        }
        // 2. Обратный импульс: price momentum < 0.02x/сек (замедление роста)
        else if (priceMomentum < 0.02 && currentMultiplier >= 2.0) {
          shouldClose = true;
          closeReason = 'momentum_reversal';
        }
        // 3. Падение от пика на 15-20%
        else if (dropFromPeak >= 0.15 && currentMultiplier >= 2.0) {
          shouldClose = true;
          closeReason = 'peak_drop';
        }
        // 4. Минимальная прибыль достигнута и импульс замедляется
        else if (currentMultiplier >= 2.5 && priceMomentum < 0.05) {
          shouldClose = true;
          closeReason = 'min_profit_momentum';
        }

        // Детальное логирование состояния позиции (неблокирующее, каждые 5 секунд)
        if (elapsed % 5000 < 2000) {
          setImmediate(() => {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: token,
              message: `📊 GEM SIM: Position status ${token.substring(0, 8)}... | multiplier=${currentMultiplier.toFixed(3)}x, peak=${peakMultiplier.toFixed(3)}x, dropFromPeak=${(dropFromPeak * 100).toFixed(1)}%, priceMomentum=${priceMomentum.toFixed(4)}x/sec, timeHeld=${timeHeldSeconds.toFixed(1)}s`,
            });
          });
        }

        if (shouldClose) {
          positionsToClose.push({ token, reason: closeReason, exitPrice: currentPrice });
        }
      } catch (error) {
        setImmediate(() => {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: token,
            message: `❌ GEM SIM: Error checking position ${token.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }
    }

    // Закрываем позиции
    for (const { token, reason, exitPrice } of positionsToClose) {
      await this.closePosition(token, exitPrice, reason);
    }
  }

  /**
   * Закрывает позицию
   */
  private async closePosition(token: string, exitPrice: number, reason: string): Promise<void> {
    const position = this.openPositions.get(token);
    if (!position) {
      return;
    }

    try {
      // Реалистичный slippage при выходе
      const exitSlippage = calculateSlippage();
      const actualExitPrice = exitPrice * (1 - exitSlippage);
      const exitFee = config.priorityFee + config.signatureFee;

      // Рассчитываем прибыль
      const profit = calculateProfit(
        position.investedSol,
        position.entryPrice,
        actualExitPrice,
        exitFee
      );

      const multiplier = actualExitPrice / position.entryPrice;
      const profitPct = ((actualExitPrice - position.entryPrice) / position.entryPrice) * 100;
      const timeHeld = (Date.now() - position.entryTime) / 1000;
      const entryMultiplier = position.entryPrice / (position.priceHistory?.[0]?.price || position.entryPrice);

      // Обновляем депозит
      const depositBefore = this.currentDeposit;
      this.currentDeposit += profit;
      if (this.currentDeposit > this.peakDeposit) {
        this.peakDeposit = this.currentDeposit;
      }

      // Обновляем статистику
      this.stats.positionsClosed++;
      this.stats.totalProfitSol += profit;
      this.stats.avgExitMultiplier = (this.stats.avgExitMultiplier * (this.stats.positionsClosed - 1) + multiplier) / this.stats.positionsClosed;
      this.stats.avgHoldTime = (this.stats.avgHoldTime * (this.stats.positionsClosed - 1) + timeHeld) / this.stats.positionsClosed;

      if (profit > 0) {
        this.stats.profitableTrades++;
      } else {
        this.stats.losingTrades++;
      }

      // Удаляем позицию
      this.openPositions.delete(token);

      // Детальное логирование закрытия позиции (неблокирующее)
      setImmediate(() => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'sell',
          token: token,
          exitPrice: actualExitPrice,
          multiplier: multiplier,
          profitSol: profit,
          profitPct: profitPct,
          reason: reason,
          message: `✅ GEM SIM: Position closed ${token.substring(0, 8)}... | reason=${reason}, entryMultiplier=${entryMultiplier.toFixed(3)}x, exitMultiplier=${multiplier.toFixed(3)}x, profit=${profit.toFixed(6)} SOL (${profitPct.toFixed(2)}%), exitSlippage=${(exitSlippage * 100).toFixed(2)}%, timeHeld=${timeHeld.toFixed(1)}s, deposit=${depositBefore.toFixed(6)} → ${this.currentDeposit.toFixed(6)} SOL`,
        });
      });
    } catch (error) {
      setImmediate(() => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: token,
          message: `❌ GEM SIM: Error closing position ${token.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
  }

  /**
   * Обновляет распределения индикаторов
   */
  private updateDistributions(observation: any): void {
    // Gem Score distribution
    const gemScore = observation.gemScore;
    if (gemScore < 0.2) {
      this.stats.gemScoreDistribution[0].count++;
    } else if (gemScore < 0.4) {
      this.stats.gemScoreDistribution[1].count++;
    } else if (gemScore < 0.6) {
      this.stats.gemScoreDistribution[2].count++;
    } else if (gemScore < 0.8) {
      this.stats.gemScoreDistribution[3].count++;
    } else {
      this.stats.gemScoreDistribution[4].count++;
    }

    // Price Momentum distribution
    const priceMomentum = observation.priceMomentum;
    if (priceMomentum < 0.02) {
      this.stats.priceMomentumDistribution[0].count++;
    } else if (priceMomentum < 0.05) {
      this.stats.priceMomentumDistribution[1].count++;
    } else if (priceMomentum < 0.10) {
      this.stats.priceMomentumDistribution[2].count++;
    } else if (priceMomentum < 0.20) {
      this.stats.priceMomentumDistribution[3].count++;
    } else {
      this.stats.priceMomentumDistribution[4].count++;
    }
  }

  /**
   * Логирует периодическую статистику
   */
  private logStats(): void {
    const winRate = this.stats.positionsClosed > 0 
      ? (this.stats.profitableTrades / this.stats.positionsClosed * 100).toFixed(1)
      : '0.0';

    setImmediate(() => {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `📊 GEM SIM STATS: monitored=${this.stats.totalMonitored}, gems=${this.stats.gemsDetected}, opened=${this.stats.positionsOpened}, closed=${this.stats.positionsClosed}, profitable=${this.stats.profitableTrades}, losing=${this.stats.losingTrades}, winRate=${winRate}%, avgEntryMultiplier=${this.stats.avgEntryMultiplier.toFixed(3)}x, avgExitMultiplier=${this.stats.avgExitMultiplier.toFixed(3)}x, avgHoldTime=${this.stats.avgHoldTime.toFixed(1)}s, totalProfit=${this.stats.totalProfitSol.toFixed(6)} SOL, deposit=${this.currentDeposit.toFixed(6)} SOL`,
      });
    });
  }

  /**
   * Логирует финальную статистику
   */
  private logFinalStats(): void {
    const winRate = this.stats.positionsClosed > 0 
      ? (this.stats.profitableTrades / this.stats.positionsClosed * 100).toFixed(1)
      : '0.0';

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `📊 GEM SIM FINAL STATS:`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Total Monitored: ${this.stats.totalMonitored}`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Gems Detected: ${this.stats.gemsDetected} (${(this.stats.gemsDetected / Math.max(1, this.stats.totalMonitored) * 100).toFixed(1)}%)`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Positions Opened: ${this.stats.positionsOpened}`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Positions Closed: ${this.stats.positionsClosed}`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Profitable: ${this.stats.profitableTrades}, Losing: ${this.stats.losingTrades}, Win Rate: ${winRate}%`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Avg Entry Multiplier: ${this.stats.avgEntryMultiplier.toFixed(3)}x`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Avg Exit Multiplier: ${this.stats.avgExitMultiplier.toFixed(3)}x`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Avg Hold Time: ${this.stats.avgHoldTime.toFixed(1)}s`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Total Profit: ${this.stats.totalProfitSol.toFixed(6)} SOL`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Final Deposit: ${this.currentDeposit.toFixed(6)} SOL (${((this.currentDeposit - config.initialDeposit) / config.initialDeposit * 100).toFixed(2)}%)`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Gem Score Distribution: ${this.stats.gemScoreDistribution.map(d => `${d.range}=${d.count}`).join(', ')}`,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `  Price Momentum Distribution: ${this.stats.priceMomentumDistribution.map(d => `${d.range}=${d.count}`).join(', ')}`,
    });
  }

  /**
   * Закрывает все открытые позиции
   */
  private async closeAllPositions(): Promise<void> {
    const tokens = Array.from(this.openPositions.keys());

    for (const token of tokens) {
      try {
        const currentPrice = await priceFetcher.getPrice(token);
        if (currentPrice > 0) {
          await this.closePosition(token, currentPrice, 'shutdown');
        } else {
          const position = this.openPositions.get(token);
          if (position) {
            await this.closePosition(token, position.entryPrice, 'shutdown_no_price');
          }
        }
      } catch (error) {
        // Игнорируем ошибки при закрытии
      }
    }
  }

  getCurrentDeposit(): number {
    return this.currentDeposit;
  }

  getPeakDeposit(): number {
    return this.peakDeposit;
  }

  getStats(): GemSimulationStats {
    return { ...this.stats };
  }
}

