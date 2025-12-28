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
  public scanner: any = null; // Ссылка на scanner для удаления из processingTokens (public для доступа из index.ts)

  constructor(connection: Connection) {
    this.connection = connection;
    this.filters = new TokenFilters(connection);
    this.currentDeposit = config.initialDeposit;
    this.peakDeposit = config.initialDeposit;
  }

  async restoreDeposit(): Promise<void> {
    try {
      const savedStats = await logger.loadStatsFromFile();
      if (savedStats && savedStats.finalDeposit > 0) {
        const oldDeposit = this.currentDeposit;
        this.currentDeposit = savedStats.finalDeposit;
        this.peakDeposit = savedStats.peakDeposit || savedStats.finalDeposit;
        
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `Restored deposit from saved stats: ${oldDeposit.toFixed(6)} → ${this.currentDeposit.toFixed(6)} SOL, Peak: ${this.peakDeposit.toFixed(6)} SOL`,
        });
        
        console.log(`✅ Restored deposit: ${this.currentDeposit.toFixed(6)} SOL (was ${oldDeposit.toFixed(6)} SOL)`);
        console.log(`✅ Restored peak: ${this.peakDeposit.toFixed(6)} SOL`);
      } else {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `No saved stats found, using initial deposit: ${this.currentDeposit.toFixed(6)} SOL`,
        });
        console.log(`ℹ️  No saved stats found, using initial deposit: ${this.currentDeposit.toFixed(6)} SOL`);
      }
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to restore deposit: ${error instanceof Error ? error.message : String(error)}`,
      });
      console.error('Failed to restore deposit, using initial deposit:', error);
    }
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
        message: `Cannot start new batch: previous batch #${this.currentBatch.id} not completed, ${this.currentBatch.positions.size} positions still open`,
      });
      return;
    }

    if (this.currentDeposit < 0.01) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Deposit too low: ${this.currentDeposit.toFixed(6)} SOL. Stopping.`,
      });
      return;
    }

    // Проверка drawdown
    const drawdown = ((this.peakDeposit - this.currentDeposit) / this.peakDeposit) * 100;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `Drawdown check: current=${this.currentDeposit.toFixed(6)} SOL, peak=${this.peakDeposit.toFixed(6)} SOL, drawdown=${drawdown.toFixed(2)}%`,
    });

    if (drawdown > config.maxDrawdownPct) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: `Drawdown ${drawdown.toFixed(2)}% exceeds limit ${config.maxDrawdownPct}%. Pausing for 5 minutes.`,
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
      message: `Starting new batch #${this.batchCounter}, deposit: ${this.currentDeposit.toFixed(6)} SOL, open positions: ${this.openPositions.size}`,
    });
  }

  async addCandidate(candidate: TokenCandidate): Promise<boolean> {
    if (this.isPaused) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `Bot is paused, rejecting candidate: ${candidate.mint.substring(0, 8)}...`,
      });
      return false;
    }

    if (!this.currentBatch) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `No current batch, starting new one for candidate: ${candidate.mint.substring(0, 8)}...`,
      });
      await this.startNewBatch();
      if (!this.currentBatch) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: candidate.mint,
          message: `Failed to start new batch, rejecting candidate: ${candidate.mint.substring(0, 8)}...`,
        });
        return false;
      }
    }

    // Проверяем, не превышен ли лимит открытых позиций
    if (this.openPositions.size >= config.maxOpenPositions) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        token: candidate.mint,
        message: `Max open positions (${config.maxOpenPositions}) reached, current: ${this.openPositions.size}, rejecting: ${candidate.mint.substring(0, 8)}...`,
      });
      return false;
    }

    // Проверяем, не заполнен ли батч (ПЕРЕД применением фильтров, чтобы не тратить время)
    if (this.currentBatch.candidates.length >= config.batchSize) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Batch #${this.currentBatch.id} is full (${this.currentBatch.candidates.length}/${config.batchSize}), rejecting: ${candidate.mint.substring(0, 8)}...`,
      });
      // Убираем из отслеживания если батч заполнен
      if (this.scanner && this.scanner.removeFromProcessing) {
        this.scanner.removeFromProcessing(candidate.mint);
      }
      return false;
    }

    // Проверяем, не добавлен ли уже этот токен в батч
    if (this.currentBatch.candidates.some(c => c.mint === candidate.mint)) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Token already in batch #${this.currentBatch.id}, rejecting duplicate: ${candidate.mint.substring(0, 8)}...`,
      });
      return false;
    }

    // Проверяем, не открыта ли уже позиция по этому токену
    if (this.openPositions.has(candidate.mint)) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Position already open for token, rejecting duplicate: ${candidate.mint.substring(0, 8)}...`,
      });
      return false;
    }

    // Фильтр: исключаем SOL токен (So11111111111111111111111111111111111111112)
    // Это не pump.fun токен, его нельзя торговать через pump.fun
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (candidate.mint === SOL_MINT) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'token_rejected',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Token rejected: SOL token (${candidate.mint.substring(0, 8)}...) is not a pump.fun token`,
      });
      // Убираем из отслеживания в scanner
      if (this.scanner && this.scanner.removeFromProcessing) {
        this.scanner.removeFromProcessing(candidate.mint);
      }
      return false;
    }

    // ✅ ЕДИНАЯ ОЧЕРЕДЬ: Все токены обрабатываются одинаково
    // Фильтрация определяется readiness check и ступенчатой фильтрацией в position-manager
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: candidate.mint,
      batchId: this.currentBatch.id,
      message: `Candidate received for batch #${this.currentBatch.id}: ${candidate.mint.substring(0, 8)}..., starting filters...`,
    });

    // Применяем единую фильтрацию (используем filterQueue2Candidate как базовую)
    // В реальной торговле фильтрация выполняется в position-manager с readiness check
    const passed = await this.filters.filterQueue2Candidate(candidate);
    if (!passed) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'token_rejected',
        token: candidate.mint,
        batchId: this.currentBatch?.id,
        message: `Token rejected by filters: ${candidate.mint.substring(0, 8)}...`,
      });
      // Токен не прошел фильтры - убираем из отслеживания в scanner
      if (this.scanner && this.scanner.removeFromProcessing) {
        this.scanner.removeFromProcessing(candidate.mint);
      }
      return false;
    }

    // Добавляем кандидата в батч
    this.currentBatch.candidates.push(candidate);
    
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'token_added',
      token: candidate.mint,
      batchId: this.currentBatch.id,
      message: `Token added to batch #${this.currentBatch.id}: ${candidate.mint.substring(0, 8)}... (${this.currentBatch.candidates.length}/${config.batchSize})`,
    });

    // Если батч заполнен, открываем позиции
    if (this.currentBatch.candidates.length === config.batchSize) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        batchId: this.currentBatch.id,
        message: `Batch #${this.currentBatch.id} is full (${config.batchSize} candidates), opening positions...`,
      });
      await this.openBatchPositions();
    }

    return true;
  }

  private async openBatchPositions(): Promise<void> {
    if (!this.currentBatch) return;

    const openStartTime = Date.now();
    const positionSize = this.currentDeposit / config.batchSize;

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      batchId: this.currentBatch.id,
      message: `Opening positions for batch #${this.currentBatch.id}: ${this.currentBatch.candidates.length} candidates, position size: ${positionSize.toFixed(6)} SOL each`,
    });

    let openedCount = 0;
    let failedCount = 0;

    // Параллельное открытие позиций (до 5 одновременно для скорости)
    const maxConcurrent = 5;
    const openPromises: Promise<void>[] = [];

    for (const candidate of this.currentBatch.candidates) {
      // Запускаем до maxConcurrent параллельных открытий
      while (openPromises.length >= maxConcurrent) {
        await Promise.race(openPromises);
        // Удаляем завершенные промисы
        for (let i = openPromises.length - 1; i >= 0; i--) {
          const promise = openPromises[i];
          try {
            await Promise.race([promise, Promise.resolve()]);
            openPromises.splice(i, 1);
          } catch {
            // Промис еще выполняется
          }
        }
      }

      const promise = (async () => {
        try {
          await this.openPosition(candidate, positionSize);
          openedCount++;
        } catch (error: any) {
          failedCount++;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: candidate.mint,
            batchId: this.currentBatch?.id,
            message: `Failed to open position for ${candidate.mint.substring(0, 8)}...: ${error?.message || String(error)}`,
          });
        }
      })();

      openPromises.push(promise);
    }

    // Ждем завершения всех оставшихся открытий
    await Promise.all(openPromises);

    const openDuration = Date.now() - openStartTime;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      batchId: this.currentBatch.id,
      message: `Batch positions opened: ${openedCount} successful, ${failedCount} failed, duration: ${openDuration}ms`,
    });
  }

  private async openPosition(candidate: TokenCandidate, positionSize: number): Promise<void> {
    if (!this.currentBatch) return;

    const openStartTime = Date.now();
    try {
      const isRisky = candidate.isRisky || false;
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Opening position: ${candidate.mint.substring(0, 8)}..., position size: ${positionSize.toFixed(6)} SOL, risky: ${isRisky}`,
      });

      // Получаем цену входа
      const priceStartTime = Date.now();
      const entryPrice = await this.filters.getEntryPrice(candidate.mint);
      const priceDuration = Date.now() - priceStartTime;
      
      if (entryPrice <= 0) {
        throw new Error(`Invalid entry price: ${entryPrice}`);
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Entry price received: ${entryPrice.toFixed(8)}, fetch duration: ${priceDuration}ms`,
      });

      // Рассчитываем инвестиции с учетом комиссий
      const fees = config.priorityFee + config.signatureFee;
      const invested = positionSize - fees;

      if (invested <= 0) {
        throw new Error(`Insufficient funds after fees: ${invested}, positionSize: ${positionSize}, fees: ${fees}`);
      }

      // Рассчитываем slippage
      const slippage = calculateSlippage();
      const actualEntryPrice = entryPrice * (1 + slippage);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Position calculated: invested=${invested.toFixed(6)} SOL, slippage=${(slippage * 100).toFixed(2)}%, entry price=${actualEntryPrice.toFixed(8)}, risky: ${isRisky}`,
      });

      // Создаем позицию
      // Для рискованных токенов (очереди 1-2) - ГАРАНТИРОВАННЫЙ выход на 2.5x
      const position: Position = {
        token: candidate.mint,
        batchId: this.currentBatch.id,
        entryPrice: actualEntryPrice,
        investedSol: invested,
        investedUsd: formatUsd(invested),
        entryTime: Date.now(),
        lastRealPriceUpdate: Date.now(),
        peakPrice: actualEntryPrice,
        localHigh: actualEntryPrice,
        takeProfitTarget: actualEntryPrice * config.takeProfitMultiplier, // 2.5x для всех
        stopLossTarget: actualEntryPrice * (1 - config.trailingStopPct / 100),
        exitTimer: Date.now() + config.exitTimerSeconds * 1000,
        slippage: slippage,
        status: 'active',
      };

      this.currentBatch.positions.set(candidate.mint, position);
      this.openPositions.set(candidate.mint, position);

      const openDuration = Date.now() - openStartTime;

      // Логируем покупку
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'buy',
        batchId: this.currentBatch.id,
        token: candidate.mint,
        investedSol: invested,
        entryPrice: actualEntryPrice,
        message: `Position opened: ${candidate.mint.substring(0, 8)}..., risky: ${isRisky}, MUST sell at 2.5x, total duration: ${openDuration}ms`,
      });
    } catch (error: any) {
      const openDuration = Date.now() - openStartTime;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        batchId: this.currentBatch.id,
        message: `Error opening position for ${candidate.mint.substring(0, 8)}...: ${error?.message || String(error)}, duration: ${openDuration}ms`,
      });
      console.error(`Error opening position for ${candidate.mint}:`, error);
      throw error;
    }
  }

  async checkAndClosePositions(): Promise<void> {
    const checkStartTime = Date.now();
    const now = Date.now();
    const positionsToClose: string[] = [];
    const openPositionsCount = this.openPositions.size;

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `Checking ${openPositionsCount} open positions`,
    });

    let checkedCount = 0;
    let priceErrors = 0;

    for (const [token, position] of this.openPositions.entries()) {
      try {
        checkedCount++;
        const positionCheckStart = Date.now();
        
        // Получаем текущую цену
        const currentPrice = await this.filters.getEntryPrice(token);
        const priceFetchDuration = Date.now() - positionCheckStart;
        
        if (currentPrice <= 0) {
          priceErrors++;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'warning',
            token: token,
            batchId: position.batchId,
            message: `Invalid price for position: ${token.substring(0, 8)}..., price: ${currentPrice}, fetch duration: ${priceFetchDuration}ms`,
          });
          continue;
        }

        const multiplier = currentPrice / position.entryPrice;
        const profitPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        // Обновляем локальный максимум
        const localHigh = position.localHigh || position.entryPrice;
        if (currentPrice > localHigh) {
          const oldHigh = localHigh;
          position.localHigh = currentPrice;
          position.stopLossTarget = currentPrice * (1 - config.trailingStopPct / 100);
          
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: token,
            batchId: position.batchId,
            message: `New local high: ${token.substring(0, 8)}..., ${oldHigh.toFixed(8)} → ${currentPrice.toFixed(8)} (${multiplier.toFixed(2)}x, +${profitPct.toFixed(2)}%)`,
          });
        }

        let shouldClose = false;
        let closeReason = '';

        // Проверка тейк-профита (4x)
        const takeProfitTarget = position.takeProfitTarget || (position.entryPrice * config.takeProfitMultiplier);
        if (currentPrice >= takeProfitTarget) {
          shouldClose = true;
          closeReason = 'take_profit';
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: token,
            batchId: position.batchId,
            message: `Take profit triggered: ${token.substring(0, 8)}..., price: ${currentPrice.toFixed(8)}, target: ${takeProfitTarget.toFixed(8)}, multiplier: ${multiplier.toFixed(2)}x`,
          });
        }
        // Проверка таймера (90 секунд)
        else {
          const exitTimer = position.exitTimer || (position.entryTime + config.exitTimerSeconds * 1000);
          if (now >= exitTimer) {
            shouldClose = true;
            closeReason = 'timer';
            const timeHeld = (now - position.entryTime) / 1000;
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: token,
              batchId: position.batchId,
              message: `Timer exit triggered: ${token.substring(0, 8)}..., held for ${timeHeld.toFixed(1)}s, multiplier: ${multiplier.toFixed(2)}x`,
            });
          }
          // Проверка трейлинг-стопа (25% от локального хая)
          else {
            const stopLossTarget = position.stopLossTarget || (position.entryPrice * (1 - config.trailingStopPct / 100));
            if (currentPrice <= stopLossTarget) {
              shouldClose = true;
              closeReason = 'trailing_stop';
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                token: token,
                batchId: position.batchId,
                message: `Trailing stop triggered: ${token.substring(0, 8)}..., price: ${currentPrice.toFixed(8)}, stop: ${stopLossTarget.toFixed(8)}, multiplier: ${multiplier.toFixed(2)}x`,
              });
            } else {
              // Логируем текущее состояние позиции
              const timeLeft = Math.max(0, (exitTimer - now) / 1000);
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                token: token,
                batchId: position.batchId,
                message: `Position status: ${token.substring(0, 8)}..., price: ${currentPrice.toFixed(8)}, multiplier: ${multiplier.toFixed(2)}x, profit: ${profitPct.toFixed(2)}%, time left: ${timeLeft.toFixed(1)}s`,
              });
            }
          }
        }

        if (shouldClose) {
          positionsToClose.push(token);
          await this.closePosition(token, currentPrice, closeReason);
        }
      } catch (error: any) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: token,
          message: `Error checking position ${token.substring(0, 8)}...: ${error?.message || String(error)}`,
        });
        console.error(`Error checking position ${token}:`, error);
      }
    }

    const checkDuration = Date.now() - checkStartTime;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `Position check completed: ${checkedCount} checked, ${positionsToClose.length} to close, ${priceErrors} price errors, duration: ${checkDuration}ms`,
    });

    // Проверяем, завершен ли батч
    if (this.currentBatch && this.currentBatch.positions.size > 0) {
      const allClosed = Array.from(this.currentBatch.positions.values()).every(
        pos => !this.openPositions.has(pos.token)
      );

      if (allClosed) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          batchId: this.currentBatch.id,
          message: `All positions in batch #${this.currentBatch.id} closed, completing batch`,
        });
        await this.completeBatch();
      }
    }
  }

  private async closePosition(token: string, exitPrice: number, reason: string): Promise<void> {
    const closeStartTime = Date.now();
    const position = this.openPositions.get(token);
    if (!position) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        token: token,
        message: `Attempted to close non-existent position: ${token.substring(0, 8)}...`,
      });
      return;
    }

    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: token,
        batchId: position.batchId,
        message: `Closing position: ${token.substring(0, 8)}..., reason: ${reason}, exit price: ${exitPrice.toFixed(8)}`,
      });

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
      const timeHeld = (Date.now() - position.entryTime) / 1000;

      const depositBefore = this.currentDeposit;

      // Обновляем депозит
      this.currentDeposit += profit;
      if (this.currentDeposit > this.peakDeposit) {
        this.peakDeposit = this.currentDeposit;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `New peak deposit: ${this.peakDeposit.toFixed(6)} SOL`,
        });
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

      const closeDuration = Date.now() - closeStartTime;

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
        message: `Position closed: ${token.substring(0, 8)}..., held for ${timeHeld.toFixed(1)}s, deposit: ${depositBefore.toFixed(6)} → ${this.currentDeposit.toFixed(6)} SOL, duration: ${closeDuration}ms`,
      });
    } catch (error: any) {
      const closeDuration = Date.now() - closeStartTime;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: token,
        batchId: position.batchId,
        message: `Error closing position ${token.substring(0, 8)}...: ${error?.message || String(error)}, duration: ${closeDuration}ms`,
      });
      console.error(`Error closing position ${token}:`, error);
    }
  }

  private async completeBatch(): Promise<void> {
    if (!this.currentBatch) return;

    const batch = this.currentBatch;
    const batchStartTime = batch.startTime;
    const batchDuration = (Date.now() - batchStartTime) / 1000;
    const depositAfter = this.currentDeposit;
    const depositBefore = batch.depositBefore;
    const netProfitPct = ((depositAfter - depositBefore) / depositBefore) * 100;
    const netProfitSol = depositAfter - depositBefore;

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      batchId: batch.id,
      message: `Completing batch #${batch.id}: duration=${batchDuration.toFixed(1)}s, positions=${batch.positions.size}, candidates=${batch.candidates.length}`,
    });

    // Логируем завершение батча
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'batch_complete',
      batchId: batch.id,
      netProfitPct: netProfitPct,
      depositBefore: depositBefore,
      depositAfter: depositAfter,
      message: `Batch #${batch.id} completed: ${netProfitPct >= 0 ? '+' : ''}${netProfitPct.toFixed(2)}% (${netProfitSol >= 0 ? '+' : ''}${netProfitSol.toFixed(6)} SOL), duration: ${batchDuration.toFixed(1)}s`,
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

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Updated stats: totalBatches=${stats.totalBatches}, winBatches=${stats.winBatches}, winRate=${((stats.winBatches / stats.totalBatches) * 100).toFixed(1)}%, avgProfit=${stats.avgBatchProfitPct.toFixed(2)}%`,
      });
    }

    // Очищаем текущий батч
    this.currentBatch = null;

    // Начинаем новый батч
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `Starting new batch after completion`,
    });
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

