import { Connection } from '@solana/web3.js';
import { Position, PositionStats, TokenCandidate } from './types';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp, sleep, calculateSlippage, formatUsd } from './utils';
import { quickSecurityCheck } from './quick-filters';
import { PriceFetcher } from './price-fetcher';
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
  private priceFetcher: PriceFetcher;
  private currentDeposit: number;
  private peakDeposit: number;
  private positionSize: number; // Размер позиции = currentDeposit / MAX_POSITIONS

  constructor(connection: Connection, initialDeposit: number) {
    this.connection = connection;
    this.filters = new TokenFilters(connection);
    this.priceFetcher = new PriceFetcher();
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
    // 1. Проверка: есть ли свободные слоты?
    if (this.positions.size >= MAX_POSITIONS) {
      console.log(`⏭️ No free slots (${this.positions.size}/${MAX_POSITIONS})`);
      return false;
    }

    // 2. Быстрая проверка безопасности (ТОЛЬКО критичное!)
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

    // Обновляем депозит
    this.currentDeposit -= this.positionSize;
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

      // Обновляем депозит
      this.currentDeposit += grossProfit;
      if (this.currentDeposit > this.peakDeposit) {
        this.peakDeposit = this.currentDeposit;
      }

      // Удаляем из активных
      this.positions.delete(position.token);
      position.status = 'closed';

      // Обновляем размер позиции (compound)
      this.positionSize = this.currentDeposit / MAX_POSITIONS;

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
    if (position?.currentPrice) {
      return position.currentPrice;
    }

    // Иначе запрашиваем
    const prices = await this.priceFetcher.getPricesBatch([token]);
    return prices.get(token) || position?.entryPrice || 0;
  }

  /**
   * Централизованное обновление цен для всех позиций
   */
  private async updateAllPrices(): Promise<void> {
    if (this.positions.size === 0) return;

    const tokens = Array.from(this.positions.keys());
    const prices = await this.priceFetcher.getPricesBatch(tokens);

    // Кэшируем в объектах позиций
    for (const [token, price] of prices.entries()) {
      const position = this.positions.get(token);
      if (position && position.status === 'active') {
        position.currentPrice = price;
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

