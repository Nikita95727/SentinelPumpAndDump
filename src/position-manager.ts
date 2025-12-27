import { Connection } from '@solana/web3.js';
import { Position, PositionStats, TokenCandidate } from './types';
import { config } from './config';
import { logger } from './logger';
import { tradeLogger } from './trade-logger';
import { getCurrentTimestamp, sleep, calculateSlippage, formatUsd } from './utils';
import { quickSecurityCheck } from './quick-filters';
import { priceFetcher } from './price-fetcher';
import { TokenFilters } from './filters';
import { earlyActivityTracker } from './early-activity-tracker';
import { SafetyManager } from './safety-manager';
import { RealTradingAdapter } from './real-trading-adapter';

// Используем config.maxOpenPositions вместо хардкода
const MAX_HOLD_TIME = 90_000; // 90 секунд
const TRAILING_STOP_PCT = 0.25;
const CHECK_INTERVAL = 2000; // Проверка каждые 2 секунды (даем импульсу развиться, но не пропускаем падение)
const PREDICTION_CHECK_INTERVAL = 200; // Проверка прогнозируемой цены каждые 200ms (быстрое обнаружение импульса)
const MAX_PRICE_HISTORY = 3; // Храним последние 3 цены для расчета импульса

/**
 * Single source of truth for account balance
 * All balance modifications MUST go through this class
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

  // Метод для исправления рассинхронизации (только для диагностики)
  fixLockedBalance(correctValue: number): void {
    this.lockedBalance = correctValue;
    if (this.lockedBalance < 0) {
      this.lockedBalance = 0;
    }
  }

  /**
   * Reserve funds for a position
   * Returns true if successful, false if insufficient funds
   */
  reserve(amount: number): boolean {
    if (this.getFreeBalance() < amount || amount <= 0) {
      return false;
    }
    this.lockedBalance += amount;
    // Invariant: freeBalance >= 0 always
    if (this.getFreeBalance() < 0) {
      this.lockedBalance -= amount; // Rollback
      return false;
    }
    return true;
  }

  /**
   * Deduct amount from deposit (for position opening)
   * ISSUE #1: Deduct FULL positionSize from deposit (includes entry fees)
   */
  deductFromDeposit(amount: number): void {
    if (amount <= 0) return;
    this.totalBalance -= amount;
    if (this.totalBalance < 0) {
      this.totalBalance = 0;
    }
  }

  /**
   * Release reserved funds and update total balance with net proceeds
   * ISSUE #1 FIX: On close, add back (grossReturn - exitFees) to deposit
   * proceeds already has exitFees deducted
   */
  release(reservedAmount: number, proceeds: number): void {
    if (reservedAmount < 0 || this.lockedBalance < reservedAmount) {
      // Invalid state - log but don't crash
      console.error(`⚠️ Invalid release: reservedAmount=${reservedAmount}, lockedBalance=${this.lockedBalance}`);
      return;
    }
    
    // Release the locked amount
    this.lockedBalance -= reservedAmount;
    
    // ISSUE #1 FIX: proceeds already has exitFees deducted, so add it back to deposit
    this.totalBalance += proceeds;
    
    // Update peak
    if (this.totalBalance > this.peakBalance) {
      this.peakBalance = this.totalBalance;
    }
    
    // Invariants
    if (this.lockedBalance < 0) {
      this.lockedBalance = 0;
    }
    if (this.totalBalance < 0) {
      this.totalBalance = 0;
    }
  }

  /**
   * Get position size based on current free balance
   * Distributes balance evenly across available positions (not divided by fixed number)
   * Reserves funds for entry/exit fees
   * 
   * Minimum position size ensures fees never eat profit:
   * - Entry fees: 0.001005 SOL
   * - Exit fees: 0.001005 SOL
   * - For 2.5x profit: investedAmount * 1.5 > totalFees
   * - Minimum invested: ~0.00134 SOL
   * - Minimum positionSize: ~0.002345 SOL (with 50% safety margin: 0.0035 SOL)
   */
  getPositionSize(maxPositions: number, minPositionSize: number = 0.0035, workingBalance?: number, currentOpenPositions: number = 0, entryFees: number = 0.001005): number {
    const free = workingBalance !== undefined ? workingBalance - this.lockedBalance : this.getFreeBalance();
    if (free <= 0) {
      return minPositionSize;
    }

    // Calculate how many positions we can still open
    const availableSlots = maxPositions - currentOpenPositions;
    if (availableSlots <= 0) {
      return minPositionSize;
    }

    // Не резервируем entry fees заранее в getPositionSize
    // Все резервы (entry fees + exit fees + slippage) будут проверяться при открытии позиции
    // Это позволяет более гибко использовать баланс
    const availableForPositions = free;

    if (availableForPositions <= 0) {
      return minPositionSize;
    }

    // Distribute evenly across available slots
    const calculatedSize = availableForPositions / availableSlots;
    
    // Ensure position size is at least minPositionSize to cover fees
    return Math.max(calculatedSize, minPositionSize);
  }
}

export class PositionManager {
  private positions = new Map<string, Position>();
  private connection: Connection;
  private filters: TokenFilters;
  private account: Account; // Single source of truth for balance
  private safetyManager: SafetyManager;
  private tradeIdCounter: number = 0;
  private realTradingAdapter?: RealTradingAdapter; // Optional real trading adapter

