import { Connection } from '@solana/web3.js';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';
import { priceFetcher } from './price-fetcher';
import { config } from './config';
import { ITradingAdapter } from './trading/trading-adapter.interface';

/**
 * AbandonedTokenTracker
 * Отслеживает токены со статусом "abandoned" и продает их, если цена позволяет
 * 
 * Логика:
 * - Раз в час проверяет цену abandoned токенов
 * - Если цена позволяет продать с прибылью или безубытком (с учетом slippage и fees) - продает
 * - Учитывает реальный slippage при расчете безубыточности
 */
export class AbandonedTokenTracker {
  private connection: Connection;
  private adapter: ITradingAdapter;
  private abandonedTokens = new Map<string, {
    token: string;
    entryPrice: number;
    investedSol: number;
    positionSize: number;
    entryTime: number;
    abandonedTime: number;
    tokensReceived?: number; // Количество токенов, полученных при покупке
  }>();
  private isTracking = false;
  private trackingInterval: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 час

  constructor(connection: Connection, adapter: ITradingAdapter) {
    this.connection = connection;
    this.adapter = adapter;
  }

  /**
   * Добавляет токен в список отслеживаемых abandoned токенов
   */
  addAbandonedToken(
    token: string,
    entryPrice: number,
    investedSol: number,
    positionSize: number,
    tokensReceived?: number
  ): void {
    this.abandonedTokens.set(token, {
      token,
      entryPrice,
      investedSol,
      positionSize,
      entryTime: Date.now(),
      abandonedTime: Date.now(),
      tokensReceived,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token,
      message: `📌 Abandoned token added to tracker: ${token.substring(0, 8)}... | entryPrice=${entryPrice.toFixed(8)}, investedSol=${investedSol.toFixed(6)}, positionSize=${positionSize.toFixed(6)}`,
    });

    // Запускаем трекинг, если еще не запущен
    if (!this.isTracking) {
      this.startTracking();
    }
  }

