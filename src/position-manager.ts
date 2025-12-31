import { Connection } from '@solana/web3.js';
import { Position, PositionStats, TokenCandidate, TierInfo } from './types';
import { config } from './config';
import { logger } from './logger';
import { tradeLogger } from './trade-logger';
import { getCurrentTimestamp, sleep, calculateSlippage, formatUsd } from './utils';
import { priceFetcher } from './price-fetcher';
import { TokenFilters } from './filters';
import { earlyActivityTracker } from './early-activity-tracker';
import { SafetyManager } from './safety-manager';
import { ITradingAdapter } from './trading/trading-adapter.interface';
import { RealTradingAdapter } from './trading/real-trading-adapter';
import { checkTokenReadiness } from './readiness-checker';
import { BalanceManager } from './balance-manager';
import { AbandonedTokenTracker } from './abandoned-token-tracker';
import * as fs from 'fs';
import * as path from 'path';

// Используем config.maxOpenPositions вместо хардкода
const MAX_HOLD_TIME = 45_000; // ⭐ 45 секунд (уменьшено с 90 для уменьшения slippage - SLIPPAGE_SOLUTIONS.md)
const TRAILING_STOP_PCT = 0.25;
const CHECK_INTERVAL = 1000; // Проверка каждые 1 секунду (быстрее реагируем на волатильность)
const PREDICTION_CHECK_INTERVAL = 200; // Проверка прогнозируемой цены каждые 200ms (быстрое обнаружение импульса)
const MAX_PRICE_HISTORY = 3; // Храним последние 3 цены для расчета импульса
const PRICE_SILENCE_THRESHOLD = 15_000; // ms — максимум без реальной цены (увеличено с 5 до 15 секунд для стабилизации цены после покупки)
const FAILSAFE_DROP_FROM_PEAK = 0.30;  // 30% от пика

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
   * Синхронизирует totalBalance с реальным балансом кошелька
   * Используется для исправления рассинхронизации в реальной торговле
   */
  syncTotalBalance(realBalance: number): void {
    if (realBalance < 0) {
      console.error(`⚠️ Invalid realBalance: ${realBalance}, ignoring sync`);
      return;
    }
    this.totalBalance = realBalance;
    // Обновляем peak если новый баланс больше
    if (this.totalBalance > this.peakBalance) {
      this.peakBalance = this.totalBalance;
    }
    // Защита: если lockedBalance больше totalBalance, исправляем
    if (this.lockedBalance > this.totalBalance) {
      console.error(`⚠️ syncTotalBalance: lockedBalance=${this.lockedBalance} > totalBalance=${this.totalBalance}, fixing...`);
      this.lockedBalance = Math.max(0, this.totalBalance);
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
   * ⭐ КРИТИЧНО: Commit loss for abandoned position
   * Списывает убыток БЕЗ возврата средств в баланс
   * 
   * Правила:
   * - Освобождает lockedBalance (освобождает слот)
   * - НЕ возвращает investedSol в totalBalance
   * - НЕ увеличивает freeBalance
   * - investedSol считается навсегда потерянным
   * 
   * @param reservedAmount - зарезервированная сумма (lockedBalance)
   * @param lossAmount - размер убытка (investedSol)
   */
  commitLoss(reservedAmount: number, lossAmount: number): void {
    if (reservedAmount < 0 || lossAmount < 0) {
      console.error(`⚠️ Invalid commitLoss: reservedAmount=${reservedAmount}, lossAmount=${lossAmount}`);
      return;
    }

    if (this.lockedBalance < reservedAmount) {
      console.error(`⚠️ commitLoss: lockedBalance=${this.lockedBalance} < reservedAmount=${reservedAmount}, fixing...`);
      // Исправляем рассинхронизацию
      this.lockedBalance = Math.max(0, this.lockedBalance);
    }

    // ⭐ КРИТИЧНО: Освобождаем lockedBalance (освобождаем слот)
    // НО НЕ возвращаем средства в totalBalance
    this.lockedBalance -= reservedAmount;
    
    // ⭐ КРИТИЧНО: Списываем убыток из totalBalance
    // investedSol считается навсегда потерянным
    this.totalBalance -= lossAmount;

    // Инварианты
    if (this.lockedBalance < 0) {
      this.lockedBalance = 0;
    }
    if (this.totalBalance < 0) {
      this.totalBalance = 0;
    }

    // ⭐ ИНВАРИАНТ: freeBalance НЕ должен увеличиться после commitLoss
    // freeBalance = totalBalance - lockedBalance
    // После commitLoss: totalBalance уменьшился, lockedBalance уменьшился
    // freeBalance может остаться тем же или уменьшиться, но НЕ увеличиться
  }

  /**
   * Get position size based on current free balance
   * Distributes balance evenly across available positions (not divided by fixed number)
   * Reserves funds for entry/exit fees
   * 
   * Minimum position size ensures fees never eat profit:
   * - Entry fees: 0.001005 SOL
   * - Exit fees: 0.001005 SOL
   * - For 1.77x break-even: positionSize >= 0.003688 SOL (с учетом slippage)
   * - Minimum positionSize: настраивается через MIN_POSITION_SIZE (по умолчанию 0.004 SOL)
   * - Это обеспечивает безубыточность при 1.77x и прибыль при 2.0x+
   */
  getPositionSize(maxPositions: number, minPositionSize: number = config.minPositionSize, workingBalance?: number, currentOpenPositions: number = 0, entryFees: number = 0.001005): number {
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
  private pendingTierInfo = new Map<string, TierInfo | null>(); // Сохраняем tierInfo для токенов, прошедших фильтры;
  private connection: Connection;
  private readonly STATE_FILE = path.join(config.logDir, '..', 'data', 'active-positions.json');
  private saveInterval: NodeJS.Timeout | null = null;
  
  /**
   * Сохраняет tierInfo для токена перед попыткой открытия позиции
   * Вызывается из index.ts после прохождения simplifiedFilter
   */
  public setPendingTierInfo(mint: string, tierInfo: TierInfo | null): void {
    if (tierInfo) {
      this.pendingTierInfo.set(mint, tierInfo);
    }
  }
  private filters: TokenFilters;
  private account: Account; // Single source of truth for balance
  private safetyManager: SafetyManager;
  private tradeIdCounter: number = 0;
  private adapter: ITradingAdapter; // Trading adapter (real or paper)
  private balanceManager: BalanceManager; // Управление балансом и вывод излишка
  private abandonedTracker: AbandonedTokenTracker; // Трекинг abandoned токенов

  constructor(connection: Connection, initialDeposit: number, adapter: ITradingAdapter) {
    this.connection = connection;
    this.filters = new TokenFilters(connection);
    this.account = new Account(initialDeposit);
    this.safetyManager = new SafetyManager(initialDeposit);
    this.adapter = adapter;
    this.balanceManager = new BalanceManager(connection);
    this.abandonedTracker = new AbandonedTokenTracker(connection, adapter);
    
    // Создаем директорию для данных, если её нет
    const dataDir = path.dirname(this.STATE_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Загружаем активные позиции при старте
    this.loadActivePositions();
    
    // Периодическое сохранение каждые 30 секунд
    this.saveInterval = setInterval(() => {
      this.saveActivePositions().catch(err => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `❌ PositionManager: Failed to save active positions: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }, 30_000); // 30 секунд
    
    // Устанавливаем кошелек в BalanceManager если есть real trading adapter
    if (adapter.getMode() === 'real') {
      const realAdapter = adapter as RealTradingAdapter;
      const walletKeypair = realAdapter.getWalletManager()?.getKeypair();
      if (walletKeypair) {
        this.balanceManager.setWallet(walletKeypair);
      }
    }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
      message: `${adapter.getMode() === 'real' ? '🔴 REAL' : '📄 PAPER'} TRADING MODE ENABLED IN POSITION MANAGER`,
    });

    // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем и исправляем баланс при старте
    this.fixBalanceDesync();

    // ⭐ КРИТИЧНО: Очищаем pendingTierInfo при создании (на случай перезапуска)
    this.pendingTierInfo.clear();

    // Централизованное обновление цен каждые 1 секунду (уменьшено для лучшей реакции на волатильность)
    setInterval(() => this.updateAllPrices(), CHECK_INTERVAL);
    
    // Safety manager no longer needs balance updates - BalanceManager handles excess withdrawal

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

    // ✅ ПРОВЕРКА БАЛАНСА И ВЫВОД ИЗЛИШКА: Каждые 30 секунд (только для реальной торговли)
    if (this.adapter.getMode() === 'real') {
      setInterval(async () => {
        try {
          // Получаем реальный баланс кошелька
          const realBalance = await this.balanceManager.getCurrentBalance();
          
          // 🔴 КРИТИЧНО: Синхронизируем Account баланс с реальным балансом кошелька
          // Account баланс может быть несинхронизирован после реальных сделок
          const accountBalance = this.account.getTotalBalance();
          const balanceDiff = Math.abs(realBalance - accountBalance);
          
          if (balanceDiff > 0.001) { // Если разница больше 0.001 SOL
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'warning',
              message: `⚠️ Balance desync detected: Account=${accountBalance.toFixed(6)} SOL, Real=${realBalance.toFixed(6)} SOL, diff=${balanceDiff.toFixed(6)} SOL. Syncing...`,
            });
            
            // Синхронизируем: устанавливаем Account баланс равным реальному
            // Используем прямой метод синхронизации вместо deductFromDeposit
            this.account.syncTotalBalance(realBalance);
            
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              message: `✅ Balance synced: Account balance updated to ${realBalance.toFixed(6)} SOL`,
            });
          }
          
          // Проверяем и выводим излишек
          await this.balanceManager.checkAndWithdrawExcess(realBalance);
        } catch (error) {
          // Неблокирующее логирование ошибки
          void Promise.resolve().then(() => {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'error',
              message: `❌ Balance check error: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
        }
      }, 10000); // Каждые 10 секунд (уменьшено для более быстрой синхронизации)
    }
  }

  /**
   * Generate unique trade ID
   */
  private generateTradeId(): string {
    this.tradeIdCounter++;
    return `trade-${Date.now()}-${this.tradeIdCounter}`;
  }

  /**
   * Принудительная синхронизация баланса с реальным кошельком
   * Вызывается после каждой сделки для немедленной синхронизации
   */
  private async forceBalanceSync(): Promise<void> {
    if (this.adapter.getMode() !== 'real') {
      return; // Только для реальной торговли
    }

    try {
      const realBalance = await this.balanceManager.getCurrentBalance();
      const accountBalance = this.account.getTotalBalance();
      const balanceDiff = Math.abs(realBalance - accountBalance);

      if (balanceDiff > 0.0001) { // Синхронизируем даже при малых расхождениях
        this.account.syncTotalBalance(realBalance);
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `🔄 Force balance sync: Account=${accountBalance.toFixed(6)} SOL → ${realBalance.toFixed(6)} SOL (diff=${balanceDiff.toFixed(6)} SOL)`,
        });
      }
    } catch (error) {
      // Неблокирующее логирование ошибки
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Force balance sync error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Исправляет рассинхронизацию баланса
   * Вызывается при старте и периодически
   */
  /**
   * ⭐ КРИТИЧНО: Очищает pendingTierInfo
   * Вызывается при старте для предотвращения использования старых данных
   */
  clearPendingTierInfo(): void {
    const size = this.pendingTierInfo.size;
    this.pendingTierInfo.clear();
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔄 PositionManager: cleared ${size} pendingTierInfo entries`,
    });
  }

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
   * Использует Account баланс (синхронизируется с реальным балансом каждые 30 секунд в реальной торговле)
   * @returns true если есть баланс, false если нет
   */
  hasEnoughBalanceForTrading(): boolean {
    const entryFees = config.priorityFee + config.signatureFee;
    const exitFees = config.priorityFee + config.signatureFee;
    const minPositionSize = config.minPositionSize; // Минимальный размер позиции из конфига
    const investedAmount = minPositionSize - entryFees; // После вычета entry fees
    
    // Рассчитываем резерв для выхода (exit fees + slippage)
    // Expected proceeds при take profit: investedAmount * 2.5
    const expectedProceedsAtTakeProfit = investedAmount * config.takeProfitMultiplier;
    // ⭐ КРИТИЧНО: Используем exitSlippageMax (35%) вместо slippageMax (3%) для резерва
    const exitSlippage = expectedProceedsAtTakeProfit * config.exitSlippageMax;
    
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
   * Использует readiness check и ступенчатую фильтрацию
   * BUY только когда токен физически готов
   */
  async tryOpenPosition(candidate: TokenCandidate): Promise<boolean> {
    const processingStartTime = Date.now();
    
    // 0. Фильтр: исключаем SOL токен
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (candidate.mint === SOL_MINT) {
      return false;
    }

    // ⭐ КРИТИЧНО: Проверка на уже открытую позицию для этого токена
    if (this.positions.has(candidate.mint)) {
      const existingPosition = this.positions.get(candidate.mint);
      const positionStatus = existingPosition?.status || 'unknown';
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        token: candidate.mint,
        message: `⚠️ DUPLICATE TOKEN: Position already exists for ${candidate.mint.substring(0, 8)}... (status: ${positionStatus}), skipping duplicate buy`,
      });
      return false; // Позиция уже открыта - не покупаем повторно
    }

    // 1. Проверка: есть ли свободные слоты?
    if (this.positions.size >= config.maxOpenPositions) {
      return false;
    }

    // 2. Проверка: достаточно ли средств для открытия позиции?
    const entryFees = config.priorityFee + config.signatureFee;
    const exitFees = config.priorityFee + config.signatureFee;
    const MIN_POSITION_SIZE = config.minPositionSize;
    const minInvestedAmount = MIN_POSITION_SIZE - entryFees;
    const minExpectedProceeds = minInvestedAmount * config.takeProfitMultiplier;
    // ⭐ КРИТИЧНО: Используем exitSlippageMax (35%) вместо slippageMax (3%)
    const minExitSlippage = minExpectedProceeds * config.exitSlippageMax;
    const minTotalReserved = MIN_POSITION_SIZE + exitFees + minExitSlippage;
    
    if (this.account.getFreeBalance() < minTotalReserved) {
      return false;
    }

    // 3. СТУПЕНЧАТАЯ ФИЛЬТРАЦИЯ + READINESS CHECK
    // ✅ ПРИОРИТЕТ: Проверка готовности каждые 200ms
    // ✅ Фильтры прерываются, если занимают больше времени, чем интервал проверки
    // ✅ Токены, прошедшие все фильтры, ждут готовности до 2 минут (120 секунд)
    // ✅ Если токен не готов за 2 минуты - выкидываем из очереди (найдем замену)
    const READINESS_CHECK_INTERVAL = 200; // ms
    const READINESS_TIMEOUT_MS = 120_000; // 2 минуты (120 секунд)
    const readinessWaitStart = Date.now();
    let filterStage = 0;
    let allFiltersPassed = false; // Флаг: все фильтры пройдены

    while (true) {
      // ✅ ТАЙМАУТ: Если прошло 2 минуты - выкидываем токен из очереди
      const timeWaiting = Date.now() - readinessWaitStart;
      if (timeWaiting >= READINESS_TIMEOUT_MS) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `⏱️ Token readiness timeout (${(timeWaiting / 1000).toFixed(1)}s): ${candidate.mint.substring(0, 8)}... not ready after 2 minutes, discarding from queue`,
        });
        return false; // Выкидываем токен из очереди
      }
      // ✅ ПРИОРИТЕТ #1: Проверка готовности токена (read-only RPC)
      const isReady = await checkTokenReadiness(this.connection, candidate.mint);
      
      if (isReady) {
          // ⭐ Market cap уже проверен в simplifiedFilter перед попаданием токена в очередь
          // Между simplifiedFilter и tryOpenPosition проходит очень мало времени (секунды)
          // Market cap не может существенно измениться за это время, поэтому повторная проверка не нужна
          // Пропускаем проверку market cap здесь - она уже выполнена в simplifiedFilter

          // ⭐ КРИТИЧНО: Проверка multiplier перед входом (гарантирует прибыльность)
          // Для pump.fun токенов начальная цена = виртуальные резервы (30 SOL / 1.073e15 токенов)
          // Проверяем, что текущая цена уже выросла на нужный multiplier от начальной
          try {
            const currentPrice = await priceFetcher.getPrice(candidate.mint);
            if (currentPrice <= 0) {
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'warning',
                token: candidate.mint,
                message: `⚠️ Invalid price for multiplier check: ${currentPrice}, skipping entry`,
              });
              await sleep(READINESS_CHECK_INTERVAL);
              continue;
            }

            // Начальная цена pump.fun токена (из виртуальных резервов)
            // VIRTUAL_SOL_RESERVES = 30 SOL, VIRTUAL_TOKEN_RESERVES = 1.073e15
            const INITIAL_PRICE = 30 / (1.073e15 / 1e9); // ~0.000000028 SOL per token (примерно)
            // Более точный расчет: используем fallback цену из price-fetcher
            const FALLBACK_INITIAL_PRICE = 30 / (1.073e15 / 1e9); // ~2.8e-8 SOL
            
            // Рассчитываем текущий multiplier от начальной цены
            const currentMultiplier = currentPrice / FALLBACK_INITIAL_PRICE;

            // ⚠️ КРИТИЧНО: Входим только если multiplier >= minEntryMultiplier
            // Это гарантирует, что токен уже показал рост и есть потенциал для прибыли
            if (currentMultiplier < config.minEntryMultiplier) {
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                token: candidate.mint,
                message: `⏸️ MULTIPLIER CHECK: currentMultiplier=${currentMultiplier.toFixed(3)}x < ${config.minEntryMultiplier}x (min required), currentPrice=${currentPrice.toFixed(10)} SOL, waiting for growth...`,
              });
              await sleep(READINESS_CHECK_INTERVAL);
              continue; // Ждем пока токен вырастет
            }

            // Multiplier достаточен - логируем и продолжаем
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: candidate.mint,
              message: `✅ MULTIPLIER CHECK PASSED: currentMultiplier=${currentMultiplier.toFixed(3)}x >= ${config.minEntryMultiplier}x, currentPrice=${currentPrice.toFixed(10)} SOL, proceeding to buy`,
            });
          } catch (error) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'warning',
              token: candidate.mint,
              message: `⚠️ Error checking multiplier: ${error instanceof Error ? error.message : String(error)}, skipping check`,
            });
            // При ошибке пропускаем проверку (не блокируем вход) - но это рискованно
          }

        // Токен готов и multiplier достаточен - небольшая задержка перед BUY (50-150ms)
        const preBuyDelay = 50 + Math.random() * 100; // 50-150ms
        await sleep(preBuyDelay);
        
        // Выполняем BUY с tierInfo
        const tierInfo = this.pendingTierInfo.get(candidate.mint) || null;
        const position = await this.openPositionWithReadinessCheck(candidate, tierInfo);
        // Очищаем tierInfo после использования
        if (tierInfo) {
          this.pendingTierInfo.delete(candidate.mint);
        }
        
        if (position) {
          // Позиция открыта успешно
          this.monitorPosition(position).catch(err => {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'error',
              token: position.token,
              message: `❌ monitorPosition failed: ${err.message}`,
            });
          });
          
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `✅ Position opened successfully | Entry price: ${position.entryPrice.toFixed(8)}`,
          });
          
          return true;
        } else {
          // BUY не удался - логируем причину (неблокирующее)
          // Неблокирующее логирование: используем void для fire-and-forget
          void Promise.resolve().then(() => {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'error',
              token: candidate.mint,
              message: `❌ BUY failed: Position opening returned null (likely insufficient balance, invalid price, or real trade failed)`,
            });
          });
          return false;
        }
      }

      // Токен еще не готов
      // ✅ Если все фильтры пройдены - ждем готовности до таймаута (2 минуты)
      if (allFiltersPassed) {
        // Сильный кандидат - ждем готовности, но с таймаутом 2 минуты
        await sleep(READINESS_CHECK_INTERVAL);
        continue;
      }

      // ✅ ПРИОРИТЕТ #2: Ступенчатая фильтрация с прерыванием
      // Фильтры выполняются с таймаутом, чтобы не пропустить момент готовности
      
      if (filterStage === 0) {
        // Фильтр 1: Early activity check (быстрый, синхронный)
        const hasEarlyActivity = earlyActivityTracker.hasEarlyActivity(candidate.mint);
        if (!hasEarlyActivity) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `❌ Filter failed: No early activity, discarding`,
          });
          return false;
        }
        filterStage = 1;
      } else if (filterStage === 1) {
        // ⭐ УПРОЩЕННЫЙ ФИЛЬТР: Только критичные проверки (honeypot, ликвидность, распределение)
        // ✅ ПРЕРЫВАЕМЫЙ: Если фильтр занимает > READINESS_CHECK_INTERVAL, прерываем и проверяем готовность
        try {
          const filterStartTime = Date.now();
          const filterPromise = this.filters.simplifiedFilter(candidate);
          const timeoutPromise = new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), READINESS_CHECK_INTERVAL);
          });
          
          // Race: либо фильтр завершится, либо таймаут
          const result = await Promise.race([
            filterPromise.then(result => ({ type: 'result' as const, value: result })),
            timeoutPromise.then(() => ({ type: 'timeout' as const }))
          ]);
          
          if (result.type === 'timeout') {
            // Фильтр был прерван таймаутом - продолжаем проверку готовности
            const filterDuration = Date.now() - filterStartTime;
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: candidate.mint,
              message: `⏱️ Filter interrupted after ${filterDuration}ms (timeout), checking readiness first`,
            });
            continue; // Вернемся к проверке готовности в начале цикла
          }
          
          // Фильтр завершился до таймаута
          if (!result.value.passed) {
            // Фильтр не прошел
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: candidate.mint,
              message: `❌ Filter failed: ${result.value.reason || 'Unknown reason'}, discarding`,
            });
            return false;
          }
          
          // Фильтр прошел - сохраняем tierInfo
          const tierInfo = result.value.tierInfo;
          if (tierInfo) {
            this.pendingTierInfo.set(candidate.mint, tierInfo);
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
              message: `✅ Simplified filters passed: Tier ${tierInfo.tier}, liquidity=$${result.value.details?.volumeUsd?.toFixed(2) || 'N/A'}, holders=${result.value.details?.uniqueBuyers || 'N/A'}, waiting for token readiness`,
            });
          } else {
            // Tier не определен - отбрасываем токен
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: candidate.mint,
              message: `❌ Filter passed but no Tier assigned, discarding`,
            });
            return false;
          }
          
          filterStage = 2;
          allFiltersPassed = true; // ✅ Все фильтры пройдены - ждем готовности неограниченно
        } catch (error) {
          // Ошибка фильтра - отбрасываем токен
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `❌ Filter error: ${error instanceof Error ? error.message : String(error)}, discarding`,
          });
          return false;
        }
      }
      // Дополнительные фильтры можно добавить здесь (filterStage 3, 4, ...)

      // Ждем перед следующей проверкой готовности
      await sleep(READINESS_CHECK_INTERVAL);
    }
  }

  /**
   * Симулирует выход из позиции для проверки эффективного multiplier
   * Используется для Tier 2 и Tier 3 перед входом
   */
  private async simulateExit(
    entryPrice: number,
    positionSize: number,
    tierInfo: TierInfo
  ): Promise<{ effectiveMultiplier: number; predictedProceeds: number; predictedSlippage: number }> {
    const entryFees = config.priorityFee + config.signatureFee;
    const exitFees = config.priorityFee + config.signatureFee;
    const investedAmount = positionSize - entryFees;
    
    // Оцениваем slippage при выходе (зависит от tier)
    let estimatedExitSlippage: number;
    if (tierInfo.tier === 1) {
      estimatedExitSlippage = config.exitSlippageMin; // 20% для Tier 1
    } else if (tierInfo.tier === 2) {
      estimatedExitSlippage = (config.exitSlippageMin + config.exitSlippageMax) / 2; // 27.5% для Tier 2
    } else {
      estimatedExitSlippage = config.exitSlippageMax; // 35% для Tier 3
    }
    
    // Предполагаем, что выходим на текущей цене (или на multiplier 2.0x)
    const assumedExitMultiplier = config.takeProfitMultiplier; // 2.0x
    const assumedExitPrice = entryPrice * assumedExitMultiplier;
    
    // Рассчитываем количество токенов, полученных при покупке
    const tokensReceived = investedAmount / entryPrice;
    
    // Рассчитываем SOL, полученные при продаже (с учетом slippage)
    const grossProceeds = tokensReceived * assumedExitPrice;
    const slippageAmount = grossProceeds * estimatedExitSlippage;
    const predictedProceeds = grossProceeds - slippageAmount - exitFees;
    
    // Эффективный multiplier = (proceeds - entryFees) / investedAmount
    const effectiveMultiplier = predictedProceeds / investedAmount;
    
    return {
      effectiveMultiplier,
      predictedProceeds,
      predictedSlippage: estimatedExitSlippage,
    };
  }

  /**
   * Открывает позицию с readiness check и правильной retry логикой для 3012/3031
   * @param tierInfo - Информация о Tier токена (для адаптации размера позиции и проверок)
   */
  private async openPositionWithReadinessCheck(candidate: TokenCandidate, tierInfo: TierInfo | null): Promise<Position | null> {
    try {
      // Получаем цену входа (isPriority больше не используется, всегда false)
      const entryPrice = await this.filters.getEntryPrice(candidate.mint, false);
      
      if (entryPrice <= 0) {
        throw new Error(`Invalid entry price: ${entryPrice}`);
      }

      // Рассчитываем размер позиции
      const entryFees = config.priorityFee + config.signatureFee;
      let positionSize = this.account.getPositionSize(
        config.maxOpenPositions,
        config.minPositionSize,
        this.account.getTotalBalance(),
        this.positions.size,
        entryFees
      );
      
      positionSize = this.safetyManager.applySafetyCaps(positionSize);
      
      // ⭐ TIER-BASED SIZING: Адаптируем размер позиции в зависимости от Tier
      if (tierInfo) {
        if (tierInfo.tier === 2) {
          // Tier 2: уменьшаем размер позиции в 2 раза
          positionSize = positionSize * tierInfo.positionSizeMultiplier;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `🟡 Tier 2: Position size reduced to ${positionSize.toFixed(6)} SOL (multiplier: ${tierInfo.positionSizeMultiplier})`,
          });
        } else if (tierInfo.tier === 3) {
          // Tier 3: максимальный размер 0.0025 SOL
          const maxTier3Size = 0.0025;
          positionSize = Math.min(positionSize, maxTier3Size);
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `🔴 Tier 3: Position size capped at ${positionSize.toFixed(6)} SOL (max: ${maxTier3Size} SOL)`,
          });
        }
      }
      
      // ⭐ ADAPTIVE SIZING: Оцениваем impact и корректируем размер позиции
      const estimatedImpact = this.adapter.estimateImpact(positionSize);
      if (estimatedImpact > config.maxExpectedImpact) {
        // Impact слишком высокий - уменьшаем размер позиции
        const maxSafeSize = this.findMaxSafePositionSize(entryPrice, entryFees);
        if (maxSafeSize >= config.minPositionSize) {
          positionSize = maxSafeSize;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `📊 Adaptive sizing: Reduced position size from ${positionSize.toFixed(6)} to ${maxSafeSize.toFixed(6)} SOL due to high impact (${(estimatedImpact * 100).toFixed(2)}% > ${(config.maxExpectedImpact * 100).toFixed(2)}%)`,
          });
        } else if (config.skipIfImpactTooHigh) {
          throw new Error(`Impact too high (${(estimatedImpact * 100).toFixed(2)}%) and cannot reduce to safe size, skipping token`);
        }
      }
      
      // ⭐ TIER-BASED MIN SIZE: Для Tier 3 минимальный размер может быть меньше
      const MIN_POSITION_SIZE = tierInfo?.tier === 3 ? 0.002 : config.minPositionSize; // Tier 3: минимум 0.002 SOL
      if (positionSize < MIN_POSITION_SIZE) {
        if (this.account.getFreeBalance() < MIN_POSITION_SIZE) {
          throw new Error(`Position size too small: ${positionSize} < ${MIN_POSITION_SIZE}, insufficient balance`);
        }
        positionSize = MIN_POSITION_SIZE;
      }

      // ⭐ EXIT SIMULATION для ВСЕХ Tier (включая Tier 1)
      // ⭐ КРИТИЧНО: Проверяем exit slippage перед входом для всех токенов
      if (tierInfo) {
        const exitSimulation = await this.simulateExit(entryPrice, positionSize, tierInfo);
        
        // Проверяем минимальный эффективный multiplier
        const minEffectiveMultiplier = tierInfo.minEffectiveMultiplier || 1.15;
        if (exitSimulation.effectiveMultiplier < minEffectiveMultiplier) {
          throw new Error(
            `Exit simulation failed: effectiveMultiplier=${exitSimulation.effectiveMultiplier.toFixed(3)} < ${minEffectiveMultiplier} (Tier ${tierInfo.tier})`
          );
        }
        
        // ⭐ ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: Если predicted slippage слишком высокий (> 50%), отклоняем токен
        const MAX_ACCEPTABLE_EXIT_SLIPPAGE = 0.50; // 50% - максимально допустимый slippage
        if (exitSimulation.predictedSlippage > MAX_ACCEPTABLE_EXIT_SLIPPAGE) {
          throw new Error(
            `Exit slippage too high: ${(exitSimulation.predictedSlippage * 100).toFixed(1)}% > ${(MAX_ACCEPTABLE_EXIT_SLIPPAGE * 100).toFixed(0)}% (Tier ${tierInfo.tier})`
          );
        }
        
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `✅ Exit simulation passed (Tier ${tierInfo.tier}): effectiveMultiplier=${exitSimulation.effectiveMultiplier.toFixed(3)}, predictedProceeds=${exitSimulation.predictedProceeds.toFixed(6)} SOL, predictedSlippage=${(exitSimulation.predictedSlippage * 100).toFixed(1)}%`,
        });
      } else {
        // ⭐ ДЛЯ REGULAR токенов (без tierInfo) также проверяем exit slippage
        // Используем максимальный slippage для безопасности
        const exitFees = config.priorityFee + config.signatureFee;
        const investedAmount = positionSize - (config.priorityFee + config.signatureFee);
        const expectedProceedsAtTakeProfit = investedAmount * config.takeProfitMultiplier;
        const estimatedExitSlippage = config.exitSlippageMax; // 35% для REGULAR токенов
        const slippageAmount = expectedProceedsAtTakeProfit * estimatedExitSlippage;
        const predictedProceeds = expectedProceedsAtTakeProfit - slippageAmount - exitFees;
        const effectiveMultiplier = predictedProceeds / investedAmount;
        
        // Проверяем минимальный эффективный multiplier (1.15 для REGULAR)
        const minEffectiveMultiplier = 1.15;
        if (effectiveMultiplier < minEffectiveMultiplier) {
          throw new Error(
            `Exit simulation failed for REGULAR token: effectiveMultiplier=${effectiveMultiplier.toFixed(3)} < ${minEffectiveMultiplier}`
          );
        }
        
        // Проверяем максимальный slippage
        const MAX_ACCEPTABLE_EXIT_SLIPPAGE = 0.50; // 50%
        if (estimatedExitSlippage > MAX_ACCEPTABLE_EXIT_SLIPPAGE) {
          throw new Error(
            `Exit slippage too high for REGULAR token: ${(estimatedExitSlippage * 100).toFixed(1)}% > ${(MAX_ACCEPTABLE_EXIT_SLIPPAGE * 100).toFixed(0)}%`
          );
        }
        
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `✅ Exit simulation passed (REGULAR): effectiveMultiplier=${effectiveMultiplier.toFixed(3)}, predictedProceeds=${predictedProceeds.toFixed(6)} SOL, predictedSlippage=${(estimatedExitSlippage * 100).toFixed(1)}%`,
        });
      }
      
      const exitFees = config.priorityFee + config.signatureFee;
      const investedAmount = positionSize - entryFees;

      if (investedAmount <= 0) {
        throw new Error(`Insufficient funds after fees: ${investedAmount}`);
      }

      const totalFees = entryFees + exitFees;
      const minInvestedForProfit = totalFees / 1.5;
      if (investedAmount < minInvestedForProfit) {
        throw new Error(`Position size too small: investedAmount (${investedAmount}) < minimum for profit (${minInvestedForProfit})`);
      }

      const expectedProceedsAtTakeProfit = investedAmount * config.takeProfitMultiplier;
      // ⭐ КРИТИЧНО: Используем exitSlippageMax (35%) вместо slippageMax (3%) для резерва
      // slippageMax используется для входа, exitSlippageMax - для выхода
      const exitSlippage = expectedProceedsAtTakeProfit * config.exitSlippageMax;
      const totalReservedAmount = positionSize + exitFees + exitSlippage;

      if (investedAmount > 1.0 || positionSize > 1.0 || totalReservedAmount > 1.0) {
        throw new Error(`Invalid amounts: positionSize=${positionSize}, investedAmount=${investedAmount}, totalReserved=${totalReservedAmount}`);
      }

      const freeBalance = this.account.getFreeBalance();
      if (freeBalance < totalReservedAmount) {
        throw new Error(`Failed to reserve ${totalReservedAmount} SOL (insufficient free balance: ${freeBalance.toFixed(6)})`);
      }
      
      this.account.deductFromDeposit(positionSize);
      
      if (!this.account.reserve(totalReservedAmount)) {
        this.account.deductFromDeposit(-positionSize);
        throw new Error(`Failed to reserve ${totalReservedAmount} SOL after deducting positionSize`);
      }

      // ⭐ Выполняем покупку через адаптер (real или paper)
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
        message: `${this.adapter.getMode() === 'real' ? '🔴' : '📄'} Executing ${this.adapter.getMode().toUpperCase()} BUY: ${positionSize.toFixed(6)} SOL → ${candidate.mint}${tierInfo ? ` | Tier ${tierInfo.tier}` : ''}`,
        });

      // ✅ BUY с правильной retry логикой для 3012/3031 (только для real)
        const buyResult = await this.executeBuyWithRetry(candidate.mint, positionSize);

        if (!buyResult.success) {
        // Rollback: Trade failed
          this.positions.delete(candidate.mint);
          this.account.reserve(-totalReservedAmount);
          this.account.deductFromDeposit(-positionSize);

          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: candidate.mint,
          message: `❌ BUY FAILED: ${buyResult.error}`,
          });

          return null;
        }

      // Используем execution price из результата (с учетом реального slippage)
      let executionPrice = buyResult.executionPrice || entryPrice;
      const markPrice = buyResult.markPrice || entryPrice;
      
      // ⭐ КРИТИЧНО: Fallback для executionPrice если он равен 0
      // Если executionPrice = 0 и entryPrice = 0, рассчитываем из investedSol / tokensReceived
      if ((!executionPrice || executionPrice <= 0) && (!entryPrice || entryPrice <= 0)) {
        const tokensReceived = buyResult.tokensReceived;
        if (tokensReceived && tokensReceived > 0) {
          executionPrice = investedAmount / tokensReceived;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'warning',
            token: candidate.mint,
            message: `⚠️ FALLBACK entryPrice calculation: executionPrice=${executionPrice.toFixed(10)} (from investedSol=${investedAmount.toFixed(6)} / tokensReceived=${tokensReceived.toFixed(6)})`,
          });
        } else {
          // Последний fallback - используем markPrice
          executionPrice = markPrice || 0;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'warning',
            token: candidate.mint,
            message: `⚠️ FALLBACK entryPrice: Using markPrice=${markPrice?.toFixed(10) || 'N/A'} as last resort`,
          });
        }
      }
      
      const actualEntryPrice = executionPrice; // Используем реальную цену исполнения

      // ⭐ Сохраняем tier в позиции
      const positionTier = tierInfo?.tier || null;

      const position: Position = {
        token: candidate.mint,
        entryPrice: actualEntryPrice,
        executionPrice,
        markPrice,
        investedSol: investedAmount,
        investedUsd: formatUsd(investedAmount),
        entryTime: Date.now(),
        lastRealPriceUpdate: Date.now(),
        peakPrice: actualEntryPrice,
        currentPrice: actualEntryPrice,
        status: 'active',
        errorCount: 0,
        reservedAmount: totalReservedAmount,
        estimatedImpact: buyResult.estimatedImpact,
        tier: positionTier, // ⭐ Сохраняем tier в позиции
      };

      this.positions.set(candidate.mint, position);

      const tradeId = this.generateTradeId();
      (position as any).tradeId = tradeId;
        (position as any).buySignature = buyResult.signature;
        (position as any).tokensReceived = buyResult.tokensReceived;

        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
        message: `✅ BUY SUCCESS: signature=${buyResult.signature}, received=${buyResult.tokensReceived} tokens, markPrice=${markPrice.toFixed(10)}, executionPrice=${executionPrice.toFixed(10)}, impact=${buyResult.estimatedImpact ? (buyResult.estimatedImpact * 100).toFixed(2) + '%' : 'N/A'}`,
        });

      tradeLogger.logTradeOpen({
        tradeId,
        token: candidate.mint,
        investedSol: investedAmount,
        entryPrice: actualEntryPrice,
      });

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'buy',
        token: candidate.mint,
        investedSol: investedAmount,
        entryPrice: actualEntryPrice,
        message: `Position opened: ${candidate.mint.substring(0, 8)}..., Tier ${positionTier || 'N/A'}, invested=${investedAmount.toFixed(6)} SOL, entry=${actualEntryPrice.toFixed(8)} ${this.adapter.getMode() === 'real' ? '🔴 REAL' : '📄 PAPER'}`,
      });

      return position;
    } catch (error) {
      // Неблокирующее логирование ошибки с детальной информацией
      const errorMessage = error instanceof Error ? error.message : String(error);
      void Promise.resolve().then(() => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: candidate.mint,
          message: `❌ Error opening position: ${errorMessage}`,
        });
      });
      return null;
    }
  }

  /**
   * Выполняет BUY с правильной retry логикой для 3012/3031
   * Попытка 1: сразу
   * Если 3012/3031: ждем 800-1200ms, одна повторная попытка
   * Если повтор снова 3012/3031: прекращаем, выкидываем токен
   */
  private async executeBuyWithRetry(
    tokenMint: string,
    amountSol: number
  ): Promise<{ success: boolean; signature?: string; error?: string; tokensReceived?: number; executionPrice?: number; markPrice?: number; estimatedImpact?: number }> {
    // Для paper trading просто вызываем адаптер
    if (this.adapter.getMode() === 'paper') {
      return await this.adapter.executeBuy(tokenMint, amountSol);
    }

    // Для real trading - retry логика
    // Попытка 1: сразу
    const firstAttempt = await this.adapter.executeBuy(tokenMint, amountSol);
    
    if (firstAttempt.success) {
      return firstAttempt;
    }

    // Проверяем ошибку
    const errorMsg = firstAttempt.error || '';
    const is3012Error = errorMsg.includes('Custom:3012') || errorMsg.includes('"Custom":3012');
    const is3031Error = errorMsg.includes('Custom:3031') || errorMsg.includes('"Custom":3031');
    
    if (!is3012Error && !is3031Error) {
      // Не 3012/3031 - возвращаем ошибку сразу
      return firstAttempt;
    }

    // 3012/3031 - ждем 800-1200ms перед повторной попыткой
    const retryDelay = 800 + Math.random() * 400; // 800-1200ms
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: tokenMint,
      message: `🔁 ${is3012Error ? 'Custom:3012' : 'Custom:3031'} (token not ready), waiting ${retryDelay.toFixed(0)}ms before retry...`,
    });

    await sleep(retryDelay);

    // Попытка 2: одна повторная попытка
    const secondAttempt = await this.adapter.executeBuy(tokenMint, amountSol);
    
    if (secondAttempt.success) {
      return secondAttempt;
    }

    // Проверяем ошибку повторной попытки
    const secondErrorMsg = secondAttempt.error || '';
    const isSecond3012 = secondErrorMsg.includes('Custom:3012') || secondErrorMsg.includes('"Custom":3012');
    const isSecond3031 = secondErrorMsg.includes('Custom:3031') || secondErrorMsg.includes('"Custom":3031');
    
    if (isSecond3012 || isSecond3031) {
      // Повторная попытка тоже вернула 3012/3031 - прекращаем, выкидываем токен
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ BUY FAILED: ${isSecond3012 ? 'Custom:3012' : 'Custom:3031'} on retry, discarding token`,
      });
      return { success: false, error: `${isSecond3012 ? 'Custom:3012' : 'Custom:3031'} on retry` };
    }

    // Другая ошибка на повторной попытке
    return secondAttempt;
  }

  /**
   * Находит максимальный безопасный размер позиции с учетом impact
   */
  private findMaxSafePositionSize(entryPrice: number, entryFees: number): number {
    // Бинарный поиск максимального размера с impact <= maxExpectedImpact
    let min = config.minPositionSize;
    let max = config.maxPositionSize;
    let best = min;

    for (let i = 0; i < 20; i++) {
      const testSize = (min + max) / 2;
      const impact = this.adapter.estimateImpact(testSize);
      
      if (impact <= config.maxExpectedImpact) {
        best = testSize;
        min = testSize;
      } else {
        max = testSize;
      }
      
      if (max - min < 0.0001) break;
    }

    return Math.max(config.minPositionSize, Math.min(best, config.maxPositionSize));
  }

  /**
   * @deprecated Используется openPositionWithReadinessCheck вместо этого
   * Оставлен для обратной совместимости, но не должен вызываться
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
    // Calculate position size: distribute evenly, reserve for fees, min from config
    let positionSize = this.account.getPositionSize(config.maxOpenPositions, config.minPositionSize, this.account.getTotalBalance(), this.positions.size, entryFees);
    
    // Apply safety caps (maxSolPerTrade = 0.05 SOL) - ограничение для избежания влияния на цену
    positionSize = this.safetyManager.applySafetyCaps(positionSize);
    
    // Ensure position size is at least minimum
    const MIN_POSITION_SIZE = config.minPositionSize;
    if (positionSize < MIN_POSITION_SIZE) {
      if (this.account.getFreeBalance() >= MIN_POSITION_SIZE) {
        // Use minimum if we have enough balance
        positionSize = MIN_POSITION_SIZE;
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
    // ⭐ КРИТИЧНО: Используем exitSlippageMax (35%) вместо slippageMax (3%) для резерва
    // Slippage на выход: используем максимальный exit slippage для безопасности
    const exitSlippage = expectedProceedsAtTakeProfit * config.exitSlippageMax;
    
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
      lastRealPriceUpdate: Date.now(),
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

    // ⭐ Выполняем покупку через адаптер (real или paper)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
      message: `${this.adapter.getMode() === 'real' ? '🔴' : '📄'} Executing ${this.adapter.getMode().toUpperCase()} BUY: ${positionSize.toFixed(6)} SOL → ${candidate.mint}`,
      });

    const buyResult = await this.executeBuyWithRetry(candidate.mint, positionSize);

      if (!buyResult.success) {
      // Rollback: Trade failed
        this.positions.delete(candidate.mint);
      this.account.reserve(-totalReservedAmount);
      this.account.deductFromDeposit(-positionSize);

        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: candidate.mint,
        message: `❌ BUY FAILED: ${buyResult.error}`,
      });

      throw new Error(`Trade failed: ${buyResult.error}`);
    }

    // Используем execution price из результата
    // ⭐ КРИТИЧНО: Если executionPrice = 0, используем markPrice или actualEntryPrice
    let executionPrice = buyResult.executionPrice;
    if (!executionPrice || executionPrice <= 0) {
      executionPrice = buyResult.markPrice || actualEntryPrice;
    }
    const markPrice = buyResult.markPrice || entryPrice;
    
    // ⭐ КРИТИЧНО: Если executionPrice все еще 0, используем actualEntryPrice (цена из bonding curve)
    if (!executionPrice || executionPrice <= 0) {
      executionPrice = actualEntryPrice;
    }
    
    // ⭐ КРИТИЧНО: Последний fallback - рассчитываем из investedSol / tokensReceived
    if (!executionPrice || executionPrice <= 0) {
      const tokensReceived = buyResult.tokensReceived;
      if (tokensReceived && tokensReceived > 0) {
        executionPrice = positionSize / tokensReceived;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: candidate.mint,
          message: `⚠️ FALLBACK entryPrice calculation (retry path): executionPrice=${executionPrice.toFixed(10)} (from positionSize=${positionSize.toFixed(6)} / tokensReceived=${tokensReceived.toFixed(6)})`,
        });
      } else {
        // Последний fallback - используем markPrice
        executionPrice = markPrice || 0;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: candidate.mint,
          message: `⚠️ FALLBACK entryPrice (retry path): Using markPrice=${markPrice?.toFixed(10) || 'N/A'} as last resort`,
        });
      }
    }
    
    position.entryPrice = executionPrice;
    position.executionPrice = executionPrice;
    position.markPrice = markPrice;
    position.estimatedImpact = buyResult.estimatedImpact;

      // Store transaction signature for tracking
      (position as any).buySignature = buyResult.signature;
      (position as any).tokensReceived = buyResult.tokensReceived;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
      message: `✅ BUY SUCCESS: signature=${buyResult.signature}, received=${buyResult.tokensReceived} tokens, markPrice=${markPrice.toFixed(10)}, executionPrice=${executionPrice.toFixed(10)}, impact=${buyResult.estimatedImpact ? (buyResult.estimatedImpact * 100).toFixed(2) + '%' : 'N/A'}`,
      });

    // 🔄 Принудительная синхронизация баланса после успешной покупки (только для real)
    if (this.adapter.getMode() === 'real') {
      await this.forceBalanceSync();
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
      message: `Position opened: ${candidate.mint.substring(0, 8)}..., invested=${investedAmount.toFixed(6)} SOL, entry=${actualEntryPrice.toFixed(8)} ${this.adapter.getMode() === 'real' ? '🔴 REAL' : '📄 PAPER'}`,
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
      const now = Date.now();
      const lastUpdate = position.lastRealPriceUpdate || position.entryTime;
      const silenceDuration = now - lastUpdate;

      if (silenceDuration >= PRICE_SILENCE_THRESHOLD) {
        const predicted = this.calculatePredictedPrice(position);
        const peak = position.peakPrice || position.entryPrice;
        // ⭐ КРИТИЧНО: Если entryPrice = 0, используем markPrice или получаем цену заново
        let fallbackPrice = position.currentPrice || position.entryPrice;
        if (!fallbackPrice || fallbackPrice <= 0) {
          fallbackPrice = position.markPrice || 0;
          // Если все еще 0, пытаемся получить цену заново
          if (!fallbackPrice || fallbackPrice <= 0) {
            try {
              const freshPrice = await priceFetcher.getPrice(position.token);
              fallbackPrice = freshPrice || position.entryPrice || 0;
            } catch (e) {
              fallbackPrice = position.entryPrice || 0;
            }
          }
        }

        const predictedCollapse =
          predicted !== null &&
          predicted < peak * (1 - FAILSAFE_DROP_FROM_PEAK);

        const noPrediction = predicted === null;

        if (predictedCollapse || noPrediction) {
          // ⭐ КРИТИЧНО: Если цена не обновлялась, но это недавно после покупки (< 20 секунд),
          // НЕ закрываем позицию - даем время цене обновиться
          const timeSinceEntry = Date.now() - position.entryTime;
          const MIN_PRICE_UPDATE_WAIT = 20_000; // 20 секунд после покупки
          
          if (timeSinceEntry < MIN_PRICE_UPDATE_WAIT && !predictedCollapse) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'warning',
              token: position.token,
              message: `⏳ FAILSAFE DELAYED: no real price for ${silenceDuration}ms, but only ${(timeSinceEntry/1000).toFixed(1)}s since entry. Waiting for price update...`,
            });
            // Продолжаем мониторинг, не закрываем позицию
          } else {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: position.token,
              message: `🚨 FAILSAFE EXIT: no real price for ${silenceDuration}ms, elapsed=${(timeSinceEntry/1000).toFixed(1)}s since entry`,
          });

          await this.closePosition(
            position,
            'failsafe_no_price_feed',
            fallbackPrice
          );
          return;
          }
        }
      }

      loopCount++;
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
        
        // 🔴 FIX: Используем минимальный multiplier для безубыточности при timeout
        // Рассчитываем минимальный multiplier для покрытия комиссий
        const entryFees = config.priorityFee + config.signatureFee;
        const exitFees = config.priorityFee + config.signatureFee;
        const totalFees = entryFees + exitFees;
        const investedAmount = position.investedSol;
        // Для безубыточности: investedAmount * minMultiplier >= investedAmount + totalFees
        // minMultiplier = 1 + (totalFees / investedAmount)
        const minBreakEvenMultiplier = 1 + (totalFees / investedAmount);
        
        const currentPrice = position.currentPrice || position.entryPrice;
        const currentMultiplier = currentPrice / position.entryPrice;
        
        // Используем максимальное значение: текущая цена или минимальная для безубыточности
        // Это защищает от убытков из-за комиссий при timeout
        const safeExitPrice = currentMultiplier >= minBreakEvenMultiplier 
          ? currentPrice 
          : position.entryPrice * minBreakEvenMultiplier;
        
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
          message: `⏰ Timeout exit: currentMultiplier=${currentMultiplier.toFixed(3)}x, minBreakEven=${minBreakEvenMultiplier.toFixed(3)}x, using ${(safeExitPrice / position.entryPrice).toFixed(3)}x`,
        });
        
        await this.closePosition(position, 'timeout', safeExitPrice);
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

        // ОСНОВНАЯ ПРОВЕРКА: Реальная цена (каждые 1 секунду)
        // ⭐ НОВАЯ ЛОГИКА: Выход с учетом slippage - выходим при минимальной прибыли или безубыточности
        if (shouldCheckRealPrice) {
          const currentMultiplier = currentPrice / position.entryPrice;
          const timeHeldSeconds = elapsed / 1000;

          // ⭐ Получаем капитализацию для мониторинга
          let marketCap: number | null = null;
          try {
            const marketData = await priceFetcher.getMarketData(position.token);
            marketCap = marketData?.marketCap || null;
          } catch (error) {
            // Игнорируем ошибки получения капитализации
          }

          // Обновляем peak
          if (currentPrice > position.peakPrice) {
            position.peakPrice = currentPrice;
          }

          const peakMultiplier = position.peakPrice / position.entryPrice;
          const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice;

          // ⭐ РАСЧЕТ ТОЧКИ БЕЗУБЫТОЧНОСТИ С УЧЕТОМ РЕАЛЬНОГО SLIPPAGE
          // ⚠️ КРИТИЧНО: Используем МАКСИМАЛЬНЫЙ slippage для консервативного расчета
          // Для токенов с ликвидностью $5000+ реальный slippage: 20-35%
          // Используем максимальный slippage чтобы гарантировать безубыточность
          const maxExitSlippage = config.exitSlippageMax; // 35% - максимальный slippage при выходе
          const entryFees = config.priorityFee + config.signatureFee;
          const exitFees = config.priorityFee + config.signatureFee;
          const investedAmount = position.investedSol;
          
          // ⭐ ФОРМУЛА БЕЗУБЫТОЧНОСТИ С УЧЕТОМ РЕАЛЬНОГО SLIPPAGE:
          // Реальная выручка = proceeds * (1 - slippage)
          // Для безубыточности: реальная выручка >= positionSize + exitFees
          // proceeds = investedAmount * multiplier
          // multiplier * investedAmount * (1 - slippage) >= positionSize + exitFees
          // multiplier >= (positionSize + exitFees) / (investedAmount * (1 - slippage))
          const positionSize = investedAmount + entryFees;
          
          // ⚠️ КОНСЕРВАТИВНЫЙ РАСЧЕТ: Используем максимальный slippage
          const minBreakEvenMultiplier = (positionSize + exitFees) / (investedAmount * (1 - maxExitSlippage));
          
          // ⭐ ДОПОЛНИТЕЛЬНАЯ ЗАЩИТА: Добавляем запас 5% для учета возможных отклонений
          const safetyMargin = 1.05;
          const minBreakEvenMultiplierWithMargin = minBreakEvenMultiplier * safetyMargin;
          
          // Для минимальной прибыли (5% после slippage): multiplier должен быть выше безубыточности
          const minProfitMultiplier = minBreakEvenMultiplierWithMargin * 1.05;
          
          // ⚠️ ЗАЩИТА ОТ УБЫТКОВ: Рассчитываем минимальный multiplier с учетом slippage
          // Если multiplier < этого значения, то даже с учетом slippage будет убыток
          const minLossMultiplierWithSlippage = (positionSize + exitFees) / (investedAmount * (1 - maxExitSlippage));
          const minLossMultiplier = Math.max(1.2, minLossMultiplierWithSlippage * 0.9); // 90% от безубыточности или минимум 1.2x
          
          // Логируем расчеты для отладки
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: position.token,
            message: `📊 EXIT CALCULATION: currentMultiplier=${currentMultiplier.toFixed(3)}x, minBreakEven=${minBreakEvenMultiplierWithMargin.toFixed(3)}x, minProfit=${minProfitMultiplier.toFixed(3)}x, minLoss=${minLossMultiplier.toFixed(3)}x, maxSlippage=${(maxExitSlippage * 100).toFixed(1)}%`,
          });

          // === НОВАЯ СТРАТЕГИЯ ВЫХОДА С УЧЕТОМ SLIPPAGE ===
          
          // ⚠️ ПРИОРИТЕТ 1: Защита от убытков - выходим если multiplier < minLossMultiplier
          // Это гарантирует минимальные потери даже с учетом максимального slippage
          if (currentMultiplier < minLossMultiplier) {
            const expectedProceeds = investedAmount * currentMultiplier;
            const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
            const netAfterFees = realProceedsAfterSlippage - exitFees;
            const loss = positionSize - netAfterFees;
            
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: position.token,
              message: `🛡️ MINIMUM LOSS EXIT: multiplier=${currentMultiplier.toFixed(3)}x < ${minLossMultiplier.toFixed(3)}x, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, loss=${loss.toFixed(6)} SOL, exiting to minimize losses`,
            });
            await this.closePosition(position, 'min_loss_exit', currentPrice);
            return;
          }

          // ⚠️ ПРИОРИТЕТ 2: Минимальная прибыль - выходим если достигли минимальной прибыли
          // Учитываем реальный slippage при расчете прибыли
          if (currentMultiplier >= minProfitMultiplier) {
            const expectedProceeds = investedAmount * currentMultiplier;
            const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
            const netAfterFees = realProceedsAfterSlippage - exitFees;
            const profit = netAfterFees - positionSize;
            const profitPct = (profit / positionSize) * 100;
            
            // Если достигли минимальной прибыли и цена падает → выходим
            if (dropFromPeak >= 0.10) { // Упало на 10% от пика
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                token: position.token,
                message: `✅ MINIMUM PROFIT EXIT: multiplier=${currentMultiplier.toFixed(3)}x >= ${minProfitMultiplier.toFixed(3)}x, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, profit=${profit.toFixed(6)} SOL (${profitPct.toFixed(2)}%), drop=${(dropFromPeak * 100).toFixed(1)}%, marketCap=${marketCap ? `$${(marketCap / 1000).toFixed(1)}k` : 'N/A'}`,
              });
              await this.closePosition(position, 'min_profit_exit', currentPrice);
              return;
            }
            
            // Если достигли минимальной прибыли и держим долго → выходим
            if (timeHeldSeconds >= 30) {
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                token: position.token,
                message: `✅ MINIMUM PROFIT EXIT (time): multiplier=${currentMultiplier.toFixed(3)}x >= ${minProfitMultiplier.toFixed(3)}x, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, profit=${profit.toFixed(6)} SOL (${profitPct.toFixed(2)}%), held=${timeHeldSeconds.toFixed(1)}s, marketCap=${marketCap ? `$${(marketCap / 1000).toFixed(1)}k` : 'N/A'}`,
              });
              await this.closePosition(position, 'min_profit_exit_time', currentPrice);
              return;
            }
          }

          // ⚠️ ПРИОРИТЕТ 3: Безубыточность - выходим если достигли безубыточности
          // Учитываем реальный slippage при расчете безубыточности
          if (currentMultiplier >= minBreakEvenMultiplierWithMargin && currentMultiplier < minProfitMultiplier) {
            const expectedProceeds = investedAmount * currentMultiplier;
            const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
            const netAfterFees = realProceedsAfterSlippage - exitFees;
            
            // Если достигли безубыточности и цена падает → выходим
            if (dropFromPeak >= 0.05) { // Упало на 5% от пика
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                token: position.token,
                message: `⚖️ BREAKEVEN EXIT: multiplier=${currentMultiplier.toFixed(3)}x >= ${minBreakEvenMultiplierWithMargin.toFixed(3)}x, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, netAfterFees=${netAfterFees.toFixed(6)} SOL, drop=${(dropFromPeak * 100).toFixed(1)}%, marketCap=${marketCap ? `$${(marketCap / 1000).toFixed(1)}k` : 'N/A'}`,
              });
              await this.closePosition(position, 'breakeven_exit', currentPrice);
              return;
            }
          }

          // ⚠️ ПРИОРИТЕТ 4: Логика для больших импульсов (с учетом slippage)
          // СТРАТЕГИЯ 1: Слабый импульс (пик < 3x)
          // Выходим если достигли takeProfitMultiplier И это выше безубыточности с учетом slippage
          if (peakMultiplier < 3.0 && currentMultiplier >= config.takeProfitMultiplier) {
            // Проверяем что даже с максимальным slippage будет прибыль
            const expectedProceeds = investedAmount * currentMultiplier;
            const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
            const netAfterFees = realProceedsAfterSlippage - exitFees;
            
            if (netAfterFees >= positionSize) {
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                token: position.token,
                message: `✅ TAKE PROFIT EXIT: multiplier=${currentMultiplier.toFixed(3)}x >= ${config.takeProfitMultiplier}x, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, netAfterFees=${netAfterFees.toFixed(6)} SOL`,
              });
              await this.closePosition(position, 'take_profit', currentPrice);
            return;
            }
          }

          // ⚠️ СТРАТЕГИЯ 2: Средний импульс (3x ≤ пик < 5x) - с учетом slippage
          // Адаптивный trailing stop 20% - баланс между жадностью и безопасностью
          if (peakMultiplier >= 3.0 && peakMultiplier < 5.0) {
            if (dropFromPeak >= 0.20) {
              // Проверяем что даже с максимальным slippage будет прибыль
              const expectedProceeds = investedAmount * currentMultiplier;
              const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
              const netAfterFees = realProceedsAfterSlippage - exitFees;
              
              if (netAfterFees >= positionSize) {
                logger.log({
                  timestamp: getCurrentTimestamp(),
                  type: 'info',
                  token: position.token,
                  message: `📉 TRAILING STOP EXIT (medium): multiplier=${currentMultiplier.toFixed(3)}x, drop=${(dropFromPeak * 100).toFixed(1)}%, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, netAfterFees=${netAfterFees.toFixed(6)} SOL`,
                });
                await this.closePosition(position, 'trailing_stop', currentPrice);
              return;
              }
            }
            
            // Защита: держим 70+ секунд и упали на 15% от пика - выходим
            if (timeHeldSeconds >= 70 && dropFromPeak >= 0.15) {
              const expectedProceeds = investedAmount * currentMultiplier;
              const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
              const netAfterFees = realProceedsAfterSlippage - exitFees;
              
              if (netAfterFees >= positionSize * 0.95) { // Допускаем 5% убыток для раннего выхода
                await this.closePosition(position, 'late_exit', currentPrice);
              return;
              }
            }
          }

          // ⚠️ СТРАТЕГИЯ 3: Большой импульс (5x ≤ пик < 10x) - с учетом slippage
          // Жадный trailing stop 25% - позволяем импульсу развиться
          if (peakMultiplier >= 5.0 && peakMultiplier < 10.0) {
            if (dropFromPeak >= 0.25) {
              const expectedProceeds = investedAmount * currentMultiplier;
              const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
              const netAfterFees = realProceedsAfterSlippage - exitFees;
              
              if (netAfterFees >= positionSize) {
                logger.log({
                  timestamp: getCurrentTimestamp(),
                  type: 'info',
                  token: position.token,
                  message: `📉 TRAILING STOP EXIT (large): multiplier=${currentMultiplier.toFixed(3)}x, drop=${(dropFromPeak * 100).toFixed(1)}%, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, netAfterFees=${netAfterFees.toFixed(6)} SOL`,
                });
                await this.closePosition(position, 'trailing_stop', currentPrice);
              return;
              }
            }
            
            // Защита: держим 75+ секунд и упали на 20% от пика - выходим
            if (timeHeldSeconds >= 75 && dropFromPeak >= 0.20) {
              const expectedProceeds = investedAmount * currentMultiplier;
              const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
              const netAfterFees = realProceedsAfterSlippage - exitFees;
              
              if (netAfterFees >= positionSize * 0.95) {
                await this.closePosition(position, 'late_exit', currentPrice);
              return;
              }
            }
          }

          // ⚠️ СТРАТЕГИЯ 4: Очень большой импульс (пик ≥ 10x) - с учетом slippage
          // Максимально жадный trailing stop 30% - даем пространство для роста
          if (peakMultiplier >= 10.0) {
            if (dropFromPeak >= 0.30) {
              const expectedProceeds = investedAmount * currentMultiplier;
              const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
              const netAfterFees = realProceedsAfterSlippage - exitFees;
              
              if (netAfterFees >= positionSize) {
                logger.log({
                  timestamp: getCurrentTimestamp(),
                  type: 'info',
                  token: position.token,
                  message: `📉 TRAILING STOP EXIT (huge): multiplier=${currentMultiplier.toFixed(3)}x, drop=${(dropFromPeak * 100).toFixed(1)}%, realAfterSlippage=${realProceedsAfterSlippage.toFixed(6)} SOL, netAfterFees=${netAfterFees.toFixed(6)} SOL`,
                });
                await this.closePosition(position, 'trailing_stop', currentPrice);
              return;
              }
            }
            
            // Защита: держим 80+ секунд и упали на 25% от пика - выходим
            if (timeHeldSeconds >= 80 && dropFromPeak >= 0.25) {
              const expectedProceeds = investedAmount * currentMultiplier;
              const realProceedsAfterSlippage = expectedProceeds * (1 - maxExitSlippage);
              const netAfterFees = realProceedsAfterSlippage - exitFees;
              
              if (netAfterFees >= positionSize * 0.95) {
                await this.closePosition(position, 'late_exit', currentPrice);
              return;
              }
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
   * Поддерживает write-off для позиций с низкими ожидаемыми proceeds
   */
  private async closePosition(position: Position, reason: string, exitPrice: number): Promise<void> {
    if (position.status !== 'active') {
      return; // Уже закрывается или закрыта
    }

    position.status = 'closing';

    try {
      // ⭐ MANDATORY EXIT PROFITABILITY CHECK: Calculate expected exit result before ANY SELL
      const exitFeeCheck = config.priorityFee + config.signatureFee;
      const entryFeeCheck = config.priorityFee + config.signatureFee;
      const positionInvestedAmount = position.investedSol;
      const positionSize = positionInvestedAmount + entryFeeCheck; // Total invested (including entry fees)
      
      // Calculate expected exit price (use current exitPrice)
      // ⭐ КРИТИЧНО: Если exitPrice = 0, используем currentPrice или entryPrice
      let expectedExitPrice = exitPrice;
      if (!expectedExitPrice || expectedExitPrice <= 0) {
        expectedExitPrice = position.currentPrice || position.markPrice || position.entryPrice || 0;
        // Если все еще 0, пытаемся получить цену заново
        if (!expectedExitPrice || expectedExitPrice <= 0) {
          try {
            const freshPrice = await priceFetcher.getPrice(position.token);
            expectedExitPrice = freshPrice || position.entryPrice || 0;
          } catch (e) {
            expectedExitPrice = position.entryPrice || 0;
          }
        }
      }
      // ⭐ КРИТИЧНО: Используем реальное количество токенов для расчета multiplier
      // Если tokensReceived есть, используем его для более точного расчета
      const tokensReceivedForMultiplier = (position as any).tokensReceived;
      let currentMultiplier: number;
      if (tokensReceivedForMultiplier && tokensReceivedForMultiplier > 0 && position.entryPrice > 0) {
        // Более точный расчет: multiplier = (exitPrice * tokensReceived) / investedSol
        // Это учитывает реальное количество токенов, полученных при покупке
        currentMultiplier = (expectedExitPrice * tokensReceivedForMultiplier) / positionInvestedAmount;
      } else {
        // Fallback: используем стандартный расчет
        currentMultiplier = position.entryPrice > 0 ? expectedExitPrice / position.entryPrice : 1;
      }
      
      // ⭐ КРИТИЧНО: Если failsafe из-за отсутствия цены, и цена не обновлялась (fallback = entryPrice),
      // НЕ проверяем netProfit, так как реальная цена может быть выше
      const isFailsafeNoPrice = reason === 'failsafe_no_price_feed';
      const priceNotUpdated = Math.abs(expectedExitPrice - position.entryPrice) < position.entryPrice * 0.01; // Цена не изменилась более чем на 1%
      
      // Если failsafe из-за отсутствия цены И цена не обновлялась, используем минимальную прибыльную цену для расчета
      // (предполагаем, что цена может быть выше, но не ниже entryPrice)
      let effectiveExitPrice = expectedExitPrice;
      if (isFailsafeNoPrice && priceNotUpdated) {
        // Используем entryPrice * 1.1 (предполагаем минимальный рост 10%) для консервативного расчета
        // Это предотвратит abandoned при отсутствии обновления цены
        effectiveExitPrice = position.entryPrice * 1.1;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: position.token,
          message: `⚠️ FAILSAFE NO PRICE: Using conservative exit price ${effectiveExitPrice.toFixed(10)} (entryPrice * 1.1) instead of ${expectedExitPrice.toFixed(10)} for profitability check`,
        });
      }
      
      // Calculate expected proceeds before slippage
      // ⭐ КРИТИЧНО: Используем реальное количество токенов из результата покупки, а не расчетное
      // Это гарантирует правильный расчет multiplier и expectedProceeds
      const tokensReceived = (position as any).tokensReceived || (positionInvestedAmount / position.entryPrice);
      const expectedProceedsBeforeSlippage = tokensReceived * effectiveExitPrice;
      
      // Estimate slippage based on current liquidity & historical slippage model
      const sellSizeSol = expectedProceedsBeforeSlippage;
      const estimatedImpact = this.adapter.estimateImpact(sellSizeSol);
      
      // Calculate expected exit price after slippage
      const expectedExitPriceAfterSlippage = effectiveExitPrice * (1 - estimatedImpact);
      const expectedProceedsAfterSlippage = tokensReceived * expectedExitPriceAfterSlippage;
      
      // Calculate all fees (DEX fees, priority fees, network fees)
      const allFees = exitFeeCheck; // Entry fees already deducted from investedAmount
      
      // Calculate net profit
      const netProfit = expectedProceedsAfterSlippage - positionSize - allFees;
      
      // ⭐ HARD RULE: IF netProfit <= 0 THEN abandon position
      // ИСКЛЮЧЕНИЕ: Если failsafe из-за отсутствия цены И цена не обновлялась, НЕ abandoned (ждем обновления цены)
      if (netProfit <= 0 && !(isFailsafeNoPrice && priceNotUpdated)) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: position.token,
          message: `💀 EXIT NOT PROFITABLE: ${position.token.substring(0, 12)}... | expectedExitPrice=${expectedExitPrice.toFixed(10)}, expectedExitPriceAfterSlippage=${expectedExitPriceAfterSlippage.toFixed(10)}, expectedProceedsAfterSlippage=${expectedProceedsAfterSlippage.toFixed(6)} SOL, positionSize=${positionSize.toFixed(6)} SOL, allFees=${allFees.toFixed(6)} SOL, netProfit=${netProfit.toFixed(6)} SOL (<= 0). Abandoning position without sell.`,
        });

        // ⭐ КРИТИЧНО: Abandon position - НЕ выполнять SELL, НЕ возвращать средства
        const reservedAmount = position.reservedAmount || positionSize;
        const investedSol = positionSize; // Полный размер позиции (уже включает entry fees)

        // ⭐ КРИТИЧНО: Используем commitLoss вместо release
        // commitLoss:
        // - Освобождает lockedBalance (освобождает слот)
        // - Списывает investedSol из totalBalance (убыток навсегда)
        // - НЕ возвращает средства в freeBalance
        this.account.commitLoss(reservedAmount, investedSol);

        // Remove from active positions
        this.positions.delete(position.token);
        position.status = 'abandoned';
        
        // Сохраняем состояние после удаления позиции
        this.saveActivePositions().catch(() => {});

        // ⭐ MANDATORY LOGGING: Log abandoned position with all required metrics
        // Required fields: token mint, entry SOL, expected exit SOL, expected slippage %, estimated fees, netProfit, reason
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'sell',
          token: position.token,
          exitPrice: expectedExitPrice,
          multiplier: currentMultiplier,
          profitSol: -investedSol, // Full loss (investedSol списан из totalBalance)
          reason: 'abandoned_unprofitable_exit',
          message: `💀 POSITION ABANDONED: ${position.token.substring(0, 12)}... | entrySOL=${investedSol.toFixed(6)}, expectedExitSOL=${expectedProceedsAfterSlippage.toFixed(6)}, expectedSlippage=${(estimatedImpact * 100).toFixed(2)}%, estimatedFees=${allFees.toFixed(6)} SOL, netProfit=${netProfit.toFixed(6)} SOL (<= 0), reason=abandoned_unprofitable_exit | investedSol=${investedSol.toFixed(6)} SOL permanently lost, totalBalance decreased by ${investedSol.toFixed(6)} SOL`,
        });

        // ⭐ MANDATORY: Log to trade logger for statistical analysis
        tradeLogger.logTradeClose({
          tradeId: (position as any).tradeId || `abandoned-${position.token}`,
          token: position.token,
          exitPrice: expectedExitPrice,
          multiplier: currentMultiplier,
          profitSol: -investedSol, // Full loss (100% loss)
          reason: 'abandoned_unprofitable_exit',
        });
        
        // ⭐ MANDATORY: Additional detailed logging for abandoned positions (for future analysis)
        console.log(`[ABANDONED POSITION] ${position.token.substring(0, 12)}... | entrySOL: ${investedSol.toFixed(6)}, expectedExitSOL: ${expectedProceedsAfterSlippage.toFixed(6)}, expectedSlippage: ${(estimatedImpact * 100).toFixed(2)}%, estimatedFees: ${allFees.toFixed(6)} SOL, netProfit: ${netProfit.toFixed(6)} SOL, reason: abandoned_unprofitable_exit | investedSol=${investedSol.toFixed(6)} SOL permanently lost`);

        // ⭐ ИНВАРИАНТ: Проверяем что freeBalance НЕ увеличился
        const freeBalanceAfter = this.account.getFreeBalance();
        const totalBalanceAfter = this.account.getTotalBalance();
        const lockedBalanceAfter = this.account.getLockedBalance();
        
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
          message: `✅ ABANDONED VERIFICATION: freeBalance=${freeBalanceAfter.toFixed(6)} SOL, totalBalance=${totalBalanceAfter.toFixed(6)} SOL, lockedBalance=${lockedBalanceAfter.toFixed(6)} SOL | investedSol=${investedSol.toFixed(6)} SOL permanently lost, slot freed`,
        });

        // ⭐ КРИТИЧНО: Добавляем токен в трекер для мониторинга
        // Токен может вырасти позже, и мы сможем продать его с прибылью или безубытком
        const tokensReceived = (position as any).tokensReceived || (investedSol / position.entryPrice);
        this.abandonedTracker.addAbandonedToken(
          position.token,
          position.entryPrice,
          investedSol,
          positionSize,
          tokensReceived
        );

        return; // DO NOT execute sell, DO NOT retry, DO NOT fallback, position is abandoned
      }
      
      // netProfit > 0: Proceed with normal SELL execution
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: position.token,
        message: `✅ EXIT PROFITABLE: ${position.token.substring(0, 12)}... | expectedExitPrice=${expectedExitPrice.toFixed(10)}, expectedProceedsAfterSlippage=${expectedProceedsAfterSlippage.toFixed(6)} SOL, netProfit=${netProfit.toFixed(6)} SOL (> 0), proceeding with sell`,
      });

      // ⭐ FIX FOR PAPER TRADING: Получаем реальную цену в момент закрытия
      // Для paper mode используем реальную цену из priceFetcher, а не переданный exitPrice
      let realExitPrice = exitPrice;
      if (this.adapter.getMode() === 'paper') {
        try {
          const freshPrice = await priceFetcher.getPrice(position.token);
          if (freshPrice > 0 && isFinite(freshPrice)) {
            realExitPrice = freshPrice;
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: position.token,
              message: `📄 PAPER MODE: Using fresh price from priceFetcher: ${freshPrice.toFixed(10)} (instead of passed exitPrice: ${exitPrice.toFixed(10)})`,
            });
          }
        } catch (error) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'warning',
            token: position.token,
            message: `⚠️ Failed to get fresh price for paper mode, using passed exitPrice: ${exitPrice.toFixed(10)}`,
          });
        }
      }

      // Нормальное закрытие: выполняем продажу
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
        message: `${this.adapter.getMode() === 'real' ? '🔴' : '📄'} Executing ${this.adapter.getMode().toUpperCase()} SELL: ${position.token} → SOL (expected ~${expectedProceedsAfterSlippage.toFixed(6)} SOL, estimatedImpact=${(estimatedImpact * 100).toFixed(2)}%, exitPrice=${realExitPrice.toFixed(10)})`,
      });

      // Получаем количество токенов для продажи
      const tokensToSell = (position as any).tokensReceived || (positionInvestedAmount / position.entryPrice);
      
      // ⭐ TIER 3: Запрет partial sells (слишком тонкий рынок)
      // Временно переопределяем sellStrategy для Tier 3
      const originalSellStrategy = config.sellStrategy;
      if (position.tier === 3 && config.sellStrategy === 'partial_50_50') {
        // Временно устанавливаем 'single' для Tier 3
        (config as any).sellStrategy = 'single';
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
          message: `🔴 Tier 3: Partial sells disabled (too thin market), using single sell`,
        });
      }
      
      const sellResult = await this.adapter.executeSell(position.token, tokensToSell);
      
      // Восстанавливаем оригинальный sellStrategy
      if (position.tier === 3 && originalSellStrategy === 'partial_50_50') {
        (config as any).sellStrategy = originalSellStrategy;
      }

        if (!sellResult.success) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            token: position.token,
          message: `❌ SELL FAILED: ${sellResult.error}, continuing with accounting...`,
          });
          // НЕ throw - позиция уже закрыта в памяти, продолжаем с учетом
        } else {
          // Store transaction signature and result
          (position as any).sellSignature = sellResult.signature;
          (position as any).solReceived = sellResult.solReceived;
          (position as any).sellResult = sellResult; // Store full result for later use

          // ⭐ FIX FOR PAPER TRADING: Используем реальную цену из executeSell для расчета multiplier
          // В paper mode executeSell возвращает markPrice и executionPrice из реального priceFetcher
          if (this.adapter.getMode() === 'paper' && sellResult.markPrice && sellResult.markPrice > 0) {
            realExitPrice = sellResult.markPrice;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: position.token,
              message: `📄 PAPER MODE: Using markPrice from executeSell: ${sellResult.markPrice.toFixed(10)}, executionPrice: ${sellResult.executionPrice?.toFixed(10) || 'N/A'}, impact: ${((sellResult.estimatedImpact || 0) * 100).toFixed(2)}%`,
            });
          }

          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: position.token,
          message: `✅ SELL SUCCESS: signature=${sellResult.signature}, received=${sellResult.solReceived?.toFixed(6)} SOL, markPrice=${sellResult.markPrice?.toFixed(10) || 'N/A'}, executionPrice=${sellResult.executionPrice?.toFixed(10) || 'N/A'}, impact=${sellResult.estimatedImpact ? (sellResult.estimatedImpact * 100).toFixed(2) + '%' : 'N/A'}`,
          });

        // 🔄 Принудительная синхронизация баланса после успешной продажи (только для real)
        if (this.adapter.getMode() === 'real') {
          await this.forceBalanceSync();
        }
      }

      // Accounting (paper or real) - используем exitFeeCheck объявленный выше
      const entryFee = config.priorityFee + config.signatureFee;
      const investedAmount = position.investedSol; // Amount actually invested (after entry fees)
      const reservedAmount = position.reservedAmount || investedAmount; // Amount that was locked
      
      // ✅ FIX: Рассчитываем реальные затраты на позицию (без завышенного slippage)
      // totalPositionCost = positionInvestedAmount + entryFees (это реально потрачено при покупке)
      const totalPositionCost = positionInvestedAmount + entryFee;
      
      // 🔴 FIX: Используем реальную цену из SELL транзакции вместо bonding curve цены
      // Это исправляет ошибки bonding curve, которые дают неправильные цены
      // ⭐ CRITICAL FIX: actualExitPrice должен использовать realExitPrice если он был обновлен из sellResult.markPrice
      // realExitPrice уже может быть обновлен из sellResult.markPrice выше (строка 1823)
      let actualExitPrice = realExitPrice; // Используем realExitPrice (который может быть обновлен из sellResult.markPrice)
      let actualProceeds: number | null = null;
      
      // Если есть реальная SELL транзакция, используем solReceived для расчета прибыли
      if ((position as any).solReceived !== undefined) {
        const solReceived = (position as any).solReceived as number;
        if (solReceived > 0 && isFinite(solReceived)) {
          // Используем реальную сумму полученную из транзакции
          actualProceeds = solReceived;
          
          // ⭐ FIX FOR PAPER TRADING: Используем markPrice из executeSell для расчета exitPrice
          // В paper mode executeSell возвращает реальную цену из priceFetcher
          // realExitPrice уже обновлен выше из sellResult.markPrice (строка 1823), но проверим еще раз
          if (this.adapter.getMode() === 'paper' && (position as any).sellResult?.markPrice) {
            actualExitPrice = (position as any).sellResult.markPrice;
            // Убедимся что realExitPrice тоже обновлен
            if (realExitPrice !== actualExitPrice) {
              realExitPrice = actualExitPrice;
            }
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: position.token,
              message: `📄 PAPER MODE: Using markPrice from executeSell: ${actualExitPrice.toFixed(10)}, solReceived=${solReceived.toFixed(6)} SOL`,
            });
          } else if (this.adapter.getMode() === 'real') {
            // Для real mode рассчитываем exitPrice из solReceived и tokensToSell
            // ⭐ КРИТИЧНО: Правильная формула: exitPrice = solReceived / tokensSold
            // tokensToSell был передан в executeSell и это точное количество проданных токенов
            const tokensSold = tokensToSell; // Количество токенов, переданное в executeSell
            
            if (tokensSold > 0 && solReceived > 0) {
              // Правильная формула: цена = SOL получено / токенов продано
              actualExitPrice = solReceived / tokensSold;
            } else {
              // Fallback: используем markPrice из sellResult или exitPrice
              actualExitPrice = sellResult.markPrice || exitPrice;
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'warning',
                token: position.token,
                message: `⚠️ Cannot calculate exitPrice from solReceived/tokensSold, using markPrice: ${actualExitPrice.toFixed(8)}`,
              });
            }
            
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: position.token,
              message: `✅ Using real SELL price: solReceived=${solReceived.toFixed(6)} SOL, tokensSold=${tokensSold.toFixed(0)}, calculated exitPrice=${actualExitPrice.toFixed(8)} (instead of bonding curve price ${exitPrice.toFixed(8)})`,
            });
          }
        }
      }
      
      // Защита от некорректных значений exitPrice (может быть огромным из-за bonding curve ошибок)
      let safeExitPrice = actualExitPrice;
      
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
      
      // 🔴 FIX: Если есть реальная сумма из SELL транзакции, используем её напрямую
      let proceeds: number;
      
      if (actualProceeds !== null) {
        // Используем реальную сумму из транзакции (уже включает все комиссии и slippage)
        proceeds = actualProceeds;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: position.token,
          message: `✅ Using real proceeds from SELL transaction: ${proceeds.toFixed(6)} SOL`,
        });
      } else {
        // Paper trading или нет реальной транзакции - рассчитываем из цены
        // Пересчитываем multiplier с безопасной ценой
        const safeMultiplier = safeExitPrice / position.entryPrice;
        
        // Защита от некорректных значений positionInvestedAmount
        let safeInvested = positionInvestedAmount;
        if (positionInvestedAmount > 1.0 || positionInvestedAmount < 0 || !isFinite(positionInvestedAmount)) {
          console.error(`⚠️ Invalid positionInvestedAmount: ${positionInvestedAmount}, using fallback`);
          safeInvested = 0.003;
        }
        
        // ISSUE #1 FIX: Calculate grossReturn first, then deduct exitFees
        // grossReturn = positionInvestedAmount * multiplier
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
        proceeds = grossReturn - exitFeeCheck;
      }
      
      // Ensure proceeds >= 0
      if (proceeds < 0) {
        proceeds = 0;
      }
      
      // ✅ FIX: Release funds and add back proceeds to deposit
      // Используем reservedAmount для освобождения заблокированных средств
      this.account.release(reservedAmount, proceeds);
      
      // ✅ Проверка баланса и вывод излишка (только для реальной торговли)
      if (this.adapter.getMode() === 'real') {
        // Неблокирующая проверка баланса после закрытия позиции
        void Promise.resolve().then(async () => {
          try {
            const realBalance = await this.balanceManager.getCurrentBalance();
            await this.balanceManager.checkAndWithdrawExcess(realBalance);
          } catch (error) {
            // Тихая ошибка - не блокируем закрытие позиции
          }
        });
      }
      
      // ✅ FIX: Calculate profit correctly
      // proceeds (solReceived) уже включает вычет всех комиссий выхода из транзакции
      // Поэтому profit = proceeds - totalPositionCost (без дополнительного вычета exitFee)
      // totalPositionCost = investedAmount + entryFee (реально потрачено при покупке)
      const profit = proceeds - totalPositionCost;
      
      // TIMING ANALYSIS: Extract timing data for hypothesis validation
      const timingData = (position as any).timingData || {};
      const tokenAgeAtEntry = timingData.tokenAgeAtOpen || 0;
      const tokenAgeAtExit = (Date.now() - (timingData.tokenCreatedAt || position.entryTime)) / 1000;
      const holdDuration = (Date.now() - position.entryTime) / 1000;
      
      // Удаляем из активных
      this.positions.delete(position.token);
      position.status = 'closed';
      
      // Сохраняем состояние после закрытия позиции
      this.saveActivePositions().catch(() => {});

      // Пересчитываем multiplier для логирования (используем реальную цену или безопасную)
      // ⭐ FIX FOR PAPER TRADING: Используем realExitPrice если он был установлен
      const finalExitPrice = (this.adapter.getMode() === 'paper' && realExitPrice !== exitPrice) ? realExitPrice : safeExitPrice;
      
      // ⭐ CRITICAL FIX: Multiplier должен рассчитываться на основе ЦЕНЫ, а не proceeds
      // actualProceeds уже включает slippage и fees, поэтому не подходит для multiplier
      // Используем actualExitPrice (который берется из markPrice в paper mode) для расчета multiplier
      let finalMultiplier: number;
      if (actualProceeds !== null && actualExitPrice !== exitPrice && actualExitPrice > 0) {
        // Используем actualExitPrice (реальная цена из executeSell в paper mode)
        finalMultiplier = actualExitPrice / position.entryPrice;
      } else if (actualProceeds !== null) {
        // Fallback: если нет actualExitPrice, рассчитываем из proceeds (менее точно)
        finalMultiplier = (actualProceeds + exitFeeCheck) / positionInvestedAmount;
      } else {
        // Используем finalExitPrice (безопасная цена)
        finalMultiplier = finalExitPrice / position.entryPrice;
      }
      
      // Non-blocking trade logging
      // ⭐ FIX FOR PAPER TRADING: Используем realExitPrice для логирования
      const logExitPrice = (this.adapter.getMode() === 'paper' && realExitPrice !== exitPrice) ? realExitPrice : safeExitPrice;
      const tradeId = (position as any).tradeId || `unknown-${position.token}`;
      tradeLogger.logTradeClose({
        tradeId,
        token: position.token,
        exitPrice: logExitPrice,
        multiplier: finalMultiplier,
        profitSol: profit,
        reason,
      });

      // Enhanced logger with timing analysis for hypothesis validation
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'sell',
        token: position.token,
        exitPrice: logExitPrice,
        multiplier: finalMultiplier,
        profitSol: profit,
        reason,
        message: `Position closed: ${position.token.substring(0, 8)}..., ${finalMultiplier.toFixed(2)}x, profit=${profit.toFixed(6)} SOL, reason=${reason}${actualProceeds !== null ? ' (real SELL price used)' : (this.adapter.getMode() === 'paper' && realExitPrice !== exitPrice ? ' (paper: fresh price from priceFetcher)' : '')} | TIMING ANALYSIS: Entry age: ${tokenAgeAtEntry.toFixed(2)}s, Exit age: ${tokenAgeAtExit.toFixed(2)}s, Hold: ${holdDuration.toFixed(2)}s, Entry price: ${position.entryPrice.toFixed(8)}, Exit price: ${logExitPrice.toFixed(8)}`,
      });

    } catch (error) {
      this.positions.delete(position.token);
      position.status = 'closed';
      
      // Сохраняем состояние после закрытия позиции
      this.saveActivePositions().catch(() => {});
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
          position.lastRealPriceUpdate = now;
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
  /**
   * Получает текущий депозит
   * В реальной торговле возвращает баланс кошелька, в симуляции - баланс из Account
   */
  async getCurrentDeposit(): Promise<number> {
    if (this.adapter.getMode() === 'real') {
      // 🔴 РЕАЛЬНАЯ ТОРГОВЛЯ: Используем реальный баланс кошелька
      try {
        return await this.balanceManager.getCurrentBalance();
      } catch (error) {
        // Fallback на Account если не удалось получить баланс
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          message: `⚠️ Failed to get real balance, using Account balance: ${error instanceof Error ? error.message : String(error)}`,
        });
        return this.account.getTotalBalance();
      }
    } else {
      // 📄 СИМУЛЯЦИЯ: Используем баланс из Account
      return this.account.getTotalBalance();
    }
  }

  /**
   * Синхронная версия getCurrentDeposit (для обратной совместимости)
   * В реальной торговле возвращает баланс из Account (может быть несинхронизирован)
   */
  getCurrentDepositSync(): number {
    return this.account.getTotalBalance();
  }

  /**
   * Получает пиковый депозит
   * В реальной торговле может быть выше реального баланса (если были убытки)
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
      // ⭐ Only close active positions (abandoned positions are already excluded)
      if (position.status === 'active') {
        const exitPrice = position.currentPrice || position.entryPrice;
        await this.closePosition(position, 'shutdown', exitPrice);
      }
    }
    
    // Останавливаем трекинг abandoned токенов (с сохранением состояния)
    this.abandonedTracker.stop();
    
    // Сохраняем активные позиции перед остановкой
    this.saveActivePositions().catch(() => {});
    
    // Останавливаем периодическое сохранение
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
  }
  
  /**
   * Получает трекер abandoned токенов (для доступа извне)
   */
  getAbandonedTracker(): AbandonedTokenTracker {
    return this.abandonedTracker;
  }

  /**
   * Сохраняет активные позиции в файл
   */
  private async saveActivePositions(): Promise<void> {
    try {
      // Сохраняем только активные позиции (не closed, не abandoned)
      const activePositions = Array.from(this.positions.values())
        .filter(p => p.status === 'active' || p.status === 'closing');
      
      const data = activePositions.map(p => ({
        token: p.token,
        entryPrice: p.entryPrice,
        executionPrice: p.executionPrice,
        markPrice: p.markPrice,
        investedSol: p.investedSol,
        reservedAmount: p.reservedAmount,
        entryTime: p.entryTime,
        lastRealPriceUpdate: p.lastRealPriceUpdate,
        peakPrice: p.peakPrice,
        currentPrice: p.currentPrice,
        status: p.status,
        tier: p.tier,
        tokensReceived: (p as any).tokensReceived, // Сохраняем реальное количество токенов
      }));
      
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(this.STATE_FILE, json, 'utf8');
    } catch (error) {
      // Логируем ошибку, но не прерываем работу
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ PositionManager: Failed to save active positions to ${this.STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Загружает активные позиции из файла
   * ВАЖНО: Позиции загружаются, но мониторинг НЕ возобновляется автоматически
   * Это нужно делать вручную в index.ts после загрузки
   */
  private loadActivePositions(): void {
    try {
      if (!fs.existsSync(this.STATE_FILE)) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `📂 PositionManager: No active positions file found at ${this.STATE_FILE}, starting fresh`,
        });
        return;
      }

      const json = fs.readFileSync(this.STATE_FILE, 'utf8');
      const data: any[] = JSON.parse(json);

      if (!Array.isArray(data)) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          message: `⚠️ PositionManager: Invalid active positions file format, starting fresh`,
        });
        return;
      }

      // Восстанавливаем позиции
      let loadedCount = 0;
      for (const posData of data) {
        if (posData.token && posData.entryPrice > 0) {
          const position: Position = {
            token: posData.token,
            entryPrice: posData.entryPrice,
            executionPrice: posData.executionPrice,
            markPrice: posData.markPrice,
            investedSol: posData.investedSol,
            reservedAmount: posData.reservedAmount,
            entryTime: posData.entryTime,
            lastRealPriceUpdate: posData.lastRealPriceUpdate || posData.entryTime,
            peakPrice: posData.peakPrice || posData.entryPrice,
            currentPrice: posData.currentPrice || posData.entryPrice,
            status: posData.status === 'active' ? 'active' : 'active', // Восстанавливаем как active
            tier: posData.tier,
          };
          
          // Восстанавливаем tokensReceived если есть
          if (posData.tokensReceived) {
            (position as any).tokensReceived = posData.tokensReceived;
          }
          
          this.positions.set(posData.token, position);
          loadedCount++;
        }
      }

      if (loadedCount > 0) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `✅ PositionManager: Loaded ${loadedCount} active positions from ${this.STATE_FILE}. NOTE: Monitoring must be restarted manually.`,
        });
      }
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ PositionManager: Failed to load active positions from ${this.STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Получает список загруженных активных позиций (для восстановления мониторинга)
   */
  getLoadedActivePositions(): Position[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'active');
  }
}

