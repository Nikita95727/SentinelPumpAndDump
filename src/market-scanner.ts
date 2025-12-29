/**
 * Market Scanner
 * Сканирует рынок для поиска топ-пар с высокой ликвидностью и волатильностью
 * Работает каждые N минут, возвращает 5-10 лучших пар
 */

import { BybitClient, BybitTicker } from './bybit-client';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

export interface TradingPair {
  symbol: string;
  ticker: BybitTicker;
  volume24h: number;
  volatility24h: number;
  priceChange5m: number;
  spread: number; // Спред bid/ask в %
  score: number; // Комбинированный score для ранжирования
}

export class MarketScanner {
  private bybitClient: BybitClient;
  private scanInterval: NodeJS.Timeout | null = null;
  private isScanning = false;
  private onPairsDetectedCallback: ((pairs: TradingPair[]) => void) | null = null;
  private priceHistory: Map<string, Array<{ price: number; timestamp: number }>> = new Map();

  constructor(bybitClient: BybitClient) {
    this.bybitClient = bybitClient;
  }

  /**
   * Устанавливает callback для уведомления о найденных парах
   */
  setOnPairsDetected(callback: (pairs: TradingPair[]) => void): void {
    this.onPairsDetectedCallback = callback;
  }

  /**
   * Начинает сканирование рынка
   */
  async start(intervalMinutes: number = 5): Promise<void> {
    if (this.isScanning) {
      return;
    }

    this.isScanning = true;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔍 Market Scanner: Starting scan every ${intervalMinutes} minutes...`,
    });

    // Первое сканирование сразу
    await this.scanMarket();

    // Затем каждые N минут
    this.scanInterval = setInterval(() => {
      if (this.isScanning) {
        this.scanMarket().catch(error => {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            message: `Error scanning market: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Останавливает сканирование
   */
  stop(): void {
    this.isScanning = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: '🔍 Market Scanner: Stopped',
    });
  }

  /**
   * Сканирует рынок для поиска топ-пар
   */
  private async scanMarket(): Promise<void> {
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: '🔍 Market Scanner: Scanning for top liquid and volatile pairs...',
      });

      // Получаем все спотовые пары
      const markets = await this.bybitClient.getSpotMarkets();
      
      // Фильтруем только USDT пары
      const usdtPairs = markets.filter(symbol => symbol.endsWith('/USDT'));
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔍 Market Scanner: Found ${usdtPairs.length} USDT pairs, analyzing...`,
      });

      // Получаем тикеры батчем
      const tickers = await this.bybitClient.getTickersBatch(usdtPairs);
      
      // Получаем стаканы для расчета спреда
      const tradingPairs: TradingPair[] = [];

      for (const [symbol, ticker] of tickers.entries()) {
        // Базовые фильтры
        if (ticker.volume24h < config.minVolume24h) {
          continue; // Слишком низкий объем
        }

        if (ticker.volatility24h < config.minVolatility24h) {
          continue; // Слишком низкая волатильность
        }

        // Получаем стакан для расчета спреда
        const orderBook = await this.bybitClient.getOrderBook(symbol, 5);
        if (!orderBook || orderBook.bids.length === 0 || orderBook.asks.length === 0) {
          continue;
        }

        const bestBid = orderBook.bids[0][0];
        const bestAsk = orderBook.asks[0][0];
        const spread = ((bestAsk - bestBid) / bestBid) * 100;

        // Фильтр по спреду (максимум 0.1% для скальпинга)
        if (spread > 0.1) {
          continue;
        }

        // Получаем изменение цены за 5 минут
        const priceChange5m = await this.calculatePriceChange5m(symbol, ticker.lastPrice);

        // Рассчитываем score
        const score = this.calculateScore(ticker, spread, priceChange5m);

        tradingPairs.push({
          symbol,
          ticker,
          volume24h: ticker.volume24h,
          volatility24h: ticker.volatility24h,
          priceChange5m,
          spread,
          score,
        });
      }

      // Сортируем по score (лучшие первыми)
      tradingPairs.sort((a, b) => b.score - a.score);

      // Берем топ-10
      const topPairs = tradingPairs.slice(0, 10);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔍 Market Scanner: Found ${tradingPairs.length} eligible pairs, top 10: ${topPairs.map(p => `${p.symbol} (score=${p.score.toFixed(3)}, vol=${(p.volume24h / 1000000).toFixed(1)}M, spread=${p.spread.toFixed(3)}%)`).join(', ')}`,
      });

      // Уведомляем о найденных парах
      if (this.onPairsDetectedCallback && topPairs.length > 0) {
        this.onPairsDetectedCallback(topPairs);
      }
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error scanning market: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Рассчитывает изменение цены за последние 5 минут
   */
  private async calculatePriceChange5m(symbol: string, currentPrice: number): Promise<number> {
    try {
      const history = this.priceHistory.get(symbol) || [];
      const now = Date.now();

      // Удаляем старые записи (старше 10 минут)
      const filteredHistory = history.filter(h => now - h.timestamp < 10 * 60 * 1000);

      // Находим цену 5 минут назад
      const price5mAgo = filteredHistory.find(h => now - h.timestamp >= 5 * 60 * 1000);

      if (!price5mAgo) {
        // Сохраняем текущую цену
        filteredHistory.push({ price: currentPrice, timestamp: now });
        this.priceHistory.set(symbol, filteredHistory);
        return 0;
      }

      // Рассчитываем изменение в процентах
      const change = ((currentPrice - price5mAgo.price) / price5mAgo.price) * 100;

      // Обновляем историю
      filteredHistory.push({ price: currentPrice, timestamp: now });
      this.priceHistory.set(symbol, filteredHistory);

      return change;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Рассчитывает комбинированный score для ранжирования
   */
  private calculateScore(ticker: BybitTicker, spread: number, priceChange5m: number): number {
    // Нормализуем индикаторы (0-1)
    const normalizedVolume = Math.min(ticker.volume24h / 100000000, 1.0); // $100M = максимум
    const normalizedVolatility = Math.min(ticker.volatility24h / 50, 1.0); // 50% = максимум
    const normalizedSpread = Math.max(0, 1.0 - (spread / 0.1)); // 0.1% = минимум (инвертировано)
    const normalizedPriceChange = Math.min(Math.abs(priceChange5m) / 10, 1.0); // 10% = максимум

    // Взвешенный score
    const score = (
      normalizedVolume * 0.3 + // 30% - объем (ликвидность)
      normalizedVolatility * 0.25 + // 25% - волатильность
      normalizedSpread * 0.25 + // 25% - узкий спред
      normalizedPriceChange * 0.2 // 20% - изменение за 5 минут
    );

    return score;
  }
}