  /**
   * Удаляет токен из списка отслеживаемых (после продажи)
   */
  removeAbandonedToken(token: string): void {
    if (this.abandonedTokens.delete(token)) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token,
        message: `✅ Abandoned token removed from tracker: ${token.substring(0, 8)}... (sold or removed)`,
      });
    }
  }

  /**
   * Запускает периодическую проверку abandoned токенов
   * Вызывается автоматически при добавлении первого токена, или вручную
   */
  startTracking(): void {
    if (this.isTracking) {
      return; // Уже запущен
    }

    this.isTracking = true;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔄 AbandonedTokenTracker: Started tracking ${this.abandonedTokens.size} abandoned tokens (check interval: 1 hour)`,
    });

    // Первая проверка через 5 минут (чтобы не блокировать старт и дать время токенам)
    setTimeout(() => {
      this.checkAbandonedTokens().catch(err => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `❌ AbandonedTokenTracker: Error in first check: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }, 5 * 60_000); // 5 минут

    // Затем каждые CHECK_INTERVAL_MS (1 час)
    this.trackingInterval = setInterval(() => {
      this.checkAbandonedTokens().catch(err => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `❌ AbandonedTokenTracker: Error checking abandoned tokens: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * Останавливает трекинг
   */
  stopTracking(): void {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
    this.isTracking = false;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `⏸️ AbandonedTokenTracker: Stopped tracking`,
    });
  }

  /**
   * Проверяет все abandoned токены и продает те, которые можно продать с прибылью/безубытком
   */
  private async checkAbandonedTokens(): Promise<void> {
    if (this.abandonedTokens.size === 0) {
      return; // Нет токенов для проверки
    }

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔍 AbandonedTokenTracker: Checking ${this.abandonedTokens.size} abandoned tokens...`,
    });

    const tokensToCheck = Array.from(this.abandonedTokens.values());
    
    for (const tokenData of tokensToCheck) {
      try {
        await this.checkAndSellToken(tokenData);
        // Небольшая задержка между проверками, чтобы не перегружать RPC
        await sleep(2000); // 2 секунды между проверками
      } catch (error) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenData.token,
          message: `❌ AbandonedTokenTracker: Error checking token ${tokenData.token.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  /**
   * Проверяет один токен и продает его, если цена позволяет
   */
  private async checkAndSellToken(tokenData: {
    token: string;
    entryPrice: number;
    investedSol: number;
    positionSize: number;
    tokensReceived?: number;
  }): Promise<void> {
    const { token, entryPrice, investedSol, positionSize, tokensReceived } = tokenData;

    // Получаем текущую цену
    const currentPrice = await priceFetcher.getPrice(token);
    if (currentPrice <= 0) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        token,
        message: `⚠️ AbandonedTokenTracker: Could not get price for ${token.substring(0, 8)}..., skipping`,
      });
      return;
    }

    // Рассчитываем multiplier
    const multiplier = currentPrice / entryPrice;

    // Рассчитываем ожидаемый результат продажи
    const exitFees = config.priorityFee + config.signatureFee;
    
    // Используем максимальный exit slippage для консервативности
    const exitSlippage = config.exitSlippageMax; // 35%
    
    // Количество токенов для продажи
    // Если tokensReceived не известно, используем оценку на основе investedSol
    const tokensToSell = tokensReceived || (investedSol / entryPrice);
    
    // Ожидаемая выручка (gross)
    const grossProceeds = tokensToSell * currentPrice;
    
    // Slippage при продаже
    const slippageAmount = grossProceeds * exitSlippage;
    
    // Ожидаемая выручка после slippage и fees
    const expectedProceeds = grossProceeds - slippageAmount - exitFees;
    
    // Чистая прибыль/убыток
    const netProfit = expectedProceeds - positionSize; // positionSize включает все затраты
    
    // Проверяем, можно ли продать с безубытком или прибылью
    if (netProfit > 0) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token,
        message: `💰 AbandonedTokenTracker: Token ${token.substring(0, 8)}... can be sold with profit! multiplier=${multiplier.toFixed(3)}x, currentPrice=${currentPrice.toFixed(8)}, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, netProfit=${netProfit.toFixed(6)} SOL, attempting to sell...`,
      });

      // Пытаемся продать
      const sellResult = await this.adapter.executeSell(token, tokensToSell);
      
      if (sellResult.success && sellResult.signature) {
        // Продажа успешна
        const actualProceeds = sellResult.solReceived || expectedProceeds;
        const actualProfit = actualProceeds - positionSize;
        
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token,
          message: `✅ AbandonedTokenTracker: Successfully sold abandoned token ${token.substring(0, 8)}... | signature=${sellResult.signature}, actualProceeds=${actualProceeds.toFixed(6)} SOL, actualProfit=${actualProfit.toFixed(6)} SOL, multiplier=${multiplier.toFixed(3)}x`,
        });

        // Удаляем токен из списка отслеживаемых
        this.removeAbandonedToken(token);
      } else {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token,
          message: `❌ AbandonedTokenTracker: Failed to sell abandoned token ${token.substring(0, 8)}...: ${sellResult.error || 'Unknown error'}`,
        });
      }
    } else if (netProfit >= -0.0001) {
      // Безубыток (с небольшой погрешностью)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token,
        message: `⚖️ AbandonedTokenTracker: Token ${token.substring(0, 8)}... can be sold at breakeven! multiplier=${multiplier.toFixed(3)}x, currentPrice=${currentPrice.toFixed(8)}, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, netProfit=${netProfit.toFixed(6)} SOL, attempting to sell...`,
      });

      // Пытаемся продать
      const sellResult = await this.adapter.executeSell(token, tokensToSell);
      
      if (sellResult.success && sellResult.signature) {
        const actualProceeds = sellResult.solReceived || expectedProceeds;
        const actualProfit = actualProceeds - positionSize;
        
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token,
          message: `✅ AbandonedTokenTracker: Successfully sold abandoned token at breakeven ${token.substring(0, 8)}... | signature=${sellResult.signature}, actualProceeds=${actualProceeds.toFixed(6)} SOL, actualProfit=${actualProfit.toFixed(6)} SOL`,
        });

        this.removeAbandonedToken(token);
      } else {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token,
          message: `❌ AbandonedTokenTracker: Failed to sell abandoned token at breakeven ${token.substring(0, 8)}...: ${sellResult.error || 'Unknown error'}`,
        });
      }
    } else {
      // Еще не выгодно продавать
      const loss = -netProfit;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token,
        message: `⏳ AbandonedTokenTracker: Token ${token.substring(0, 8)}... not profitable yet | multiplier=${multiplier.toFixed(3)}x, currentPrice=${currentPrice.toFixed(8)}, expectedProceeds=${expectedProceeds.toFixed(6)} SOL, loss=${loss.toFixed(6)} SOL, waiting...`,
      });
    }
  }

  /**
   * Получает список всех отслеживаемых abandoned токенов
   */
  getTrackedTokens(): Array<{ token: string; entryPrice: number; investedSol: number; abandonedTime: number }> {
    return Array.from(this.abandonedTokens.values()).map(t => ({
      token: t.token,
      entryPrice: t.entryPrice,
      investedSol: t.investedSol,
      abandonedTime: t.abandonedTime,
    }));
  }

  /**
   * Очищает все отслеживаемые токены
   */
  clearAll(): void {
    const count = this.abandonedTokens.size;
    this.abandonedTokens.clear();
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔄 AbandonedTokenTracker: Cleared ${count} tracked tokens`,
    });
  }
}

