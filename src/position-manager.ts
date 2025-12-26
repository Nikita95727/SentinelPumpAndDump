import { Connection } from '@solana/web3.js';
import { Position, PositionStats, TokenCandidate } from './types';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp, sleep, calculateSlippage, formatUsd } from './utils';
import { quickSecurityCheck } from './quick-filters';
import { priceFetcher } from './price-fetcher';
import { TokenFilters } from './filters';

const MAX_POSITIONS = 10;
const TAKE_PROFIT_MULT = 4.0;
const MAX_HOLD_TIME = 90_000; // 90 секунд
const TRAILING_STOP_PCT = 0.25;
const CHECK_INTERVAL = 2000; // Проверка каждые 2 секунды

export class PositionManager {
  private positions = new Map<string, Position>();
  private connection: Connection;
  private filters: TokenFilters;
  private currentDeposit: number;
  private peakDeposit: number;
  private positionSize: number; // Размер позиции = currentDeposit / MAX_POSITIONS

  constructor(connection: Connection, initialDeposit: number) {
    this.connection = connection;
    this.filters = new TokenFilters(connection);
    this.currentDeposit = initialDeposit;
    this.peakDeposit = initialDeposit;
    this.positionSize = initialDeposit / MAX_POSITIONS;

    // Централизованное обновление цен каждые 2 секунды
    setInterval(() => this.updateAllPrices(), CHECK_INTERVAL);
  }

  /**
   * Пытается открыть позицию для токена
   * Возвращает true если позиция открыта, false если нет свободных слотов или проверка не прошла
   */
  async tryOpenPosition(candidate: TokenCandidate): Promise<boolean> {
    // 0. Фильтр: исключаем SOL токен
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (candidate.mint === SOL_MINT) {
      console.log(`⏭️ Skipped SOL token (not a pump.fun token)`);
      return false;
    }

    // 1. Проверка: есть ли свободные слоты?
    if (this.positions.size >= MAX_POSITIONS) {
      console.log(`⏭️ No free slots (${this.positions.size}/${MAX_POSITIONS})`);
      return false;
    }

    // 2. Проверка: достаточно ли средств для открытия позиции?
    // В симуляции проверяем что можем "выделить" средства на позицию
    const requiredAmount = this.positionSize; // Нужно выделить positionSize
    if (this.currentDeposit < requiredAmount) {
      console.log(`⏭️ Insufficient deposit: ${this.currentDeposit.toFixed(6)} SOL < ${requiredAmount.toFixed(6)} SOL (need for position)`);
      return false;
    }

    // 3. Быстрая проверка безопасности (ТОЛЬКО критичное!)
    const securityCheckStart = Date.now();
    const passed = await quickSecurityCheck(candidate);
    const securityCheckDuration = Date.now() - securityCheckStart;

    if (!passed) {
      console.log(`❌ Security check failed for ${candidate.mint.slice(0, 8)}... (${securityCheckDuration}ms)`);
      return false;
    }

    // 3. Открываем позицию
    try {
      const position = await this.openPosition(candidate);
      
      // 4. Запускаем параллельный мониторинг (НЕ await!)
      this.monitorPosition(position); // async, не блокирует
      
      console.log(`✅ Position opened for ${candidate.mint.slice(0, 8)}... (${securityCheckDuration}ms)`);
      return true;
    } catch (error) {
      console.error(`❌ Error opening position for ${candidate.mint.slice(0, 8)}...:`, error);
      return false;
    }
  }

