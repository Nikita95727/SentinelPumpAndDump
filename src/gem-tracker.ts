/**
 * Gem Tracker - Система раннего выявления самородков
 * 
 * Стратегия:
 * 1. Мониторит токены, прошедшие honeypot check (без входа)
 * 2. Отслеживает индикаторы роста (цена, объем, держатели, капитализация)
 * 3. Выявляет самородки на ранней стадии
 * 4. Триггерит вход только в подтвержденные самородки
 */

import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';
import { priceFetcher } from './price-fetcher';
import { TokenFilters } from './filters';
import { Connection } from '@solana/web3.js';

interface GemObservation {
  mint: string;
  detectedAt: number; // Когда токен был обнаружен
  initialPrice: number; // Начальная цена
  initialVolume: number; // Начальный объем (USD)
  initialHolders: number; // Начальное количество держателей
  initialMarketCap: number; // Начальная капитализация (USD)
  
  // Текущие значения
  currentPrice: number;
  currentVolume: number;
  currentHolders: number;
  currentMarketCap: number;
  
  // История цен для расчета импульса
  priceHistory: Array<{ price: number; timestamp: number }>;
  
  // Индикаторы
  priceMomentum: number; // Скорость роста цены (x/сек)
  volumeGrowth: number; // Рост объема (%)
  holderGrowth: number; // Рост держателей (%)
  marketCapGrowth: number; // Рост капитализации (%)
  gemScore: number; // Комбинированный индикатор самородка (0-1)
  
  // Статус
  isGem: boolean; // Является ли самородком
  entryTriggered: boolean; // Был ли триггер входа
  lastUpdate: number; // Последнее обновление
}

export class GemTracker {
  private observations = new Map<string, GemObservation>();
  private readonly MONITORING_INTERVAL_MS = 5000; // Проверка каждые 5 секунд
  private readonly MAX_MONITORING_TIME_MS = 120_000; // Максимальное время мониторинга: 2 минуты
  private readonly MIN_GEM_SCORE = 0.5; // Минимальный gem score для входа
  private readonly MIN_PRICE_MOMENTUM = 0.05; // Минимальная скорость роста (x/сек)
  private readonly MIN_VOLUME_GROWTH = 0.5; // Минимальный рост объема (50%)
  private readonly MIN_ENTRY_MULTIPLIER = 2.0; // Минимальный multiplier для входа
  private onGemDetectedCallback: ((candidate: TokenCandidate, observation: GemObservation) => void) | null = null;

  constructor(
    private connection: Connection,
    private filters: TokenFilters
  ) {}

  /**
   * Устанавливает callback для уведомления о найденных самородках
   */
  setOnGemDetected(callback: (candidate: TokenCandidate, observation: GemObservation) => void): void {
    this.onGemDetectedCallback = callback;
  }

