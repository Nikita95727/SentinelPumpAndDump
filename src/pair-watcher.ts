/**
 * Pair Watcher
 * Мониторит одну пару для выявления валидного импульса
 * Независимый, не блокирует другие пары
 */

import { BybitClient } from './bybit-client';
import { TradingPair } from './market-scanner';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';

export interface MomentumSignal {
  isValid: boolean;
  velocity: number; // Скорость изменения цены (x/сек)
  acceleration: number; // Ускорение (x/сек²)
  predictedPrice: number; // Прогнозируемая цена через короткий период
  predictedChange: number; // Прогнозируемое изменение в %
  confidence: number; // Уверенность в сигнале (0-1)
}

export class PairWatcher {
  private symbol: string;
  private bybitClient: BybitClient;
  private isWatching = false;
  private watchInterval: NodeJS.Timeout | null = null;
  private priceHistory: Array<{ price: number; timestamp: number }> = [];
  private readonly MAX_HISTORY = 10; // Храним последние 10 точек
  private readonly CHECK_INTERVAL = 1000; // Проверка каждую секунду
  private onMomentumDetectedCallback: ((symbol: string, signal: MomentumSignal) => void) | null = null;

  constructor(symbol: string, bybitClient: BybitClient) {
    this.symbol = symbol;
    this.bybitClient = bybitClient;
  }

  /**
   * Устанавливает callback для уведомления о валидном импульсе
   */
  setOnMomentumDetected(callback: (symbol: string, signal: MomentumSignal) => void): void {
    this.onMomentumDetectedCallback = callback;
  }

  /**
   * Начинает мониторинг пары
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.isWatching = true;
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      symbol: this.symbol,
      message: `👁️ Pair Watcher: Started watching ${this.symbol}`,
    });

    // Запускаем мониторинг
    this.watch();
  }

  /**
   * Останавливает мониторинг
   */
  stop(): void {
    this.isWatching = false;
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      symbol: this.symbol,
      message: `👁️ Pair Watcher: Stopped watching ${this.symbol}`,
    });
  }

  /**
   * Мониторит пару и выявляет импульс
   */
  private async watch(): Promise<void> {
    while (this.isWatching) {
      try {
        // Получаем текущую цену
        const ticker = await this.bybitClient.getTicker(this.symbol);
        if (!ticker || ticker.lastPrice <= 0) {
          await sleep(this.CHECK_INTERVAL);
          continue;
        }

        const currentPrice = ticker.lastPrice;
        const now = Date.now();

        // Обновляем историю цен
        this.priceHistory.push({ price: currentPrice, timestamp: now });
        if (this.priceHistory.length > this.MAX_HISTORY) {
          this.priceHistory.shift();
        }

        // Рассчитываем импульс
        const signal = this.calculateMomentum();

        // Проверяем валидность импульса
        if (signal.isValid && this.onMomentumDetectedCallback) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            symbol: this.symbol,
            message: `💎 Momentum detected: ${this.symbol} | velocity=${signal.velocity.toFixed(6)}x/sec, acceleration=${signal.acceleration.toFixed(6)}x/sec², predictedChange=${signal.predictedChange.toFixed(3)}%, confidence=${signal.confidence.toFixed(3)}`,
          });
          
          this.onMomentumDetectedCallback(this.symbol, signal);
        }

        await sleep(this.CHECK_INTERVAL);
      } catch (error) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          symbol: this.symbol,
          message: `Error watching ${this.symbol}: ${error instanceof Error ? error.message : String(error)}`,
        });
        await sleep(this.CHECK_INTERVAL);
      }
    }
  }

  /**
   * Рассчитывает импульс на основе истории цен
   */
  private calculateMomentum(): MomentumSignal {
    if (this.priceHistory.length < 5) {
      // Недостаточно данных
      return {
        isValid: false,
        velocity: 0,
        acceleration: 0,
        predictedPrice: 0,
        predictedChange: 0,
        confidence: 0,
      };
    }

    const recent = this.priceHistory.slice(-5); // Последние 5 точек
    const now = Date.now();

    // Рассчитываем velocity (скорость) - изменение цены за единицу времени
    const priceChange = recent[recent.length - 1].price - recent[0].price;
    const timeChange = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 1000; // секунды
    
    if (timeChange <= 0) {
      return {
        isValid: false,
        velocity: 0,
        acceleration: 0,
        predictedPrice: 0,
        predictedChange: 0,
        confidence: 0,
      };
    }

    const basePrice = recent[0].price;
    const velocity = (priceChange / basePrice) / timeChange; // x/сек

    // Рассчитываем acceleration (ускорение) - изменение velocity
    const midPoint = Math.floor(recent.length / 2);
    const firstHalfVelocity = (recent[midPoint].price - recent[0].price) / basePrice / ((recent[midPoint].timestamp - recent[0].timestamp) / 1000);
    const secondHalfVelocity = (recent[recent.length - 1].price - recent[midPoint].price) / basePrice / ((recent[recent.length - 1].timestamp - recent[midPoint].timestamp) / 1000);
    const timeForAcceleration = (recent[recent.length - 1].timestamp - recent[midPoint].timestamp) / 1000;
    
    const acceleration = timeForAcceleration > 0 
      ? (secondHalfVelocity - firstHalfVelocity) / timeForAcceleration 
      : 0;

    // Проверяем на резкие откаты
    let hasReversal = false;
    for (let i = 1; i < recent.length; i++) {
      const prevChange = (recent[i].price - recent[i - 1].price) / recent[i - 1].price;
      if (prevChange < -0.002) { // Откат больше 0.2%
        hasReversal = true;
        break;
      }
    }

    // Прогнозируем цену через короткий период (например, 5 секунд)
    const predictionTime = 5; // секунды
    const predictedPrice = recent[recent.length - 1].price * (1 + velocity * predictionTime + 0.5 * acceleration * predictionTime * predictionTime);
    const predictedChange = ((predictedPrice - recent[recent.length - 1].price) / recent[recent.length - 1].price) * 100;

    // Рассчитываем confidence (уверенность)
    // Выше confidence если:
    // - velocity положительная и стабильная
    // - acceleration положительная или нулевая (не отрицательная)
    // - нет резких откатов
    // - движение устойчиво во времени
    let confidence = 0;
    if (velocity > 0 && !hasReversal) {
      confidence = 0.5; // Базовая уверенность
      
      if (acceleration >= 0) {
        confidence += 0.2; // Ускорение не отрицательное
      }
      
      if (velocity > 0.0001) { // velocity > 0.01%/сек
        confidence += 0.2;
      }
      
      if (recent.length >= 5) {
        confidence += 0.1; // Достаточно данных
      }
    }

    // Валидный импульс если:
    // 1. velocity > 0 (цена растет)
    // 2. acceleration >= -0.00001 (не замедляется резко)
    // 3. predictedChange >= 0.8% (прогнозируемое движение достаточное)
    // 4. confidence >= 0.7
    // 5. Нет резких откатов
    const isValid = 
      velocity > 0 &&
      acceleration >= -0.00001 &&
      predictedChange >= 0.8 &&
      confidence >= 0.7 &&
      !hasReversal;

    return {
      isValid,
      velocity,
      acceleration,
      predictedPrice,
      predictedChange,
      confidence,
    };
  }

  /**
   * Получает текущий символ
   */
  getSymbol(): string {
    return this.symbol;
  }
}