  /**
   * Открывает позицию для токена
   */
  private async openPosition(candidate: TokenCandidate): Promise<Position> {
    const openStartTime = Date.now();

    // Получаем цену входа
    const entryPrice = await this.filters.getEntryPrice(candidate.mint);
    
    if (entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }

    // Рассчитываем инвестиции с учетом комиссий
    const fees = config.priorityFee + config.signatureFee;
    const invested = this.positionSize - fees;

    if (invested <= 0) {
      throw new Error(`Insufficient funds after fees: ${invested}`);
    }

    // Рассчитываем slippage
    const slippage = calculateSlippage();
    const actualEntryPrice = entryPrice * (1 + slippage);

    // Создаем позицию
    const position: Position = {
      token: candidate.mint,
      entryPrice: actualEntryPrice,
      investedSol: invested,
      investedUsd: formatUsd(invested),
      entryTime: Date.now(),
      peakPrice: actualEntryPrice,
      currentPrice: actualEntryPrice,
      status: 'active',
      errorCount: 0,
    };

    this.positions.set(candidate.mint, position);

    // В симуляции вычитаем только invested (средства вложены в позицию)
    // При закрытии добавим grossProfit (возврат + прибыль/убыток)
    this.currentDeposit -= invested;
    if (this.currentDeposit < 0) {
      this.currentDeposit = 0;
    }

    // Логируем покупку
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'buy',
      token: candidate.mint,
      investedSol: invested,
      entryPrice: actualEntryPrice,
      message: `Position opened: ${candidate.mint.substring(0, 8)}..., invested=${invested.toFixed(6)} SOL, entry=${actualEntryPrice.toFixed(8)}`,
    });

    console.log(`💰 OPENED: ${candidate.mint.slice(0, 8)}... | Entry: ${actualEntryPrice.toFixed(8)} | Invested: ${invested.toFixed(6)} SOL`);

    return position;
  }

  /**
   * Параллельный мониторинг позиции
   */
  private async monitorPosition(position: Position): Promise<void> {
    while (position.status === 'active') {
      await sleep(CHECK_INTERVAL);

      try {
        const currentPrice = await this.getCurrentPrice(position.token);
        const elapsed = Date.now() - position.entryTime;
        const multiplier = currentPrice / position.entryPrice;

        // Обновляем peak
        if (currentPrice > position.peakPrice) {
          position.peakPrice = currentPrice;
        }

        // Обновляем кэш цены
        position.currentPrice = currentPrice;

        // Условие 1: Take Profit (4x)
        if (multiplier >= TAKE_PROFIT_MULT) {
          await this.closePosition(position, 'take_profit', currentPrice);
          return;
        }

        // Условие 2: Timeout (90 секунд)
        if (elapsed >= MAX_HOLD_TIME) {
          await this.closePosition(position, 'timeout', currentPrice);
          return;
        }

        // Условие 3: Trailing Stop (25% от пика)
        const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice;
        if (dropFromPeak >= TRAILING_STOP_PCT) {
          await this.closePosition(position, 'trailing_stop', currentPrice);
          return;
        }

      } catch (error) {
        console.error(`Monitoring error for ${position.token.slice(0, 8)}...:`, error);

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
      // Симуляция продажи
      const exitFee = config.priorityFee + config.signatureFee;
      const multiplier = exitPrice / position.entryPrice;
      const grossProfit = position.investedSol * multiplier;
      const profit = grossProfit - exitFee;

      console.log(`💰 CLOSED: ${position.token.slice(0, 8)}... | ${multiplier.toFixed(2)}x | ${profit.toFixed(6)} SOL | ${reason}`);

      // Обновляем депозит (симуляция)
      // При открытии мы вычли invested, теперь добавляем grossProfit
      // Результат: currentDeposit += (grossProfit - invested) = прибыль/убыток
      this.currentDeposit += grossProfit;
      if (this.currentDeposit > this.peakDeposit) {
        this.peakDeposit = this.currentDeposit;
      }
      if (this.currentDeposit < 0) {
        this.currentDeposit = 0; // Защита от отрицательного депозита
      }

      // Удаляем из активных
      this.positions.delete(position.token);
      position.status = 'closed';

      // Обновляем размер позиции (compound) - но не меньше минимального
      const minPositionSize = 0.001; // Минимальный размер позиции
      this.positionSize = Math.max(this.currentDeposit / MAX_POSITIONS, minPositionSize);

      // Логируем
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'sell',
        token: position.token,
        exitPrice,
        multiplier,
        profitSol: profit,
        reason,
        message: `Position closed: ${position.token.substring(0, 8)}..., ${multiplier.toFixed(2)}x, profit=${profit.toFixed(6)} SOL, reason=${reason}`,
      });

    } catch (error) {
      console.error(`Error closing ${position.token.slice(0, 8)}...:`, error);
      this.positions.delete(position.token);
      position.status = 'closed';
    }
  }

  /**
   * Получает текущую цену токена (использует кэш если доступен)
   */
  private async getCurrentPrice(token: string): Promise<number> {
    // Используем кэшированную цену если есть
    const position = this.positions.get(token);
    if (position?.currentPrice && position.currentPrice > 0) {
      return position.currentPrice;
    }

    // Запрашиваем цену через priceFetcher (bonding curve)
    const price = await priceFetcher.getPrice(token);
    
    if (price > 0) {
      return price;
    }
    
    // Fallback: используем entryPrice
    return position?.entryPrice || 0;
  }

  /**
   * Централизованное обновление цен для всех позиций
   */
  private async updateAllPrices(): Promise<void> {
    if (this.positions.size === 0) return;

    const tokens = Array.from(this.positions.keys());
    const prices = await priceFetcher.getPricesBatch(tokens);

    // Кэшируем в объектах позиций
    for (const token of tokens) {
      const position = this.positions.get(token);
      if (position && position.status === 'active') {
        const price = prices.get(token);
        
        if (price && price > 0) {
          position.currentPrice = price;
        } else {
          // При ошибке используем entryPrice
          position.currentPrice = position.entryPrice;
        }
      }
    }
  }

  /**
   * Получает статистику активных позиций
   */
  getStats(): PositionStats {
    const positions = Array.from(this.positions.values())
      .filter(p => p.status === 'active')
      .map(p => ({
        token: p.token.slice(0, 8) + '...',
        multiplier: p.currentPrice ? (p.currentPrice / p.entryPrice).toFixed(2) + 'x' : '1.00x',
        age: `${Math.floor((Date.now() - p.entryTime) / 1000)}s`,
      }));

    return {
      activePositions: this.positions.size,
      availableSlots: MAX_POSITIONS - this.positions.size,
      positions,
    };
  }

  /**
   * Получает текущий депозит
   */
  getCurrentDeposit(): number {
    return this.currentDeposit;
  }

  /**
   * Получает пиковый депозит
   */
  getPeakDeposit(): number {
    return this.peakDeposit;
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