  /**
   * Начинает мониторинг токена (без входа)
   * Вызывается для токенов, прошедших honeypot check
   */
  async startMonitoring(candidate: TokenCandidate): Promise<void> {
    // Проверяем, не мониторим ли уже этот токен
    if (this.observations.has(candidate.mint)) {
      return;
    }

    try {
      // Получаем начальные значения
      const initialPrice = await priceFetcher.getPrice(candidate.mint);
      if (initialPrice <= 0) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: candidate.mint,
          message: `⚠️ GEM TRACKER: Invalid initial price for ${candidate.mint.substring(0, 8)}..., skipping monitoring`,
        });
        return;
      }

      // Получаем начальный объем и держателей
      const initialVolume = await this.filters.getTradingVolume(candidate.mint, true);
      const initialHolders = await this.getHolderCount(candidate.mint);
      const marketData = await priceFetcher.getMarketData(candidate.mint);
      const initialMarketCap = marketData?.marketCap || 0;

      // Создаем наблюдение
      const observation: GemObservation = {
        mint: candidate.mint,
        detectedAt: Date.now(),
        initialPrice,
        initialVolume,
        initialHolders,
        initialMarketCap,
        currentPrice: initialPrice,
        currentVolume: initialVolume,
        currentHolders: initialHolders,
        currentMarketCap: initialMarketCap,
        priceHistory: [{ price: initialPrice, timestamp: Date.now() }],
        priceMomentum: 0,
        volumeGrowth: 0,
        holderGrowth: 0,
        marketCapGrowth: 0,
        gemScore: 0,
        isGem: false,
        entryTriggered: false,
        lastUpdate: Date.now(),
      };

      this.observations.set(candidate.mint, observation);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🔍 GEM TRACKER: Started monitoring ${candidate.mint.substring(0, 8)}..., initialPrice=${initialPrice.toFixed(10)} SOL, initialVolume=$${initialVolume.toFixed(2)}, initialHolders=${initialHolders}`,
      });

      // Запускаем мониторинг в фоне
      this.monitorToken(candidate, observation).catch(error => {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: candidate.mint,
          message: `❌ GEM TRACKER: Error monitoring ${candidate.mint.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        message: `❌ GEM TRACKER: Failed to start monitoring ${candidate.mint.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Мониторит токен и выявляет самородки
   */
  private async monitorToken(candidate: TokenCandidate, observation: GemObservation): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < this.MAX_MONITORING_TIME_MS) {
      const now = Date.now();
      const timeElapsed = (now - observation.detectedAt) / 1000; // секунды

      try {
        // Получаем текущие значения
        const currentPrice = await priceFetcher.getPrice(candidate.mint);
        if (currentPrice <= 0) {
          await sleep(this.MONITORING_INTERVAL_MS);
          continue;
        }

        const currentVolume = await this.filters.getTradingVolume(candidate.mint, true);
        const currentHolders = await this.getHolderCount(candidate.mint);
        const marketData = await priceFetcher.getMarketData(candidate.mint);
        const currentMarketCap = marketData?.marketCap || 0;

        // Обновляем историю цен
        observation.priceHistory.push({ price: currentPrice, timestamp: now });
        // Ограничиваем историю последними 10 значениями
        if (observation.priceHistory.length > 10) {
          observation.priceHistory.shift();
        }

        // Обновляем текущие значения
        observation.currentPrice = currentPrice;
        observation.currentVolume = currentVolume;
        observation.currentHolders = currentHolders;
        observation.currentMarketCap = currentMarketCap;
        observation.lastUpdate = now;

        // Рассчитываем индикаторы
        this.calculateIndicators(observation, timeElapsed);

        // Проверяем, является ли самородком
        const isGem = this.checkIfGem(observation);

        if (isGem && !observation.entryTriggered) {
          // САМОРОДОК ОБНАРУЖЕН!
          observation.isGem = true;
          observation.entryTriggered = true;

          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `💎 GEM DETECTED: ${candidate.mint.substring(0, 8)}... | multiplier=${(currentPrice / observation.initialPrice).toFixed(3)}x, gemScore=${observation.gemScore.toFixed(3)}, priceMomentum=${observation.priceMomentum.toFixed(4)}x/sec, volumeGrowth=${(observation.volumeGrowth * 100).toFixed(1)}%`,
          });

          // Уведомляем о самородке
          if (this.onGemDetectedCallback) {
            this.onGemDetectedCallback(candidate, observation);
          }

          // Прекращаем мониторинг (токен передан на вход)
          break;
        }

        // Логируем прогресс каждые 30 секунд
        if (timeElapsed % 30 < 5) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `🔍 GEM TRACKER: ${candidate.mint.substring(0, 8)}... | multiplier=${(currentPrice / observation.initialPrice).toFixed(3)}x, gemScore=${observation.gemScore.toFixed(3)}, monitoring for ${timeElapsed.toFixed(1)}s`,
          });
        }

        await sleep(this.MONITORING_INTERVAL_MS);
      } catch (error) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: candidate.mint,
          message: `❌ GEM TRACKER: Error updating observation for ${candidate.mint.substring(0, 8)}...: ${error instanceof Error ? error.message : String(error)}`,
        });
        await sleep(this.MONITORING_INTERVAL_MS);
      }
    }

    // Удаляем наблюдение после окончания мониторинга
    this.observations.delete(candidate.mint);
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: candidate.mint,
      message: `🔍 GEM TRACKER: Stopped monitoring ${candidate.mint.substring(0, 8)}... (timeout or gem detected)`,
    });
  }

  /**
   * Рассчитывает индикаторы самородка
   */
  private calculateIndicators(observation: GemObservation, timeElapsed: number): void {
    // 1. Price Momentum (скорость роста цены)
    if (timeElapsed > 0 && observation.priceHistory.length >= 2) {
      const recentPrices = observation.priceHistory.slice(-3); // Последние 3 цены
      const priceChange = recentPrices[recentPrices.length - 1].price - recentPrices[0].price;
      const timeChange = (recentPrices[recentPrices.length - 1].timestamp - recentPrices[0].timestamp) / 1000; // секунды
      
      if (timeChange > 0) {
        const currentMultiplier = observation.currentPrice / observation.initialPrice;
        observation.priceMomentum = (currentMultiplier - 1) / timeElapsed; // x/сек
      }
    }

    // 2. Volume Growth (рост объема)
    if (observation.initialVolume > 0) {
      observation.volumeGrowth = (observation.currentVolume - observation.initialVolume) / observation.initialVolume;
    } else {
      observation.volumeGrowth = observation.currentVolume > 0 ? 1.0 : 0;
    }

    // 3. Holder Growth (рост держателей)
    if (observation.initialHolders > 0) {
      observation.holderGrowth = (observation.currentHolders - observation.initialHolders) / observation.initialHolders;
    } else {
      observation.holderGrowth = observation.currentHolders > 0 ? 1.0 : 0;
    }

    // 4. Market Cap Growth (рост капитализации)
    if (observation.initialMarketCap > 0) {
      observation.marketCapGrowth = (observation.currentMarketCap - observation.initialMarketCap) / observation.initialMarketCap;
    } else {
      observation.marketCapGrowth = observation.currentMarketCap > 0 ? 1.0 : 0;
    }

    // 5. Gem Score (комбинированный индикатор)
    // Нормализуем индикаторы и взвешиваем
    const normalizedPriceMomentum = Math.min(observation.priceMomentum / 0.2, 1.0); // 0.2x/сек = максимум
    const normalizedVolumeGrowth = Math.min(observation.volumeGrowth / 2.0, 1.0); // 200% рост = максимум
    const normalizedHolderGrowth = Math.min(observation.holderGrowth / 1.0, 1.0); // 100% рост = максимум
    const normalizedMarketCapGrowth = Math.min(observation.marketCapGrowth / 1.0, 1.0); // 100% рост = максимум

    observation.gemScore = (
      normalizedPriceMomentum * 0.4 + // 40% - цена
      normalizedVolumeGrowth * 0.3 + // 30% - объем
      normalizedHolderGrowth * 0.2 + // 20% - держатели
      normalizedMarketCapGrowth * 0.1 // 10% - капитализация
    );
  }

  /**
   * Проверяет, является ли токен самородком
   */
  private checkIfGem(observation: GemObservation): boolean {
    const currentMultiplier = observation.currentPrice / observation.initialPrice;

    // Критерии самородка:
    // 1. Multiplier ≥ 2.0x (токен уже показал рост)
    if (currentMultiplier < this.MIN_ENTRY_MULTIPLIER) {
      return false;
    }

    // 2. Gem Score ≥ 0.5 (комбинированный индикатор)
    if (observation.gemScore < this.MIN_GEM_SCORE) {
      return false;
    }

    // 3. Price Momentum ≥ 0.05x/сек (быстрый рост)
    if (observation.priceMomentum < this.MIN_PRICE_MOMENTUM) {
      return false;
    }

    // 4. Volume Growth ≥ 50% (объем растет)
    if (observation.volumeGrowth < this.MIN_VOLUME_GROWTH) {
      return false;
    }

    // 5. Нет резких падений (цена не падала >10% от пика)
    if (observation.priceHistory.length >= 2) {
      const peakPrice = Math.max(...observation.priceHistory.map(p => p.price));
      const dropFromPeak = (peakPrice - observation.currentPrice) / peakPrice;
      if (dropFromPeak > 0.10) {
        return false; // Упало больше чем на 10% от пика
      }
    }

    return true;
  }

  /**
   * Получает количество держателей токена
   */
  private async getHolderCount(mint: string): Promise<number> {
    try {
      // Используем метод из filters для получения количества держателей
      // Для упрощения используем количество уникальных покупателей
      // Метод checkHoneypotAndScam приватный, используем упрощенный подход
      // Получаем количество уникальных покупателей через транзакции
      const connection = this.filters['connection'] || this.connection;
      const { PublicKey } = await import('@solana/web3.js');
      const mintPubkey = new PublicKey(mint);
      
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        limit: 30,
      });
      
      // Для упрощения считаем количество уникальных подписей как индикатор активности
      // В реальности нужно анализировать транзакции, но это медленно
      // Используем количество транзакций как приблизительный индикатор
      return Math.min(signatures.length, 50); // Максимум 50 для упрощения
    } catch (error) {
      return 0;
    }
  }

  /**
   * Получает наблюдение за токеном
   */
  getObservation(mint: string): GemObservation | undefined {
    return this.observations.get(mint);
  }

  /**
   * Останавливает мониторинг токена
   */
  stopMonitoring(mint: string): void {
    this.observations.delete(mint);
  }

  /**
   * Очищает старые наблюдения
   */
  cleanup(): void {
    const now = Date.now();
    for (const [mint, observation] of this.observations.entries()) {
      if (now - observation.lastUpdate > this.MAX_MONITORING_TIME_MS) {
        this.observations.delete(mint);
      }
    }
  }
}

