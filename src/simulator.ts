import { Connection } from '@solana/web3.js';
import { config } from './config';
import { Position, Batch, TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, calculateSlippage, calculateExitPrice, calculateProfit, formatUsd } from './utils';
import { TokenFilters } from './filters';

export class TradingSimulator {
  private connection: Connection;
  private filters: TokenFilters;
  private currentDeposit: number;
  private peakDeposit: number;
  private currentBatch: Batch | null = null;
  private batchCounter = 0;
  private openPositions: Map<string, Position> = new Map();
  private isPaused = false;

  constructor(connection: Connection) {
    this.connection = connection;
    this.filters = new TokenFilters(connection);
    this.currentDeposit = config.initialDeposit;
    this.peakDeposit = config.initialDeposit;
  }

  getCurrentDeposit(): number {
    return this.currentDeposit;
  }

  getPeakDeposit(): number {
    return this.peakDeposit;
  }

  getOpenPositionsCount(): number {
    return this.openPositions.size;
  }

  async startNewBatch(): Promise<void> {
    if (this.currentBatch && this.currentBatch.positions.size > 0) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: 'Cannot start new batch: previous batch not completed',
      });
      return;
    }

    if (this.currentDeposit < 0.01) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Deposit too low: ${this.currentDeposit} SOL. Stopping.`,
      });
      return;
    }

    // Проверка drawdown
    const drawdown = ((this.peakDeposit - this.currentDeposit) / this.peakDeposit) * 100;
    if (drawdown > config.maxDrawdownPct) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: `Drawdown ${drawdown.toFixed(2)}% exceeds limit. Pausing for 5 minutes.`,
      });
      this.isPaused = true;
      setTimeout(() => {
        this.isPaused = false;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: 'Resuming after drawdown pause',
        });
      }, 5 * 60 * 1000);
      return;
    }

    this.batchCounter++;
    this.currentBatch = {
      id: this.batchCounter,
      candidates: [],
      positions: new Map(),
      startTime: Date.now(),
      depositBefore: this.currentDeposit,
    };

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'batch_start',
      batchId: this.batchCounter,
      depositBefore: this.currentDeposit,
    });
  }

  async addCandidate(candidate: TokenCandidate): Promise<boolean> {
    if (this.isPaused) {
      return false;
    }

    if (!this.currentBatch) {
      await this.startNewBatch();
      if (!this.currentBatch) {
        return false;
      }
    }

    // Проверяем, не превышен ли лимит открытых позиций
    if (this.openPositions.size >= config.maxOpenPositions) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: `Max open positions (${config.maxOpenPositions}) reached`,
      });
      return false;
    }

    // Проверяем, не заполнен ли батч
    if (this.currentBatch.candidates.length >= config.batchSize) {
      return false;
    }

    // Проверяем, не добавлен ли уже этот токен
    if (this.currentBatch.candidates.some(c => c.mint === candidate.mint)) {
      return false;
    }

    // Применяем фильтры
    const passed = await this.filters.filterCandidate(candidate);
    if (!passed) {
      return false;
    }

    // Добавляем кандидата в батч
    this.currentBatch.candidates.push(candidate);

    // Если батч заполнен, открываем позиции
    if (this.currentBatch.candidates.length === config.batchSize) {
      await this.openBatchPositions();
    }

    return true;
  }

  private async openBatchPositions(): Promise<void> {
    if (!this.currentBatch) return;

    const positionSize = this.currentDeposit / config.batchSize;

    for (const candidate of this.currentBatch.candidates) {
      try {
        await this.openPosition(candidate, positionSize);
      } catch (error) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `Failed to open position for ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  private async openPosition(candidate: TokenCandidate, positionSize: number): Promise<void> {
    if (!this.currentBatch) return;

    try {
      // Получаем цену входа
      const entryPrice = await this.filters.getEntryPrice(candidate.mint);
      if (entryPrice <= 0) {
        throw new Error('Invalid entry price');
      }

      // Рассчитываем инвестиции с учетом комиссий
      const fees = config.priorityFee + config.signatureFee;
      const invested = positionSize - fees;

      if (invested <= 0) {
        throw new Error('Insufficient funds after fees');
      }

      // Рассчитываем slippage
      const slippage = calculateSlippage();
      const actualEntryPrice = entryPrice * (1 + slippage);

      // Создаем позицию
      const position: Position = {
        token: candidate.mint,
        batchId: this.currentBatch.id,
        entryPrice: actualEntryPrice,
        investedSol: invested,
        investedUsd: formatUsd(invested),
        entryTime: Date.now(),
        localHigh: actualEntryPrice,
        takeProfitTarget: actualEntryPrice * config.takeProfitMultiplier,
        stopLossTarget: actualEntryPrice * (1 - config.trailingStopPct / 100),
        exitTimer: Date.now() + config.exitTimerSeconds * 1000,
        slippage: slippage,
      };

      this.currentBatch.positions.set(candidate.mint, position);
      this.openPositions.set(candidate.mint, position);

      // Логируем покупку
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'buy',
        batchId: this.currentBatch.id,
        token: candidate.mint,
        investedSol: invested,
        entryPrice: actualEntryPrice,
      });
    } catch (error) {
      console.error(`Error opening position for ${candidate.mint}:`, error);
      throw error;
    }
  }

  async checkAndClosePositions(): Promise<void> {
    const now = Date.now();
    const positionsToClose: string[] = [];

    for (const [token, position] of this.openPositions.entries()) {
      try {
        // Получаем текущую цену
        const currentPrice = await this.filters.getEntryPrice(token);
        if (currentPrice <= 0) continue;

        // Обновляем локальный максимум
        if (currentPrice > position.localHigh) {
          position.localHigh = currentPrice;
          position.stopLossTarget = position.localHigh * (1 - config.trailingStopPct / 100);
        }

        let shouldClose = false;
        let closeReason = '';

        // Проверка тейк-профита (4x)
        if (currentPrice >= position.takeProfitTarget) {
          shouldClose = true;
          closeReason = 'take_profit';
        }
        // Проверка таймера (90 секунд)
        else if (now >= position.exitTimer) {
          shouldClose = true;
          closeReason = 'timer';
        }
        // Проверка трейлинг-стопа (25% от локального хая)
        else if (currentPrice <= position.stopLossTarget) {
          shouldClose = true;
          closeReason = 'trailing_stop';
        }

        if (shouldClose) {
          positionsToClose.push(token);
          await this.closePosition(token, currentPrice, closeReason);
        }
      } catch (error) {
        console.error(`Error checking position ${token}:`, error);
      }
    }

    // Проверяем, завершен ли батч
    if (this.currentBatch && this.currentBatch.positions.size > 0) {
      const allClosed = Array.from(this.currentBatch.positions.values()).every(
        pos => !this.openPositions.has(pos.token)
      );

      if (allClosed) {
        await this.completeBatch();
      }
    }
  }

  private async closePosition(token: string, exitPrice: number, reason: string): Promise<void> {
    const position = this.openPositions.get(token);
    if (!position) return;

    try {
      // Рассчитываем slippage при выходе
      const exitSlippage = calculateSlippage();
      const actualExitPrice = exitPrice * (1 - exitSlippage);

      // Рассчитываем комиссию при выходе
      const exitFee = config.priorityFee + config.signatureFee;

      // Рассчитываем профит
      const profit = calculateProfit(
        position.investedSol,
        position.entryPrice,
        actualExitPrice,
        exitFee
      );

      const multiplier = actualExitPrice / position.entryPrice;
      const profitPct = ((actualExitPrice - position.entryPrice) / position.entryPrice) * 100;

      // Обновляем депозит
      this.currentDeposit += profit;
      if (this.currentDeposit > this.peakDeposit) {
        this.peakDeposit = this.currentDeposit;
      }

      // Обновляем статистику
      const stats = logger.getDailyStats();
      if (stats) {
        stats.totalTrades++;
        if (multiplier >= 3) {
          stats.hitsAbove3x++;
        }
        stats.totalProfitSol += profit;
        stats.totalProfitUsd = stats.totalProfitSol * config.solUsdRate;
      }

      // Удаляем позицию
      this.openPositions.delete(token);

      // Логируем продажу
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'sell',
        batchId: position.batchId,
        token: token,
        exitPrice: actualExitPrice,
        multiplier: multiplier,
        profitSol: profit,
        profitPct: profitPct,
        reason: reason,
      });
    } catch (error) {
      console.error(`Error closing position ${token}:`, error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error closing position ${token}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async completeBatch(): Promise<void> {
    if (!this.currentBatch) return;

    const batch = this.currentBatch;
    const depositAfter = this.currentDeposit;
    const depositBefore = batch.depositBefore;
    const netProfitPct = ((depositAfter - depositBefore) / depositBefore) * 100;

    // Логируем завершение батча
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'batch_complete',
      batchId: batch.id,
      netProfitPct: netProfitPct,
      depositBefore: depositBefore,
      depositAfter: depositAfter,
    });

    // Обновляем статистику
    const stats = logger.getDailyStats();
    if (stats) {
      stats.totalBatches++;
      if (netProfitPct > 0) {
        stats.winBatches++;
      }
      stats.finalDeposit = depositAfter;
      if (depositAfter > stats.peakDeposit) {
        stats.peakDeposit = depositAfter;
      }
      
      // Пересчитываем средний профит батчей
      if (stats.totalBatches > 0) {
        // Упрощенный расчет: используем текущий финальный депозит
        const totalProfitPct = ((depositAfter - stats.initialDeposit) / stats.initialDeposit) * 100;
        stats.avgBatchProfitPct = totalProfitPct / stats.totalBatches;
      }
      
      const drawdown = ((stats.peakDeposit - depositAfter) / stats.peakDeposit) * 100;
      if (drawdown > stats.maxDrawdownPct) {
        stats.maxDrawdownPct = drawdown;
      }
    }

    // Очищаем текущий батч
    this.currentBatch = null;

    // Начинаем новый батч
    await this.startNewBatch();
  }

  async closeAllPositions(): Promise<void> {
    const tokens = Array.from(this.openPositions.keys());

    for (const token of tokens) {
      try {
        const currentPrice = await this.filters.getEntryPrice(token);
        if (currentPrice > 0) {
          await this.closePosition(token, currentPrice, 'shutdown');
        } else {
          // Если не можем получить цену, закрываем по entry price (убыток)
          const position = this.openPositions.get(token);
          if (position) {
            await this.closePosition(token, position.entryPrice, 'shutdown_no_price');
          }
        }
      } catch (error) {
        console.error(`Error closing position ${token} during shutdown:`, error);
      }
    }

    // Завершаем текущий батч если есть
    if (this.currentBatch && this.currentBatch.positions.size > 0) {
      await this.completeBatch();
    }
  }
}