  constructor(connection: Connection, initialDeposit: number, realTradingAdapter?: RealTradingAdapter) {
    this.connection = connection;
    this.filters = new TokenFilters(connection);
    this.account = new Account(initialDeposit);
    this.safetyManager = new SafetyManager(initialDeposit);
    this.realTradingAdapter = realTradingAdapter;

    if (realTradingAdapter) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: '🔴 REAL TRADING MODE ENABLED IN POSITION MANAGER',
      });
    } else {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: '📄 Paper trading mode (simulation)',
      });
    }

    // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем и исправляем баланс при старте
    this.fixBalanceDesync();

    // Централизованное обновление цен каждые 2 секунды
    setInterval(() => this.updateAllPrices(), CHECK_INTERVAL);
    
    // Update safety manager with current balance periodically
    setInterval(() => {
      this.safetyManager.updateSessionBalance(this.account.getTotalBalance());
    }, 5000); // Every 5 seconds

    // Периодическая проверка баланса (каждые 10 секунд)
    setInterval(() => {
      this.fixBalanceDesync();
    }, 10000);

    // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ: Статистика каждые 60 секунд (не замедляет!)
    setInterval(() => {
      const stats = this.getStats();
      const totalBalance = this.account.getTotalBalance();
      const freeBalance = this.account.getFreeBalance();
      const lockedBalance = this.account.getLockedBalance();
      const peakBalance = this.account.getPeakBalance();
      const profit = totalBalance - initialDeposit;
      const profitPct = (profit / initialDeposit) * 100;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `📊 STATUS: Active: ${stats.activePositions}/${config.maxOpenPositions}, Balance: ${totalBalance.toFixed(6)} SOL (${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(2)}%), Free: ${freeBalance.toFixed(6)}, Locked: ${lockedBalance.toFixed(6)}, Peak: ${peakBalance.toFixed(6)}`,
      });
    }, 60000); // Каждые 60 секунд
  }

  /**
   * Generate unique trade ID
   */
  private generateTradeId(): string {
    this.tradeIdCounter++;
    return `trade-${Date.now()}-${this.tradeIdCounter}`;
  }

  /**
   * Исправляет рассинхронизацию баланса
   * Вызывается при старте и периодически
   */
  private fixBalanceDesync(): void {
    const activePositions = Array.from(this.positions.values()).filter(p => p.status === 'active');
    const totalReservedInPositions = activePositions.reduce((sum, p) => sum + (p.reservedAmount || 0), 0);
    
    const freeBalance = this.account.getFreeBalance();
    const totalBalance = this.account.getTotalBalance();
    const lockedBalance = this.account.getLockedBalance();

    // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ 1: Если нет позиций, но есть застрявшие средства
    if (activePositions.length === 0 && lockedBalance > 0.0001) {
      console.error(`⚠️ BALANCE DESYNC FIX: No positions but lockedBalance=${lockedBalance.toFixed(6)}. Resetting to 0.`);
      this.account.fixLockedBalance(0);
      return;
    }

    // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ 2: Если lockedBalance больше totalBalance - это невозможно
    if (lockedBalance > totalBalance + 0.0001) {
      console.error(`⚠️ BALANCE DESYNC FIX: lockedBalance=${lockedBalance.toFixed(6)} > totalBalance=${totalBalance.toFixed(6)}. This is impossible!`);
      console.error(`   Fixing: setting lockedBalance to ${totalReservedInPositions.toFixed(6)} (actual reserved)`);
      this.account.fixLockedBalance(totalReservedInPositions);
      return;
    }

    // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ 3: Если freeBalance отрицательный
    if (freeBalance < -0.0001) {
      console.error(`⚠️ BALANCE DESYNC FIX: freeBalance=${freeBalance.toFixed(6)} is negative!`);
      console.error(`   totalBalance=${totalBalance.toFixed(6)}, lockedBalance=${lockedBalance.toFixed(6)}, totalReserved=${totalReservedInPositions.toFixed(6)}`);
      // Исправляем: устанавливаем lockedBalance равным реально зарезервированному
      this.account.fixLockedBalance(totalReservedInPositions);
      console.error(`   Fixed: lockedBalance set to ${totalReservedInPositions.toFixed(6)}`);
      return;
    }

    // Обычная проверка: рассинхронизация между lockedBalance и позициями
    if (Math.abs(lockedBalance - totalReservedInPositions) > 0.0001) {
      console.error(`⚠️ BALANCE DESYNC FIX: lockedBalance=${lockedBalance.toFixed(6)} != totalReservedInPositions=${totalReservedInPositions.toFixed(6)}, diff=${(lockedBalance - totalReservedInPositions).toFixed(6)}`);
      console.error(`   Active positions: ${activePositions.length}`);
      const correctLocked = totalReservedInPositions;
      this.account.fixLockedBalance(correctLocked);
      console.error(`   Fixed: lockedBalance set to ${correctLocked.toFixed(6)}`);
    }
  }

  /**
   * Проверяет, есть ли достаточно баланса для открытия хотя бы одной позиции
   * Учитывает резервы для входа, выхода и slippage
   * @returns true если есть баланс, false если нет
   */
  hasEnoughBalanceForTrading(): boolean {
    const entryFees = config.priorityFee + config.signatureFee;
    const exitFees = config.priorityFee + config.signatureFee;
    const minPositionSize = 0.0035; // Минимальный размер позиции
    const investedAmount = minPositionSize - entryFees; // После вычета entry fees
    
    // Рассчитываем резерв для выхода (exit fees + slippage)
    // Expected proceeds при take profit: investedAmount * 2.5
    const expectedProceedsAtTakeProfit = investedAmount * config.takeProfitMultiplier;
    const exitSlippage = expectedProceedsAtTakeProfit * config.slippageMax;
    
    // Общий требуемый резерв: positionSize + exitFees + exitSlippage
    const requiredAmount = minPositionSize + exitFees + exitSlippage;
    
    const freeBalance = this.account.getFreeBalance();
    const totalBalance = this.account.getTotalBalance();
    const lockedBalance = this.account.getLockedBalance();
    
    // Диагностика: логируем если баланс недостаточен
    if (freeBalance < requiredAmount) {
      console.log(`[DEBUG] hasEnoughBalanceForTrading: freeBalance=${freeBalance.toFixed(6)}, totalBalance=${totalBalance.toFixed(6)}, lockedBalance=${lockedBalance.toFixed(6)}, required=${requiredAmount.toFixed(6)}`);
    }
    
    return freeBalance >= requiredAmount;
  }

  /**
   * Пытается открыть позицию для токена
   * Возвращает true если позиция открыта, false если нет свободных слотов или проверка не прошла
   */
  async tryOpenPosition(candidate: TokenCandidate): Promise<boolean> {
    // TIMING ANALYSIS: Track all stages for hypothesis validation
    const processingStartTime = Date.now();
    const tokenCreatedAt = candidate.createdAt;
    const tokenAgeAtStart = (processingStartTime - tokenCreatedAt) / 1000; // seconds
    
    // 0. Фильтр: исключаем SOL токен
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (candidate.mint === SOL_MINT) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `Skipped SOL token (not a pump.fun token)`,
      });
      return false;
    }

    // ⚡ КРИТИЧНО: Минимальный возраст токена для стабильной работы SDK
    const MIN_TOKEN_AGE_SECONDS = 5;
    if (tokenAgeAtStart < MIN_TOKEN_AGE_SECONDS) {
      const waitTime = (MIN_TOKEN_AGE_SECONDS - tokenAgeAtStart) * 1000;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `⏱️ Token too young (${tokenAgeAtStart.toFixed(2)}s), waiting ${(waitTime / 1000).toFixed(2)}s for SDK initialization...`,
      });
      // Ждем пока токену не исполнится MIN_TOKEN_AGE_SECONDS
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // 1. Проверка: есть ли свободные слоты?
    if (this.positions.size >= config.maxOpenPositions) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `No free slots (${this.positions.size}/${config.maxOpenPositions})`,
      });
      return false;
    }

    // 2. TEMPORARILY DISABLED: Safety check removed for testing
    // if (this.safetyManager.isHalted()) {
    //   return false;
    // }

    // 3. Проверка: достаточно ли средств для открытия позиции?
    // Проверяем минимальный требуемый резерв (positionSize + exitFees + exitSlippage)
    const entryFees = config.priorityFee + config.signatureFee;
    const exitFees = config.priorityFee + config.signatureFee;
    const MIN_POSITION_SIZE = 0.0035;
    
    // Рассчитываем минимальный требуемый резерв для одной позиции
    const minInvestedAmount = MIN_POSITION_SIZE - entryFees;
    const minExpectedProceeds = minInvestedAmount * config.takeProfitMultiplier;
    const minExitSlippage = minExpectedProceeds * config.slippageMax;
    const minTotalReserved = MIN_POSITION_SIZE + exitFees + minExitSlippage;
    
    if (this.account.getFreeBalance() < minTotalReserved) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `Insufficient balance: ${this.account.getFreeBalance().toFixed(6)} SOL < ${minTotalReserved.toFixed(6)} SOL (min required for position)`,
      });
      return false;
    }

    // 4. Определяем очередь токена для оптимизаций
    const age = (Date.now() - candidate.createdAt) / 1000;
    const isQueue1 = age >= config.queue1MinDelaySeconds && age <= config.queue1MaxDelaySeconds;
    const isQueue2 = age >= config.queue2MinDelaySeconds && age <= config.queue2MaxDelaySeconds;
    const isPriority = isQueue1 || isQueue2;

    // 5. Early activity check - skip tokens with no early life
    // This gate reduces dead/flat trades without cutting winners
    const earlyActivityCheckStart = Date.now();
    const hasEarlyActivity = earlyActivityTracker.hasEarlyActivity(candidate.mint);
    const earlyActivityCheckDuration = Date.now() - earlyActivityCheckStart;
    
    if (!hasEarlyActivity) {
      // Token showed no early activity within observation window - skip
      // This is NOT a permanent blacklist, just avoiding clearly dead tokens
      return false;
    }

    // 6. ОПТИМИЗАЦИЯ: Параллельная обработка security check + price fetch для приоритетных очередей
    const securityCheckStart = Date.now();
    const openStartTime = Date.now(); // Для измерения openDuration
    let securityCheckDuration = 0;
    let openDuration = 0;
    let passed = false;
    let position: Position | null = null;

    if (isPriority) {
      // Для queue1 и queue2: параллельная обработка
      // skipFreezeCheck только для queue1 (более агрессивная оптимизация)
      const [securityResult, positionResult] = await Promise.allSettled([
        quickSecurityCheck(candidate, isQueue1), // skipFreezeCheck только для queue1
        this.openPosition(candidate, isPriority).catch((error) => {
          // Log the error but return null to continue processing
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: candidate.mint,
            message: `openPosition failed: ${error instanceof Error ? error.message : String(error)}`,
          });
          return null;
        }),
      ]);

      securityCheckDuration = Date.now() - securityCheckStart;
      openDuration = Date.now() - openStartTime;
      
      if (securityResult.status === 'fulfilled') {
        passed = securityResult.value;
      } else {
        passed = false;
      }

      if (positionResult.status === 'fulfilled') {
        position = positionResult.value;
      }

      if (!passed) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `Security check failed (${securityCheckDuration}ms)`,
        });
        return false;
      }

      if (!position) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: candidate.mint,
          message: `Failed to open position (parallel processing)`,
        });
        return false;
      }
    } else {
      // Для остальных очередей: последовательная обработка (как было)
      passed = await quickSecurityCheck(candidate);
      securityCheckDuration = Date.now() - securityCheckStart;

      if (!passed) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `Security check failed (${securityCheckDuration}ms)`,
        });
        return false;
      }

      // Открываем позицию
      position = await this.openPosition(candidate, isPriority);
      openDuration = Date.now() - openStartTime;
    }

    // 7. Позиция открыта успешно
    if (!position) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        message: `Position is null after processing`,
      });
      return false;
    }

    try {
      // Calculate total time from token creation to position opening
      const totalTimeFromCreation = (Date.now() - tokenCreatedAt) / 1000; // seconds
      const tokenAgeAtOpen = totalTimeFromCreation;
      const totalProcessingTime = Date.now() - processingStartTime;
      
      // Store timing data in position for later analysis
      (position as any).timingData = {
        tokenCreatedAt,
        processingStartTime,
        tokenAgeAtStart,
        earlyActivityCheckDuration,
        securityCheckDuration,
        openDuration,
        totalProcessingTime,
        tokenAgeAtOpen,
      };
      
      // 6. Запускаем параллельный мониторинг (НЕ await!)
      this.monitorPosition(position).catch(err => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: position.token,
          message: `❌ [ERROR] monitorPosition failed: ${err.message}`,
        });
      });
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `Position opened successfully | Token age at start: ${tokenAgeAtStart.toFixed(2)}s | Token age at open: ${tokenAgeAtOpen.toFixed(2)}s | Early activity: ${earlyActivityCheckDuration}ms | Security check: ${securityCheckDuration}ms | Open duration: ${openDuration}ms | Total processing: ${totalProcessingTime}ms | Entry price: ${position.entryPrice.toFixed(8)}`,
      });
      
      return true;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        message: `Error opening position: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Открывает позицию для токена
   * @param isPriority - для queue1/queue2: убираем задержки перед price fetch
   */
  private async openPosition(candidate: TokenCandidate, isPriority: boolean = false): Promise<Position> {
    const openStartTime = Date.now();

    // TIMING ANALYSIS: Get price at detection time for comparison
    const priceFetchStart = Date.now();
    const tokenAgeBeforePriceFetch = (Date.now() - candidate.createdAt) / 1000;
    
    // Получаем цену входа (для приоритетных очередей убираем задержку)
    const entryPrice = await this.filters.getEntryPrice(candidate.mint, isPriority);
    const priceFetchDuration = Date.now() - priceFetchStart;
    const tokenAgeAfterPriceFetch = (Date.now() - candidate.createdAt) / 1000;
    
    if (entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }
    
    // Log price fetch timing for analysis
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: candidate.mint,
      message: `Price fetch: age before: ${tokenAgeBeforePriceFetch.toFixed(2)}s, age after: ${tokenAgeAfterPriceFetch.toFixed(2)}s, duration: ${priceFetchDuration}ms, price: ${entryPrice.toFixed(8)}`,
    });

    // Получаем размер позиции из Account с учетом working balance
    const entryFees = config.priorityFee + config.signatureFee;
    // Calculate position size: distribute evenly, reserve for fees, min 0.0035 SOL
    let positionSize = this.account.getPositionSize(config.maxOpenPositions, 0.0035, this.account.getTotalBalance(), this.positions.size, entryFees);
    
    // Apply safety caps (maxSolPerTrade = 0.05 SOL) - ограничение для избежания влияния на цену
    positionSize = this.safetyManager.applySafetyCaps(positionSize);
    
    // Ensure position size is at least minimum
    const MIN_POSITION_SIZE = 0.0035;
    if (positionSize < MIN_POSITION_SIZE) {
      if (this.account.getFreeBalance() >= MIN_POSITION_SIZE) {
        // Use minimum if we have enough balance
        // This shouldn't happen with new logic, but keep as safety
      } else {
        throw new Error(`Position size too small: ${positionSize} < ${MIN_POSITION_SIZE}, insufficient balance`);
      }
    }
    
    // Рассчитываем комиссии
    const exitFees = config.priorityFee + config.signatureFee;
    const investedAmount = positionSize - entryFees;

    if (investedAmount <= 0) {
      throw new Error(`Insufficient funds after fees: ${investedAmount}`);
    }

    // Additional check: ensure investedAmount is sufficient for profit after exit fees
    const totalFees = entryFees + exitFees;
    // For 2.5x profit: investedAmount * 1.5 must be > totalFees
    const minInvestedForProfit = totalFees / 1.5;
    if (investedAmount < minInvestedForProfit) {
      throw new Error(`Position size too small: investedAmount (${investedAmount}) < minimum for profit (${minInvestedForProfit})`);
    }

    // Рассчитываем резерв для выхода:
    // - exitFees (комиссия на выход)
    // - exitSlippage (slippage на выход, рассчитываем как процент от expected proceeds)
    // Expected proceeds при take profit (2.5x): investedAmount * 2.5
    const expectedProceedsAtTakeProfit = investedAmount * config.takeProfitMultiplier;
    // Slippage на выход: используем максимальный slippage для безопасности
    const exitSlippage = expectedProceedsAtTakeProfit * config.slippageMax;
    
    // Общий резерв для позиции: investedAmount + entryFees + exitFees + exitSlippage
    const totalReservedAmount = positionSize + exitFees + exitSlippage;

    // Защита от некорректных значений
    if (investedAmount > 1.0 || positionSize > 1.0 || totalReservedAmount > 1.0) {
      throw new Error(`Invalid amounts: positionSize=${positionSize}, investedAmount=${investedAmount}, totalReserved=${totalReservedAmount}`);
    }

    // Check balance BEFORE deducting
    const freeBalance = this.account.getFreeBalance();
    if (freeBalance < totalReservedAmount) {
      throw new Error(`Failed to reserve ${totalReservedAmount} SOL (insufficient free balance: ${freeBalance.toFixed(6)}). Required: positionSize=${positionSize} + exitFees=${exitFees} + exitSlippage=${exitSlippage.toFixed(6)})`);
    }
    
    // ISSUE #1: Deduct FULL positionSize from deposit (includes entry fees)
    // This represents the actual trade amount spent
    this.account.deductFromDeposit(positionSize);
    
    // Резервируем средства через Account (включая резерв для выхода)
    // reserve() only increases lockedBalance, doesn't touch totalBalance
    // After deducting positionSize, freeBalance is reduced, but we still need to reserve exit fees + slippage
    // The remaining freeBalance should be: (originalFreeBalance - positionSize) >= (exitFees + exitSlippage)
    if (!this.account.reserve(totalReservedAmount)) {
      // Rollback: add back positionSize if reserve fails
      this.account.deductFromDeposit(-positionSize);
      throw new Error(`Failed to reserve ${totalReservedAmount} SOL after deducting positionSize`);
    }

    // Рассчитываем slippage
    const slippage = calculateSlippage();
    const actualEntryPrice = entryPrice * (1 + slippage);

    // Создаем позицию
    // Position stores: reservedAmount (totalReservedAmount включая exit fees и slippage) and investedAmount (after entry fees)
    const position: Position = {
      token: candidate.mint,
      entryPrice: actualEntryPrice,
      investedSol: investedAmount, // Amount actually invested (after entry fees)
      investedUsd: formatUsd(investedAmount),
      entryTime: Date.now(),
      peakPrice: actualEntryPrice,
      currentPrice: actualEntryPrice,
      status: 'active',
      errorCount: 0,
      // Store totalReservedAmount for proper accounting on close (includes exit fees and slippage)
      reservedAmount: totalReservedAmount,
    };

    this.positions.set(candidate.mint, position);

    // Generate trade ID and store in position
    const tradeId = this.generateTradeId();
    (position as any).tradeId = tradeId;

    // 🔴 REAL TRADING: Execute real buy if enabled
    if (this.realTradingAdapter) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🔴 Executing REAL BUY: ${positionSize.toFixed(6)} SOL → ${candidate.mint}`,
      });

      const buyResult = await this.realTradingAdapter.executeBuy(candidate.mint, positionSize);

      if (!buyResult.success) {
        // Rollback: Real trade failed
        this.positions.delete(candidate.mint);
        this.account.reserve(-totalReservedAmount); // Release reserved funds
        this.account.deductFromDeposit(-positionSize); // Add back deducted amount

        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: candidate.mint,
          message: `❌ REAL BUY FAILED: ${buyResult.error}`,
        });

        throw new Error(`Real trade failed: ${buyResult.error}`);
      }

      // Store transaction signature for tracking
      (position as any).buySignature = buyResult.signature;
      (position as any).tokensReceived = buyResult.tokensReceived;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ REAL BUY SUCCESS: signature=${buyResult.signature}, received=${buyResult.tokensReceived} tokens`,
      });
    }

    // Non-blocking trade logging
    tradeLogger.logTradeOpen({
      tradeId,
      token: candidate.mint,
      investedSol: investedAmount,
      entryPrice: actualEntryPrice,
    });

    // Legacy logger (for console output)
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'buy',
      token: candidate.mint,
      investedSol: investedAmount,
      entryPrice: actualEntryPrice,
      message: `Position opened: ${candidate.mint.substring(0, 8)}..., invested=${investedAmount.toFixed(6)} SOL, entry=${actualEntryPrice.toFixed(8)}${this.realTradingAdapter ? ' 🔴 REAL' : ' 📄 SIM'}`,
    });

    // CRITICAL: Start monitoring immediately after position is created
    this.monitorPosition(position).catch(err => {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: position.token,
        message: `❌ [ERROR] monitorPosition failed: ${err.message}`,
      });
    });

    return position;
  }

  /**
   * Параллельный мониторинг позиции
   * Использует промежуточный расчет цены по импульсу для более быстрой реакции
   */
  private async monitorPosition(position: Position): Promise<void> {
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: position.token,
      message: `🔍 [DEBUG] monitorPosition started`,
    });
    let lastPriceCheck = Date.now();
    let loopCount = 0;
    
    while (position.status === 'active') {
      loopCount++;
      const now = Date.now();
      const timeSinceLastCheck = now - lastPriceCheck;
      const elapsed = Date.now() - position.entryTime;
      
      // Log every 10 loops to see if loop is running
      if (loopCount % 10 === 0) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
          message: `🔄 [DEBUG] monitorPosition loop #${loopCount} elapsed=${(elapsed/1000).toFixed(1)}s status=${position.status}`,
        });
      }
      
      // КРИТИЧЕСКАЯ ПРОВЕРКА: Timeout (90 секунд) - проверяем ВСЕГДА, независимо от проверки цены
      if (elapsed >= MAX_HOLD_TIME) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
          message: `⏰ [DEBUG] TIMEOUT triggered after ${(elapsed/1000).toFixed(1)}s`,
        });
        const currentPrice = position.currentPrice || position.entryPrice;
        await this.closePosition(position, 'timeout', currentPrice);
        return;
      }
      
      // Проверяем прогнозируемую цену каждые PREDICTION_CHECK_INTERVAL
      // и реальную цену каждые CHECK_INTERVAL
      const shouldCheckPrediction = timeSinceLastCheck >= PREDICTION_CHECK_INTERVAL;
      const shouldCheckRealPrice = timeSinceLastCheck >= CHECK_INTERVAL;

      try {
        // Используем кэшированную цену из updateAllPrices
        const currentPrice = position.currentPrice || position.entryPrice;

        // ПРОМЕЖУТОЧНАЯ ПРОВЕРКА: Используем прогнозируемую цену для раннего обнаружения
        if (shouldCheckPrediction) {
          const predictedPrice = this.calculatePredictedPrice(position);
          
          if (predictedPrice !== null && predictedPrice > 0) {
            const predictedMultiplier = predictedPrice / position.entryPrice;
            
            // Если прогноз показывает достижение take profit, проверяем реальную цену
            if (predictedMultiplier >= config.takeProfitMultiplier) {
              // Прогноз показал достижение цели - проверяем реальную цену
              // Используем реальную цену для финального решения
              const realMultiplier = currentPrice / position.entryPrice;
              
              if (realMultiplier >= config.takeProfitMultiplier) {
                // Реальная цена подтверждает - выходим
                await this.closePosition(position, 'take_profit', currentPrice);
                return;
              }
              // Если реальная цена еще не достигла цели, продолжаем мониторинг
            }
          }
        }

        // ОСНОВНАЯ ПРОВЕРКА: Реальная цена (каждые 2 секунды)
        // Увеличенный интервал дает импульсу развиться, но не пропускаем падение благодаря trailing stop
        if (shouldCheckRealPrice) {
          const currentMultiplier = currentPrice / position.entryPrice;
          const timeHeldSeconds = elapsed / 1000;

          // Обновляем peak
          if (currentPrice > position.peakPrice) {
            position.peakPrice = currentPrice;
          }

          const peakMultiplier = position.peakPrice / position.entryPrice;
          const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice;

          // === ГИБРИДНАЯ СТРАТЕГИЯ ВЫХОДА ===
          
          // СТРАТЕГИЯ 1: Слабый импульс (пик < 3x)
          // Выходим сразу на 2.5x - токен не показал сильного роста
          if (peakMultiplier < 3.0 && currentMultiplier >= config.takeProfitMultiplier) {
            await this.closePosition(position, 'take_profit', currentMultiplier);
            return;
          }

          // СТРАТЕГИЯ 2: Средний импульс (3x ≤ пик < 5x)
          // Адаптивный trailing stop 20% - баланс между жадностью и безопасностью
          if (peakMultiplier >= 3.0 && peakMultiplier < 5.0) {
            if (dropFromPeak >= 0.20) {
              await this.closePosition(position, 'trailing_stop', currentMultiplier);
              return;
            }
            
            // Защита: держим 70+ секунд и упали на 15% от пика - выходим
            if (timeHeldSeconds >= 70 && dropFromPeak >= 0.15) {
              await this.closePosition(position, 'late_exit', currentMultiplier);
              return;
            }
          }

          // СТРАТЕГИЯ 3: Большой импульс (5x ≤ пик < 10x)
          // Жадный trailing stop 25% - позволяем импульсу развиться
          if (peakMultiplier >= 5.0 && peakMultiplier < 10.0) {
            if (dropFromPeak >= 0.25) {
              await this.closePosition(position, 'trailing_stop', currentMultiplier);
              return;
            }
            
            // Защита: держим 75+ секунд и упали на 20% от пика - выходим
            if (timeHeldSeconds >= 75 && dropFromPeak >= 0.20) {
              await this.closePosition(position, 'late_exit', currentMultiplier);
              return;
            }
          }

          // СТРАТЕГИЯ 4: Очень большой импульс (пик ≥ 10x)
          // Максимально жадный trailing stop 30% - даем пространство для роста
          if (peakMultiplier >= 10.0) {
            if (dropFromPeak >= 0.30) {
              await this.closePosition(position, 'trailing_stop', currentMultiplier);
              return;
            }
            
            // Защита: держим 80+ секунд и упали на 25% от пика - выходим
            if (timeHeldSeconds >= 80 && dropFromPeak >= 0.25) {
              await this.closePosition(position, 'late_exit', currentMultiplier);
              return;
            }
          }

          // ОБЩАЯ ЗАЩИТА: Держим близко к timeout и цена сильно упала
          // Если держим 85+ секунд и текущая цена < 50% от пика - принудительный выход
          // Для самородков (peak > 10x) используем более мягкое условие: < 40% от пика
          const emergencyDropThreshold = peakMultiplier >= 10.0 ? 0.40 : 0.50;
          if (timeHeldSeconds >= 85 && currentMultiplier < peakMultiplier * emergencyDropThreshold) {
            await this.closePosition(position, 'emergency_exit', currentMultiplier);
            return;
          }

          lastPriceCheck = now; // Обновляем время последней проверки реальной цены
        }

        // Если не было проверки реальной цены, ждем меньше времени
        if (!shouldCheckRealPrice) {
          await sleep(PREDICTION_CHECK_INTERVAL);
        } else {
          await sleep(CHECK_INTERVAL);
        }

      } catch (error) {
        // Защита от бесконечных ошибок
        position.errorCount = (position.errorCount || 0) + 1;
        if (position.errorCount > 10) {
          await this.closePosition(position, 'error', position.entryPrice);
          return;
        }

        await sleep(5000); // При ошибке ждем дольше
      }
    }
  }

  /**
   * Закрывает позицию
   */
  private async closePosition(position: Position, reason: string, exitPrice: number): Promise<void> {
    if (position.status !== 'active') {
      return; // Уже закрывается или закрыта
    }

    position.status = 'closing';

    try {
      // 🔴 REAL TRADING: Execute real sell if enabled
      if (this.realTradingAdapter) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
          message: `🔴 Executing REAL SELL: ${position.token} → SOL (expected ~${(position.investedSol * (exitPrice / position.entryPrice)).toFixed(6)} SOL)`,
        });

        const sellResult = await this.realTradingAdapter.executeSell(
          position.token,
          position.investedSol * (exitPrice / position.entryPrice) // Expected proceeds
        );

        if (!sellResult.success) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: position.token,
            message: `❌ REAL SELL FAILED: ${sellResult.error}, continuing with accounting...`,
          });
          // НЕ throw - позиция уже закрыта в памяти, продолжаем с учетом
        } else {
          // Store transaction signature
          (position as any).sellSignature = sellResult.signature;
          (position as any).solReceived = sellResult.solReceived;

          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: position.token,
            message: `✅ REAL SELL SUCCESS: signature=${sellResult.signature}, received=${sellResult.solReceived?.toFixed(6)} SOL`,
          });
        }
      }

      // Accounting (paper or real)
      const exitFee = config.priorityFee + config.signatureFee;
      const multiplier = exitPrice / position.entryPrice;
      const investedAmount = position.investedSol; // Amount actually invested (after entry fees)
      const reservedAmount = position.reservedAmount || investedAmount; // Amount that was locked
      
      // Защита от некорректных значений exitPrice (может быть огромным из-за bonding curve ошибок)
      let safeExitPrice = exitPrice;
      
      // Проверяем валидность exitPrice
      if (exitPrice <= 0 || !isFinite(exitPrice)) {
        // Цена некорректна - используем peakPrice или currentPrice
        safeExitPrice = position.peakPrice && position.peakPrice > 0 
          ? position.peakPrice 
          : (position.currentPrice && position.currentPrice > 0 ? position.currentPrice : position.entryPrice);
        console.error(`⚠️ Invalid exitPrice: ${exitPrice}, using safeExitPrice: ${safeExitPrice}`);
      } else if (exitPrice > position.entryPrice * 1000) {
        // Подозрительно большая цена - используем peakPrice если он разумный, иначе currentPrice
        // Если peakPrice тоже подозрительно большой, используем currentPrice
        const peakMultiplier = position.peakPrice / position.entryPrice;
        if (peakMultiplier > 0 && peakMultiplier <= 1000 && position.peakPrice > 0) {
          safeExitPrice = position.peakPrice;
          console.error(`⚠️ Suspicious exitPrice: ${exitPrice} (${(exitPrice/position.entryPrice).toFixed(2)}x), using peakPrice: ${safeExitPrice} (${peakMultiplier.toFixed(2)}x)`);
        } else if (position.currentPrice && position.currentPrice > 0 && position.currentPrice <= position.entryPrice * 1000) {
          safeExitPrice = position.currentPrice;
          console.error(`⚠️ Suspicious exitPrice: ${exitPrice}, using currentPrice: ${safeExitPrice}`);
        } else {
          // Все цены подозрительные - используем разумный cap (100x)
          safeExitPrice = position.entryPrice * 100;
          console.error(`⚠️ All prices suspicious, capping at 100x: ${safeExitPrice}`);
        }
      }
      
      // Пересчитываем multiplier с безопасной ценой
      const safeMultiplier = safeExitPrice / position.entryPrice;
      
      // Защита от некорректных значений investedAmount
      let safeInvested = investedAmount;
      if (investedAmount > 1.0 || investedAmount < 0 || !isFinite(investedAmount)) {
        console.error(`⚠️ Invalid investedAmount: ${investedAmount}, using fallback`);
        safeInvested = 0.003;
      }
      
      // ISSUE #1 FIX: Calculate grossReturn first, then deduct exitFees
      // grossReturn = investedAmount * multiplier
      let grossReturn = safeInvested * safeMultiplier;
      
      // Защита от нереально больших grossReturn
      // Максимальный разумный multiplier для pump.fun токенов: 1000x (очень редкий случай)
      // Но если multiplier > 1000, это скорее всего ошибка bonding curve
      if (safeMultiplier > 1000) {
        // Подозрительно большой multiplier - используем peakPrice если он разумный
        const peakMultiplier = position.peakPrice / position.entryPrice;
        if (peakMultiplier > 0 && peakMultiplier <= 1000 && position.peakPrice > 0) {
          // Используем peakPrice для расчета
          grossReturn = safeInvested * peakMultiplier;
          console.error(`⚠️ Multiplier ${safeMultiplier.toFixed(2)}x too high, using peakMultiplier ${peakMultiplier.toFixed(2)}x`);
        } else {
          // Cap at 1000x (максимальный разумный multiplier)
          grossReturn = safeInvested * 1000;
          console.error(`⚠️ Multiplier ${safeMultiplier.toFixed(2)}x too high, capping at 1000x`);
        }
      }
      
      // Deduct exit fees from gross return
      let proceeds = grossReturn - exitFee;
      
      // Ensure proceeds >= 0
      if (proceeds < 0) {
        proceeds = 0;
      }
      
      // ISSUE #1 FIX: Release funds and add back (grossReturn - exitFees) to deposit
      // proceeds already has exitFees deducted
      this.account.release(reservedAmount, proceeds);
      
      // Update safety manager with new balance (for drawdown tracking and profit lock)
      this.safetyManager.updateSessionBalance(this.account.getTotalBalance());
      
      // Calculate profit for logging
      const profit = proceeds - reservedAmount;
      
      // TIMING ANALYSIS: Extract timing data for hypothesis validation
      const timingData = (position as any).timingData || {};
      const tokenAgeAtEntry = timingData.tokenAgeAtOpen || 0;
      const tokenAgeAtExit = (Date.now() - (timingData.tokenCreatedAt || position.entryTime)) / 1000;
      const holdDuration = (Date.now() - position.entryTime) / 1000;
      
      // Удаляем из активных
      this.positions.delete(position.token);
      position.status = 'closed';

      // Non-blocking trade logging
      const tradeId = (position as any).tradeId || `unknown-${position.token}`;
      tradeLogger.logTradeClose({
        tradeId,
        token: position.token,
        exitPrice,
        multiplier,
        profitSol: profit,
        reason,
      });

      // Enhanced logger with timing analysis for hypothesis validation
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'sell',
        token: position.token,
        exitPrice,
        multiplier,
        profitSol: profit,
        reason,
        message: `Position closed: ${position.token.substring(0, 8)}..., ${safeMultiplier.toFixed(2)}x, profit=${profit.toFixed(6)} SOL, reason=${reason} | TIMING ANALYSIS: Entry age: ${tokenAgeAtEntry.toFixed(2)}s, Exit age: ${tokenAgeAtExit.toFixed(2)}s, Hold: ${holdDuration.toFixed(2)}s, Entry price: ${position.entryPrice.toFixed(8)}, Exit price: ${exitPrice.toFixed(8)}`,
      });

    } catch (error) {
      this.positions.delete(position.token);
      position.status = 'closed';
    }
  }

  /**
   * Получает текущую цену токена (использует кэш если доступен)
   * Используется только для fallback, основная цена обновляется через updateAllPrices
   */
  private async getCurrentPrice(token: string): Promise<number> {
    const position = this.positions.get(token);
    if (position?.currentPrice && position.currentPrice > 0) {
      return position.currentPrice;
    }
    return position?.entryPrice || 0;
  }

  /**
   * Централизованное обновление цен для всех позиций
   */
  private async updateAllPrices(): Promise<void> {
    if (this.positions.size === 0) return;

    const tokens = Array.from(this.positions.keys());
    const prices = await priceFetcher.getPricesBatch(tokens);

    // Кэшируем в объектах позиций и сохраняем историю для расчета импульса
    const now = Date.now();
    for (const token of tokens) {
      const position = this.positions.get(token);
      if (position && position.status === 'active') {
        const price = prices.get(token);
        
        if (price && price > 0) {
          // Сохраняем историю цен для расчета импульса
          if (!position.priceHistory) {
            position.priceHistory = [];
          }
          
          // Добавляем новую цену
          position.priceHistory.push({ price, timestamp: now });
          
          // Ограничиваем историю последними MAX_PRICE_HISTORY значениями
          if (position.priceHistory.length > MAX_PRICE_HISTORY) {
            position.priceHistory.shift();
          }
          
          position.currentPrice = price;
        } else {
          // При ошибке используем entryPrice
          position.currentPrice = position.entryPrice;
        }
      }
    }
  }

  /**
   * Рассчитывает прогнозируемую цену на основе импульса
   * @param position - позиция для расчета
   * @returns прогнозируемая цена или null если недостаточно данных
   */
  private calculatePredictedPrice(position: Position): number | null {
    if (!position.priceHistory || position.priceHistory.length < 2) {
      return null; // Недостаточно данных для расчета импульса
    }

    const history = position.priceHistory;
    const lastPrice = history[history.length - 1];
    const previousPrice = history[history.length - 2];
    
    // Рассчитываем скорость изменения цены (импульс)
    const timeDelta = (lastPrice.timestamp - previousPrice.timestamp) / 1000; // в секундах
    if (timeDelta <= 0) {
      return null; // Некорректные данные
    }
    
    const priceDelta = lastPrice.price - previousPrice.price;
    const velocity = priceDelta / timeDelta; // изменение цены в секунду
    
    // Рассчитываем время с последнего обновления
    const timeSinceLastUpdate = (Date.now() - lastPrice.timestamp) / 1000; // в секундах
    
    // Прогнозируемая цена = последняя цена + (импульс * время с последнего обновления)
    const predictedPrice = lastPrice.price + (velocity * timeSinceLastUpdate);
    
    // Защита от отрицательных или некорректных значений
    if (predictedPrice <= 0 || !isFinite(predictedPrice)) {
      return null;
    }
    
    return predictedPrice;
  }

  /**
   * Получает статистику активных позиций
   */
  getStats(): PositionStats {
    const activePositions = Array.from(this.positions.values()).filter(p => p.status === 'active');
    const positions = activePositions.map(p => ({
      token: p.token.slice(0, 8) + '...',
      multiplier: p.currentPrice ? (p.currentPrice / p.entryPrice).toFixed(2) + 'x' : '1.00x',
      age: `${Math.floor((Date.now() - p.entryTime) / 1000)}s`,
    }));

    // Исправление баланса (используем централизованный метод)
    this.fixBalanceDesync();

    return {
      activePositions: activePositions.length,
      availableSlots: config.maxOpenPositions - activePositions.length,
      positions,
    };
  }

  /**
   * Получает текущий депозит
   */
  getCurrentDeposit(): number {
    return this.account.getTotalBalance();
  }

  /**
   * Получает пиковый депозит
   */
  getPeakDeposit(): number {
    return this.account.getPeakBalance();
  }

  /**
   * Закрывает все позиции (для graceful shutdown)
   */
  async closeAllPositions(): Promise<void> {
    const positions = Array.from(this.positions.values());
    
    for (const position of positions) {
      if (position.status === 'active') {
        const exitPrice = position.currentPrice || position.entryPrice;
        await this.closePosition(position, 'shutdown', exitPrice);
      }
    }
  }
}

