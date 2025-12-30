/**
 * Concentrated Liquidity Tracker
 * Отслеживает токены с концентрированной ликвидностью (>50% у одного держателя)
 * для поиска возможностей безопасного входа/выхода
 */

import { logger } from './logger';
import { priceFetcher } from './price-fetcher';
import { TokenFilters } from './filters';
import { getCurrentTimestamp, sleep } from './utils';
import { Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

interface ConcentratedTokenSnapshot {
  timestamp: number;
  price: number;
  liquidity: number;
  holders: number;
  topHolderPct: number;
  volume24h?: number;
  priceChange24h?: number;
  marketCap?: number;
}

interface ConcentratedTokenData {
  mint: string;
  firstDetected: number;
  lastUpdate: number;
  snapshots: ConcentratedTokenSnapshot[];
  peakPrice: number;
  peakPriceTime: number;
  lowestPrice: number;
  lowestPriceTime: number;
  maxLiquidity: number;
  minLiquidity: number;
  entryOpportunities: Array<{
    timestamp: number;
    price: number;
    liquidity: number;
    reason: string;
  }>;
  exitOpportunities: Array<{
    timestamp: number;
    price: number;
    multiplier: number;
    reason: string;
  }>;
  status: 'tracking' | 'completed' | 'abandoned';
}

export class ConcentratedLiquidityTracker {
  private trackedTokens = new Map<string, ConcentratedTokenData>();
  private filters: TokenFilters;
  private connection: Connection;
  private logDir: string;
  private isRunning = false;
  private trackingInterval: NodeJS.Timeout | null = null;
  private readonly TRACKING_DURATION = 24 * 60 * 60 * 1000; // 24 часа
  private readonly SNAPSHOT_INTERVAL = 30 * 1000; // Снимок каждые 30 секунд
  private readonly PRICE_CHECK_INTERVAL = 10 * 1000; // Проверка цены каждые 10 секунд

  constructor(connection: Connection, filters: TokenFilters) {
    this.connection = connection;
    this.filters = filters;
    this.logDir = path.join(process.cwd(), 'logs', 'concentrated-liquidity');
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Начинает отслеживание токена с концентрированной ликвидностью
   */
  async startTracking(mint: string, initialData: {
    liquidity: number;
    holders: number;
    topHolderPct: number;
  }): Promise<void> {
    if (this.trackedTokens.has(mint)) {
      return; // Уже отслеживается
    }

    const now = Date.now();
    const initialPrice = await priceFetcher.getPrice(mint);

    const tokenData: ConcentratedTokenData = {
      mint,
      firstDetected: now,
      lastUpdate: now,
      snapshots: [{
        timestamp: now,
        price: initialPrice || 0,
        liquidity: initialData.liquidity,
        holders: initialData.holders,
        topHolderPct: initialData.topHolderPct,
      }],
      peakPrice: initialPrice || 0,
      peakPriceTime: now,
      lowestPrice: initialPrice || 0,
      lowestPriceTime: now,
      maxLiquidity: initialData.liquidity,
      minLiquidity: initialData.liquidity,
      entryOpportunities: [],
      exitOpportunities: [],
      status: 'tracking',
    };

    this.trackedTokens.set(mint, tokenData);

    // Логируем начало отслеживания
    await this.logEvent(mint, 'TRACKING_STARTED', {
      liquidity: initialData.liquidity,
      holders: initialData.holders,
      topHolderPct: initialData.topHolderPct,
      initialPrice,
    });

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔍 [CONCENTRATED LIQUIDITY] Started tracking: ${mint.substring(0, 12)}... | Liquidity: $${initialData.liquidity.toFixed(2)}, Holders: ${initialData.holders}, Top holder: ${initialData.topHolderPct.toFixed(1)}%, Initial price: ${initialPrice?.toFixed(10) || 'N/A'}`,
    });

    // Запускаем мониторинг если еще не запущен
    if (!this.isRunning) {
      this.startMonitoring();
    }
  }

  /**
   * Запускает фоновый мониторинг всех отслеживаемых токенов
   */
  private startMonitoring(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.trackingInterval = setInterval(() => {
      this.monitorAllTokens().catch(error => {
        console.error('[ConcentratedLiquidityTracker] Error in monitoring:', error);
      });
    }, this.PRICE_CHECK_INTERVAL);

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔍 [CONCENTRATED LIQUIDITY] Monitoring started for ${this.trackedTokens.size} tokens`,
    });
  }

  /**
   * Мониторит все отслеживаемые токены
   */
  private async monitorAllTokens(): Promise<void> {
    const now = Date.now();
    const tokensToRemove: string[] = [];

    for (const [mint, tokenData] of this.trackedTokens.entries()) {
      // Проверяем, не истекло ли время отслеживания
      if (now - tokenData.firstDetected > this.TRACKING_DURATION) {
        tokenData.status = 'completed';
        await this.logEvent(mint, 'TRACKING_COMPLETED', {
          duration: now - tokenData.firstDetected,
          finalPrice: tokenData.snapshots[tokenData.snapshots.length - 1]?.price || 0,
        });
        tokensToRemove.push(mint);
        continue;
      }

      try {
        await this.updateTokenSnapshot(mint, tokenData);
      } catch (error) {
        console.error(`[ConcentratedLiquidityTracker] Error updating ${mint}:`, error);
      }
    }

    // Удаляем завершенные токены
    for (const mint of tokensToRemove) {
      this.trackedTokens.delete(mint);
    }
  }

  /**
   * Обновляет снимок токена
   */
  private async updateTokenSnapshot(mint: string, tokenData: ConcentratedTokenData): Promise<void> {
    const now = Date.now();
    
    // Проверяем, нужно ли делать новый снимок
    const lastSnapshot = tokenData.snapshots[tokenData.snapshots.length - 1];
    if (lastSnapshot && now - lastSnapshot.timestamp < this.SNAPSHOT_INTERVAL) {
      return; // Слишком рано для нового снимка
    }

    // Получаем текущую цену
    const currentPrice = await priceFetcher.getPrice(mint);
    if (currentPrice <= 0) {
      return; // Не удалось получить цену
    }

    // Получаем текущие данные о ликвидности и holders
    let liquidity = lastSnapshot?.liquidity || 0;
    let holders = lastSnapshot?.holders || 0;
    let topHolderPct = lastSnapshot?.topHolderPct || 0;

    try {
      // Пытаемся получить актуальные данные о ликвидности
      const liquidityData = await this.filters.getLiquidityDistribution(mint);
      if (liquidityData) {
        liquidity = liquidityData.totalLiquidity;
        holders = liquidityData.uniqueHolders;
        topHolderPct = liquidityData.topHolderPercentage;
      }
    } catch (error) {
      // Используем последние известные значения
    }

    // Создаем новый снимок
    const snapshot: ConcentratedTokenSnapshot = {
      timestamp: now,
      price: currentPrice,
      liquidity,
      holders,
      topHolderPct,
    };

    tokenData.snapshots.push(snapshot);
    tokenData.lastUpdate = now;

    // Обновляем пики и минимумы
    if (currentPrice > tokenData.peakPrice) {
      tokenData.peakPrice = currentPrice;
      tokenData.peakPriceTime = now;
    }
    if (currentPrice < tokenData.lowestPrice || tokenData.lowestPrice === 0) {
      tokenData.lowestPrice = currentPrice;
      tokenData.lowestPriceTime = now;
    }
    if (liquidity > tokenData.maxLiquidity) {
      tokenData.maxLiquidity = liquidity;
    }
    if (liquidity < tokenData.minLiquidity || tokenData.minLiquidity === 0) {
      tokenData.minLiquidity = liquidity;
    }

    // Анализируем возможности входа/выхода
    await this.analyzeOpportunities(mint, tokenData, snapshot);

    // Логируем снимок
    await this.logSnapshot(mint, snapshot, tokenData);
  }

  /**
   * Анализирует возможности входа/выхода
   */
  private async analyzeOpportunities(
    mint: string,
    tokenData: ConcentratedTokenData,
    snapshot: ConcentratedTokenSnapshot
  ): Promise<void> {
    const snapshots = tokenData.snapshots;
    if (snapshots.length < 3) return; // Нужно минимум 3 снимка для анализа

    const currentPrice = snapshot.price;
    const initialPrice = snapshots[0].price;
    const priceChange = (currentPrice / initialPrice - 1) * 100;

    // Анализ возможностей ВХОДА
    // 1. Цена упала значительно от пика (возможность отскока)
    const priceFromPeak = (currentPrice / tokenData.peakPrice - 1) * 100;
    if (priceFromPeak < -20 && currentPrice > 0) {
      // Цена упала более чем на 20% от пика
      const existing = tokenData.entryOpportunities.find(
        opp => Math.abs(opp.timestamp - snapshot.timestamp) < 60000 // В пределах минуты
      );
      if (!existing) {
        tokenData.entryOpportunities.push({
          timestamp: snapshot.timestamp,
          price: currentPrice,
          liquidity: snapshot.liquidity,
          reason: `Price dropped ${priceFromPeak.toFixed(1)}% from peak (potential bounce)`,
        });
        await this.logEvent(mint, 'ENTRY_OPPORTUNITY', {
          price: currentPrice,
          priceFromPeak,
          liquidity: snapshot.liquidity,
          reason: 'Price drop from peak',
        });
      }
    }

    // 2. Ликвидность увеличилась (возможно, манипулятор добавляет ликвидность)
    if (snapshots.length >= 2) {
      const prevSnapshot = snapshots[snapshots.length - 2];
      const liquidityChange = ((snapshot.liquidity - prevSnapshot.liquidity) / prevSnapshot.liquidity) * 100;
      if (liquidityChange > 10 && snapshot.liquidity > 1000) {
        // Ликвидность выросла более чем на 10%
        const existing = tokenData.entryOpportunities.find(
          opp => Math.abs(opp.timestamp - snapshot.timestamp) < 60000
        );
        if (!existing) {
          tokenData.entryOpportunities.push({
            timestamp: snapshot.timestamp,
            price: currentPrice,
            liquidity: snapshot.liquidity,
            reason: `Liquidity increased ${liquidityChange.toFixed(1)}% (manipulator adding liquidity?)`,
          });
          await this.logEvent(mint, 'ENTRY_OPPORTUNITY', {
            price: currentPrice,
            liquidityChange,
            liquidity: snapshot.liquidity,
            reason: 'Liquidity increase',
          });
        }
      }
    }

    // Анализ возможностей ВЫХОДА
    // 1. Цена выросла значительно (прибыль)
    if (priceChange > 50 && currentPrice > 0) {
      const multiplier = currentPrice / initialPrice;
      const existing = tokenData.exitOpportunities.find(
        opp => Math.abs(opp.timestamp - snapshot.timestamp) < 60000
      );
      if (!existing) {
        tokenData.exitOpportunities.push({
          timestamp: snapshot.timestamp,
          price: currentPrice,
          multiplier,
          reason: `Price increased ${priceChange.toFixed(1)}% from entry (${multiplier.toFixed(2)}x)`,
        });
        await this.logEvent(mint, 'EXIT_OPPORTUNITY', {
          price: currentPrice,
          multiplier,
          priceChange,
          reason: 'Significant price increase',
        });
      }
    }

    // 2. Ликвидность резко уменьшилась (возможно, манипулятор выводит ликвидность)
    if (snapshots.length >= 2) {
      const prevSnapshot = snapshots[snapshots.length - 2];
      const liquidityChange = ((snapshot.liquidity - prevSnapshot.liquidity) / prevSnapshot.liquidity) * 100;
      if (liquidityChange < -30 && priceChange > 0) {
        // Ликвидность упала более чем на 30%, но цена еще положительная
        const multiplier = currentPrice / initialPrice;
        const existing = tokenData.exitOpportunities.find(
          opp => Math.abs(opp.timestamp - snapshot.timestamp) < 60000
        );
        if (!existing) {
          tokenData.exitOpportunities.push({
            timestamp: snapshot.timestamp,
            price: currentPrice,
            multiplier,
            reason: `Liquidity dropped ${Math.abs(liquidityChange).toFixed(1)}% (manipulator withdrawing? Exit now!)`,
          });
          await this.logEvent(mint, 'EXIT_OPPORTUNITY', {
            price: currentPrice,
            multiplier,
            liquidityChange,
            reason: 'Liquidity withdrawal warning',
          });
        }
      }
    }
  }

  /**
   * Логирует снимок токена
   */
  private async logSnapshot(mint: string, snapshot: ConcentratedTokenSnapshot, tokenData: ConcentratedTokenData): Promise<void> {
    const logFile = path.join(this.logDir, `${mint}.jsonl`);
    const logEntry = {
      timestamp: new Date(snapshot.timestamp).toISOString(),
      mint,
      snapshot,
      stats: {
        peakPrice: tokenData.peakPrice,
        lowestPrice: tokenData.lowestPrice,
        maxLiquidity: tokenData.maxLiquidity,
        minLiquidity: tokenData.minLiquidity,
        entryOpportunities: tokenData.entryOpportunities.length,
        exitOpportunities: tokenData.exitOpportunities.length,
      },
    };

    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');

    // Также логируем в основной лог каждые 5 минут
    const lastLogTime = (tokenData as any).lastLogTime || 0;
    if (Date.now() - lastLogTime > 5 * 60 * 1000) {
      (tokenData as any).lastLogTime = Date.now();
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `🔍 [CONCENTRATED] ${mint.substring(0, 12)}... | Price: ${snapshot.price.toFixed(10)}, Liq: $${snapshot.liquidity.toFixed(2)}, Holders: ${snapshot.holders}, Top: ${snapshot.topHolderPct.toFixed(1)}% | Peak: ${tokenData.peakPrice.toFixed(10)} (${((snapshot.price / tokenData.peakPrice - 1) * 100).toFixed(1)}%) | Entry opps: ${tokenData.entryOpportunities.length}, Exit opps: ${tokenData.exitOpportunities.length}`,
      });
    }
  }

  /**
   * Логирует событие
   */
  private async logEvent(mint: string, eventType: string, data: any): Promise<void> {
    const logFile = path.join(this.logDir, `${mint}.events.jsonl`);
    const logEntry = {
      timestamp: getCurrentTimestamp(),
      mint,
      eventType,
      data,
    };

    fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔍 [CONCENTRATED] ${eventType}: ${mint.substring(0, 12)}... | ${JSON.stringify(data)}`,
    });
  }

  /**
   * Получает статистику по отслеживаемому токену
   */
  getTokenStats(mint: string): ConcentratedTokenData | null {
    return this.trackedTokens.get(mint) || null;
  }

  /**
   * Получает все отслеживаемые токены
   */
  getAllTrackedTokens(): string[] {
    return Array.from(this.trackedTokens.keys());
  }

  /**
   * Останавливает отслеживание
   */
  stop(): void {
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }
    this.isRunning = false;

    // Сохраняем финальные данные
    for (const [mint, tokenData] of this.trackedTokens.entries()) {
      this.saveFinalReport(mint, tokenData);
    }
  }

  /**
   * Сохраняет финальный отчет по токену
   */
  private saveFinalReport(mint: string, tokenData: ConcentratedTokenData): void {
    const reportFile = path.join(this.logDir, `${mint}.report.json`);
    const report = {
      mint,
      firstDetected: new Date(tokenData.firstDetected).toISOString(),
      lastUpdate: new Date(tokenData.lastUpdate).toISOString(),
      duration: tokenData.lastUpdate - tokenData.firstDetected,
      snapshots: tokenData.snapshots.length,
      peakPrice: tokenData.peakPrice,
      peakPriceTime: new Date(tokenData.peakPriceTime).toISOString(),
      lowestPrice: tokenData.lowestPrice,
      lowestPriceTime: new Date(tokenData.lowestPriceTime).toISOString(),
      maxLiquidity: tokenData.maxLiquidity,
      minLiquidity: tokenData.minLiquidity,
      entryOpportunities: tokenData.entryOpportunities,
      exitOpportunities: tokenData.exitOpportunities,
      finalPrice: tokenData.snapshots[tokenData.snapshots.length - 1]?.price || 0,
      initialPrice: tokenData.snapshots[0]?.price || 0,
      totalReturn: tokenData.snapshots[0]?.price 
        ? ((tokenData.snapshots[tokenData.snapshots.length - 1]?.price || 0) / tokenData.snapshots[0].price - 1) * 100
        : 0,
    };

    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }
}

