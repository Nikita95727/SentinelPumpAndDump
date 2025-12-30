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
  priceVelocity?: number; // Изменение цены за период (для детекции импульса)
  liquidityVelocity?: number; // Изменение ликвидности за период
}

type ManipulationPhase = 'accumulation' | 'pump' | 'dump' | 'recovery' | 'unknown';

interface ManipulationPattern {
  phase: ManipulationPhase;
  confidence: number; // 0-1
  detectedAt: number;
  expectedDuration?: number; // Ожидаемая длительность фазы в мс
  entrySafety?: number; // 0-1, безопасность входа в этой фазе
  exitUrgency?: number; // 0-1, срочность выхода
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
  peakMarketCap: number; // ⭐ Пиковая капитализация (для расчета slippage при выходе)
  peakMarketCapTime: number; // ⭐ Время достижения пиковой капитализации
  initialMarketCap: number; // ⭐ Начальная капитализация
  entryOpportunities: Array<{
    timestamp: number;
    price: number;
    liquidity: number;
    reason: string;
    estimatedSlippage?: number;
    safetyScore?: number; // 0-1
    marketCap?: number; // ⭐ Капитализация на момент возможности входа
  }>;
  exitOpportunities: Array<{
    timestamp: number;
    price: number;
    multiplier: number;
    reason: string;
    urgency?: number; // 0-1
    marketCap?: number; // ⭐ Капитализация на момент возможности выхода
    estimatedExitSlippage?: number; // ⭐ Ожидаемый slippage при выходе на основе капитализации
  }>;
  manipulationPhases: ManipulationPattern[];
  currentPhase: ManipulationPhase;
  phaseHistory: Array<{
    phase: ManipulationPhase;
    startTime: number;
    endTime?: number;
    duration?: number;
  }>;
  estimatedSlippage: {
    entry: number; // Ожидаемый slippage при входе
    exit: number; // Ожидаемый slippage при выходе (на основе пиковой капитализации)
    lastCalculated: number;
  };
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
  
  // Метрики для анализа паттернов
  private readonly MIN_SNAPSHOTS_FOR_PATTERN = 10; // Минимум снимков для анализа паттерна
  private readonly PATTERN_ANALYSIS_INTERVAL = 5 * 60 * 1000; // Анализ паттернов каждые 5 минут

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

    // ⭐ Получаем начальную капитализацию
    let initialMarketCap = 0;
    try {
      const marketData = await priceFetcher.getMarketData(mint);
      initialMarketCap = marketData?.marketCap || 0;
    } catch (error) {
      // Игнорируем ошибки получения капитализации
    }

    // Рассчитываем ожидаемый slippage на основе ликвидности
    const estimatedEntrySlippage = this.calculateEstimatedSlippage(initialData.liquidity, 0.003); // Стандартный размер позиции
    const estimatedExitSlippage = this.calculateEstimatedSlippage(initialData.liquidity, 0.003);

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
        marketCap: initialMarketCap, // ⭐ Сохраняем капитализацию в снимке
      }],
      peakPrice: initialPrice || 0,
      peakPriceTime: now,
      lowestPrice: initialPrice || 0,
      lowestPriceTime: now,
      maxLiquidity: initialData.liquidity,
      minLiquidity: initialData.liquidity,
      peakMarketCap: initialMarketCap, // ⭐ Начальная капитализация = пиковая
      peakMarketCapTime: now,
      initialMarketCap, // ⭐ Сохраняем начальную капитализацию
      entryOpportunities: [],
      exitOpportunities: [],
      manipulationPhases: [],
      currentPhase: 'unknown',
      phaseHistory: [],
      estimatedSlippage: {
        entry: estimatedEntrySlippage,
        exit: estimatedExitSlippage,
        lastCalculated: now,
      },
      status: 'tracking',
    };

    // Логируем начальные метрики для анализа
    await this.logEvent(mint, 'INITIAL_METRICS', {
      liquidity: initialData.liquidity,
      holders: initialData.holders,
      topHolderPct: initialData.topHolderPct,
      initialPrice,
      initialMarketCap, // ⭐ Логируем начальную капитализацию
      estimatedEntrySlippage,
      estimatedExitSlippage,
      tier: initialData.liquidity >= 5000 ? 1 : (initialData.liquidity >= 2000 ? 2 : 3),
    });

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

    // ⭐ Получаем текущую капитализацию
    let currentMarketCap = 0;
    try {
      const marketData = await priceFetcher.getMarketData(mint);
      currentMarketCap = marketData?.marketCap || 0;
    } catch (error) {
      // Используем последнюю известную капитализацию из снимка
      currentMarketCap = lastSnapshot?.marketCap || 0;
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
      marketCap: currentMarketCap, // ⭐ Сохраняем капитализацию в снимке
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
    // ⭐ Обновляем пиковую капитализацию (критично для расчета slippage при выходе)
    if (currentMarketCap > tokenData.peakMarketCap) {
      tokenData.peakMarketCap = currentMarketCap;
      tokenData.peakMarketCapTime = now;
    }

    // Рассчитываем velocity (скорость изменения)
    const snapshots = tokenData.snapshots;
    if (snapshots.length >= 2) {
      const prevSnapshot = snapshots[snapshots.length - 2];
      const timeDelta = (snapshot.timestamp - prevSnapshot.timestamp) / 1000; // секунды
      snapshot.priceVelocity = timeDelta > 0 ? (snapshot.price - prevSnapshot.price) / timeDelta : 0;
      snapshot.liquidityVelocity = timeDelta > 0 ? (snapshot.liquidity - prevSnapshot.liquidity) / timeDelta : 0;
    }

    // Обновляем ожидаемый slippage
    tokenData.estimatedSlippage.entry = this.calculateEstimatedSlippage(snapshot.liquidity, 0.003);
    // ⭐ КРИТИЧНО: Используем пиковую капитализацию для расчета slippage при выходе
    // Чем выше была капитализация на пике, тем ниже будет slippage при выходе
    tokenData.estimatedSlippage.exit = this.calculateExitSlippageByMarketCap(
      tokenData.peakMarketCap,
      snapshot.liquidity,
      0.003 // Размер позиции при выходе
    );
    tokenData.estimatedSlippage.lastCalculated = now;

    // Детектируем фазу манипуляции
    await this.detectManipulationPhase(mint, tokenData, snapshot);

    // Анализируем возможности входа/выхода
    await this.analyzeOpportunities(mint, tokenData, snapshot);

    // Логируем снимок
    await this.logSnapshot(mint, snapshot, tokenData);

    // Периодический анализ паттернов (каждые 5 минут)
    const lastPatternAnalysis = (tokenData as any).lastPatternAnalysis || 0;
    if (now - lastPatternAnalysis > this.PATTERN_ANALYSIS_INTERVAL && snapshots.length >= this.MIN_SNAPSHOTS_FOR_PATTERN) {
      (tokenData as any).lastPatternAnalysis = now;
      await this.analyzePatterns(mint, tokenData);
    }
  }

  /**
   * Анализирует паттерны для поиска закономерностей
   */
  private async analyzePatterns(mint: string, tokenData: ConcentratedTokenData): Promise<void> {
    const snapshots = tokenData.snapshots;
    if (snapshots.length < this.MIN_SNAPSHOTS_FOR_PATTERN) return;

    // Анализ временных интервалов фаз
    const phaseDurations: Record<ManipulationPhase, number[]> = {
      accumulation: [],
      pump: [],
      dump: [],
      recovery: [],
      unknown: [],
    };

    for (const phase of tokenData.phaseHistory) {
      if (phase.duration) {
        phaseDurations[phase.phase].push(phase.duration);
      }
    }

    // Средние длительности фаз
    const avgPhaseDurations: Record<ManipulationPhase, number> = {
      accumulation: phaseDurations.accumulation.length > 0 
        ? phaseDurations.accumulation.reduce((a, b) => a + b, 0) / phaseDurations.accumulation.length 
        : 0,
      pump: phaseDurations.pump.length > 0 
        ? phaseDurations.pump.reduce((a, b) => a + b, 0) / phaseDurations.pump.length 
        : 0,
      dump: phaseDurations.dump.length > 0 
        ? phaseDurations.dump.reduce((a, b) => a + b, 0) / phaseDurations.dump.length 
        : 0,
      recovery: phaseDurations.recovery.length > 0 
        ? phaseDurations.recovery.reduce((a, b) => a + b, 0) / phaseDurations.recovery.length 
        : 0,
      unknown: 0,
    };

    // Анализ корреляции между ликвидностью и ценой
    const liquidityPriceCorrelation = this.calculateCorrelation(
      snapshots.map(s => s.liquidity),
      snapshots.map(s => s.price)
    );

    // Анализ типичных паттернов входа/выхода
    const entryPattern = this.analyzeEntryPattern(tokenData);
    const exitPattern = this.analyzeExitPattern(tokenData);

    await this.logEvent(mint, 'PATTERN_ANALYSIS', {
      totalSnapshots: snapshots.length,
      avgPhaseDurations,
      liquidityPriceCorrelation,
      entryPattern,
      exitPattern,
      currentPhase: tokenData.currentPhase,
      phaseCount: tokenData.phaseHistory.length,
      entryOpportunitiesCount: tokenData.entryOpportunities.length,
      exitOpportunitiesCount: tokenData.exitOpportunities.length,
    });
  }

  /**
   * Рассчитывает корреляцию между двумя массивами
   */
  private calculateCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length === 0) return 0;

    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);

    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Анализирует паттерн входа
   */
  private analyzeEntryPattern(tokenData: ConcentratedTokenData): {
    avgLiquidity: number;
    avgPrice: number;
    avgSafetyScore: number;
    commonPhase: ManipulationPhase;
  } {
    if (tokenData.entryOpportunities.length === 0) {
      return {
        avgLiquidity: 0,
        avgPrice: 0,
        avgSafetyScore: 0,
        commonPhase: 'unknown',
      };
    }

    const avgLiquidity = tokenData.entryOpportunities.reduce((sum, opp) => sum + opp.liquidity, 0) / tokenData.entryOpportunities.length;
    const avgPrice = tokenData.entryOpportunities.reduce((sum, opp) => sum + opp.price, 0) / tokenData.entryOpportunities.length;
    const avgSafetyScore = tokenData.entryOpportunities.reduce((sum, opp) => sum + (opp.safetyScore || 0.5), 0) / tokenData.entryOpportunities.length;

    // Находим фазу, в которой чаще всего были возможности входа
    const phaseCounts: Record<ManipulationPhase, number> = {
      accumulation: 0,
      pump: 0,
      dump: 0,
      recovery: 0,
      unknown: 0,
    };

    for (const opp of tokenData.entryOpportunities) {
      const phaseAtTime = this.getPhaseAtTime(tokenData, opp.timestamp);
      phaseCounts[phaseAtTime]++;
    }

    const commonPhase = Object.entries(phaseCounts).reduce((a, b) => phaseCounts[a[0] as ManipulationPhase] > phaseCounts[b[0] as ManipulationPhase] ? a : b)[0] as ManipulationPhase;

    return {
      avgLiquidity,
      avgPrice,
      avgSafetyScore,
      commonPhase,
    };
  }

  /**
   * Анализирует паттерн выхода
   */
  private analyzeExitPattern(tokenData: ConcentratedTokenData): {
    avgMultiplier: number;
    avgUrgency: number;
    commonPhase: ManipulationPhase;
  } {
    if (tokenData.exitOpportunities.length === 0) {
      return {
        avgMultiplier: 0,
        avgUrgency: 0,
        commonPhase: 'unknown',
      };
    }

    const avgMultiplier = tokenData.exitOpportunities.reduce((sum, opp) => sum + opp.multiplier, 0) / tokenData.exitOpportunities.length;
    const avgUrgency = tokenData.exitOpportunities.reduce((sum, opp) => sum + (opp.urgency || 0.5), 0) / tokenData.exitOpportunities.length;

    const phaseCounts: Record<ManipulationPhase, number> = {
      accumulation: 0,
      pump: 0,
      dump: 0,
      recovery: 0,
      unknown: 0,
    };

    for (const opp of tokenData.exitOpportunities) {
      const phaseAtTime = this.getPhaseAtTime(tokenData, opp.timestamp);
      phaseCounts[phaseAtTime]++;
    }

    const commonPhase = Object.entries(phaseCounts).reduce((a, b) => phaseCounts[a[0] as ManipulationPhase] > phaseCounts[b[0] as ManipulationPhase] ? a : b)[0] as ManipulationPhase;

    return {
      avgMultiplier,
      avgUrgency,
      commonPhase,
    };
  }

  /**
   * Получает фазу в указанное время
   */
  private getPhaseAtTime(tokenData: ConcentratedTokenData, timestamp: number): ManipulationPhase {
    for (let i = tokenData.phaseHistory.length - 1; i >= 0; i--) {
      const phase = tokenData.phaseHistory[i];
      if (timestamp >= phase.startTime && (!phase.endTime || timestamp <= phase.endTime)) {
        return phase.phase;
      }
    }
    return tokenData.currentPhase;
  }

  /**
   * Рассчитывает ожидаемый slippage на основе ликвидности
   */
  private calculateEstimatedSlippage(liquidityUsd: number, positionSizeSol: number): number {
    // Простая модель: slippage обратно пропорционален ликвидности
    // Чем больше ликвидность, тем меньше slippage
    const positionSizeUsd = positionSizeSol * 170; // Примерная цена SOL
    const liquidityRatio = positionSizeUsd / liquidityUsd;
    
    // Базовый slippage + влияние размера позиции
    const baseSlippage = 0.05; // 5% базовый
    const impactSlippage = Math.min(liquidityRatio * 0.5, 0.3); // Максимум 30% impact
    
    return baseSlippage + impactSlippage;
  }

  /**
   * ⭐ КРИТИЧНО: Рассчитывает ожидаемый slippage при выходе на основе пиковой капитализации
   * Чем выше была капитализация на пике, тем больше была ликвидность и тем ниже slippage
   * Это ключевая метрика для понимания, сможем ли мы выйти с прибылью
   */
  private calculateExitSlippageByMarketCap(
    peakMarketCap: number,
    currentLiquidity: number,
    positionSizeSol: number
  ): number {
    // Используем пиковую капитализацию как индикатор максимальной ликвидности
    // Обычно ликвидность составляет 10-30% от капитализации
    const estimatedPeakLiquidity = peakMarketCap * 0.2; // Берем 20% как среднее
    
    // Используем минимум из текущей ликвидности и оцененной пиковой
    // Если капитализация упала, ликвидность тоже могла упасть
    const effectiveLiquidity = Math.min(currentLiquidity, estimatedPeakLiquidity);
    
    // Если ликвидность очень низкая, используем текущую
    if (effectiveLiquidity < 100) {
      return this.calculateEstimatedSlippage(currentLiquidity, positionSizeSol);
    }
    
    // Рассчитываем slippage на основе эффективной ликвидности
    return this.calculateEstimatedSlippage(effectiveLiquidity, positionSizeSol);
  }

  /**
   * Детектирует текущую фазу манипуляции
   */
  private async detectManipulationPhase(
    mint: string,
    tokenData: ConcentratedTokenData,
    snapshot: ConcentratedTokenSnapshot
  ): Promise<void> {
    const snapshots = tokenData.snapshots;
    if (snapshots.length < 5) return; // Нужно минимум 5 снимков для детекции

    const recentSnapshots = snapshots.slice(-5);
    const priceTrend = recentSnapshots[recentSnapshots.length - 1].price / recentSnapshots[0].price - 1;
    const liquidityTrend = (recentSnapshots[recentSnapshots.length - 1].liquidity - recentSnapshots[0].liquidity) / recentSnapshots[0].liquidity;

    let detectedPhase: ManipulationPhase = 'unknown';
    let confidence = 0.5;

    // ACCUMULATION: Цена стабильна/растет медленно, ликвидность увеличивается
    if (priceTrend >= -0.1 && priceTrend <= 0.3 && liquidityTrend > 0.1) {
      detectedPhase = 'accumulation';
      confidence = 0.7 + Math.min(liquidityTrend, 0.3);
      tokenData.estimatedSlippage.entry = this.calculateEstimatedSlippage(snapshot.liquidity, 0.003);
    }
    // PUMP: Цена быстро растет, ликвидность стабильна или растет
    else if (priceTrend > 0.3 && liquidityTrend >= -0.1) {
      detectedPhase = 'pump';
      confidence = 0.6 + Math.min(priceTrend, 0.4);
    }
    // DUMP: Цена падает, ликвидность уменьшается
    else if (priceTrend < -0.2 && liquidityTrend < -0.1) {
      detectedPhase = 'dump';
      confidence = 0.8;
    }
    // RECOVERY: Цена стабилизируется после падения, ликвидность стабильна
    else if (priceTrend > -0.1 && priceTrend < 0.1 && liquidityTrend > -0.05 && liquidityTrend < 0.05) {
      detectedPhase = 'recovery';
      confidence = 0.6;
    }

    // Обновляем текущую фазу если изменилась
    if (detectedPhase !== tokenData.currentPhase) {
      const now = Date.now();
      
      // Завершаем предыдущую фазу
      if (tokenData.phaseHistory.length > 0) {
        const lastPhase = tokenData.phaseHistory[tokenData.phaseHistory.length - 1];
        if (!lastPhase.endTime) {
          lastPhase.endTime = now;
          lastPhase.duration = now - lastPhase.startTime;
        }
      }

      // Начинаем новую фазу
      tokenData.phaseHistory.push({
        phase: detectedPhase,
        startTime: now,
      });

      tokenData.currentPhase = detectedPhase;

      // Сохраняем паттерн
      tokenData.manipulationPhases.push({
        phase: detectedPhase,
        confidence,
        detectedAt: now,
        entrySafety: this.calculateEntrySafety(detectedPhase, snapshot),
        exitUrgency: this.calculateExitUrgency(detectedPhase, snapshot),
      });

      await this.logEvent(mint, 'PHASE_DETECTED', {
        phase: detectedPhase,
        confidence,
        price: snapshot.price,
        liquidity: snapshot.liquidity,
        priceTrend: priceTrend * 100,
        liquidityTrend: liquidityTrend * 100,
        entrySafety: this.calculateEntrySafety(detectedPhase, snapshot),
        exitUrgency: this.calculateExitUrgency(detectedPhase, snapshot),
      });
    }
  }

  /**
   * Рассчитывает безопасность входа (0-1)
   */
  private calculateEntrySafety(phase: ManipulationPhase, snapshot: ConcentratedTokenSnapshot): number {
    let safety = 0.5; // Базовая безопасность

    // ACCUMULATION - самый безопасный момент
    if (phase === 'accumulation') {
      safety = 0.8;
      // Увеличиваем безопасность если ликвидность высокая
      if (snapshot.liquidity > 3000) safety = 0.9;
      if (snapshot.liquidity > 5000) safety = 0.95;
    }
    // RECOVERY - относительно безопасно
    else if (phase === 'recovery') {
      safety = 0.6;
    }
    // PUMP - рискованно, но может быть прибыльно
    else if (phase === 'pump') {
      safety = 0.3;
    }
    // DUMP - очень рискованно
    else if (phase === 'dump') {
      safety = 0.1;
    }

    // Учитываем slippage: чем меньше slippage, тем безопаснее
    const slippage = this.calculateEstimatedSlippage(snapshot.liquidity, 0.003);
    safety *= (1 - slippage * 0.5); // Уменьшаем безопасность на 50% от slippage

    return Math.max(0, Math.min(1, safety));
  }

  /**
   * Рассчитывает срочность выхода (0-1)
   */
  private calculateExitUrgency(phase: ManipulationPhase, snapshot: ConcentratedTokenSnapshot): number {
    // DUMP - очень срочно выходить
    if (phase === 'dump') {
      return 0.9;
    }
    // PUMP - может быть хороший момент для выхода
    if (phase === 'pump') {
      return 0.6;
    }
    // Остальные фазы - не срочно
    return 0.2;
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
        const estimatedSlippage = this.calculateEstimatedSlippage(snapshot.liquidity, 0.003);
        const safetyScore = this.calculateEntrySafety(tokenData.currentPhase, snapshot);
        
        tokenData.entryOpportunities.push({
          timestamp: snapshot.timestamp,
          price: currentPrice,
          liquidity: snapshot.liquidity,
          reason: `Price dropped ${priceFromPeak.toFixed(1)}% from peak (potential bounce)`,
          estimatedSlippage,
          safetyScore,
          marketCap: snapshot.marketCap, // ⭐ Капитализация на момент возможности входа
        });
        await this.logEvent(mint, 'ENTRY_OPPORTUNITY', {
          price: currentPrice,
          priceFromPeak,
          liquidity: snapshot.liquidity,
          marketCap: snapshot.marketCap, // ⭐ Логируем капитализацию
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
        const estimatedSlippage = this.calculateEstimatedSlippage(snapshot.liquidity, 0.003);
        const safetyScore = this.calculateEntrySafety(tokenData.currentPhase, snapshot);
        
        tokenData.entryOpportunities.push({
          timestamp: snapshot.timestamp,
          price: currentPrice,
          liquidity: snapshot.liquidity,
          reason: `Liquidity increased ${liquidityChange.toFixed(1)}% (manipulator adding liquidity?)`,
          estimatedSlippage,
          safetyScore,
          marketCap: snapshot.marketCap, // ⭐ Капитализация на момент возможности входа
        });
          await this.logEvent(mint, 'ENTRY_OPPORTUNITY', {
            price: currentPrice,
            liquidityChange,
            liquidity: snapshot.liquidity,
            marketCap: snapshot.marketCap, // ⭐ Логируем капитализацию
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
        const urgency = this.calculateExitUrgency(tokenData.currentPhase, snapshot);
        
        // ⭐ Рассчитываем ожидаемый slippage при выходе на основе пиковой капитализации
        const estimatedExitSlippage = this.calculateExitSlippageByMarketCap(
          tokenData.peakMarketCap,
          snapshot.liquidity,
          0.003
        );
        
        tokenData.exitOpportunities.push({
          timestamp: snapshot.timestamp,
          price: currentPrice,
          multiplier,
          reason: `Price increased ${priceChange.toFixed(1)}% from entry (${multiplier.toFixed(2)}x)`,
          urgency,
          marketCap: snapshot.marketCap, // ⭐ Капитализация на момент возможности выхода
          estimatedExitSlippage, // ⭐ Ожидаемый slippage при выходе
        });
        await this.logEvent(mint, 'EXIT_OPPORTUNITY', {
          price: currentPrice,
          multiplier,
          priceChange,
          marketCap: snapshot.marketCap, // ⭐ Логируем капитализацию
          peakMarketCap: tokenData.peakMarketCap, // ⭐ Логируем пиковую капитализацию
          estimatedExitSlippage, // ⭐ Логируем ожидаемый slippage
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
        const urgency = this.calculateExitUrgency(tokenData.currentPhase, snapshot);
        
        // ⭐ Рассчитываем ожидаемый slippage при выходе на основе пиковой капитализации
        const estimatedExitSlippage = this.calculateExitSlippageByMarketCap(
          tokenData.peakMarketCap,
          snapshot.liquidity,
          0.003
        );
        
        tokenData.exitOpportunities.push({
          timestamp: snapshot.timestamp,
          price: currentPrice,
          multiplier,
          reason: `Liquidity dropped ${Math.abs(liquidityChange).toFixed(1)}% (manipulator withdrawing? Exit now!)`,
          urgency,
          marketCap: snapshot.marketCap, // ⭐ Капитализация на момент возможности выхода
          estimatedExitSlippage, // ⭐ Ожидаемый slippage при выходе
        });
          await this.logEvent(mint, 'EXIT_OPPORTUNITY', {
            price: currentPrice,
            multiplier,
            liquidityChange,
            marketCap: snapshot.marketCap, // ⭐ Логируем капитализацию
            peakMarketCap: tokenData.peakMarketCap, // ⭐ Логируем пиковую капитализацию
            estimatedExitSlippage, // ⭐ Логируем ожидаемый slippage
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
        peakMarketCap: tokenData.peakMarketCap, // ⭐ Пиковая капитализация
        initialMarketCap: tokenData.initialMarketCap, // ⭐ Начальная капитализация
        entryOpportunities: tokenData.entryOpportunities.length,
        exitOpportunities: tokenData.exitOpportunities.length,
        estimatedExitSlippage: tokenData.estimatedSlippage.exit, // ⭐ Ожидаемый slippage при выходе
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
        message: `🔍 [CONCENTRATED] ${mint.substring(0, 12)}... | Price: ${snapshot.price.toFixed(10)}, MarketCap: $${(snapshot.marketCap || 0).toFixed(2)}, Peak MC: $${tokenData.peakMarketCap.toFixed(2)}, Liq: $${snapshot.liquidity.toFixed(2)}, Holders: ${snapshot.holders}, Top: ${snapshot.topHolderPct.toFixed(1)}% | Peak: ${tokenData.peakPrice.toFixed(10)} (${((snapshot.price / tokenData.peakPrice - 1) * 100).toFixed(1)}%) | Exit slippage: ${(tokenData.estimatedSlippage.exit * 100).toFixed(1)}% | Entry opps: ${tokenData.entryOpportunities.length}, Exit opps: ${tokenData.exitOpportunities.length}`,
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
      manipulationPhases: tokenData.manipulationPhases,
      phaseHistory: tokenData.phaseHistory.map(ph => ({
        phase: ph.phase,
        startTime: new Date(ph.startTime).toISOString(),
        endTime: ph.endTime ? new Date(ph.endTime).toISOString() : null,
        duration: ph.duration,
      })),
      estimatedSlippage: tokenData.estimatedSlippage,
      patternAnalysis: {
        avgPhaseDurations: this.calculateAvgPhaseDurations(tokenData),
        entryPattern: this.analyzeEntryPattern(tokenData),
        exitPattern: this.analyzeExitPattern(tokenData),
      },
    };

    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  }

  /**
   * Рассчитывает средние длительности фаз
   */
  private calculateAvgPhaseDurations(tokenData: ConcentratedTokenData): Record<ManipulationPhase, number> {
    const phaseDurations: Record<ManipulationPhase, number[]> = {
      accumulation: [],
      pump: [],
      dump: [],
      recovery: [],
      unknown: [],
    };

    for (const phase of tokenData.phaseHistory) {
      if (phase.duration) {
        phaseDurations[phase.phase].push(phase.duration);
      }
    }

    return {
      accumulation: phaseDurations.accumulation.length > 0 
        ? phaseDurations.accumulation.reduce((a, b) => a + b, 0) / phaseDurations.accumulation.length 
        : 0,
      pump: phaseDurations.pump.length > 0 
        ? phaseDurations.pump.reduce((a, b) => a + b, 0) / phaseDurations.pump.length 
        : 0,
      dump: phaseDurations.dump.length > 0 
        ? phaseDurations.dump.reduce((a, b) => a + b, 0) / phaseDurations.dump.length 
        : 0,
      recovery: phaseDurations.recovery.length > 0 
        ? phaseDurations.recovery.reduce((a, b) => a + b, 0) / phaseDurations.recovery.length 
        : 0,
      unknown: 0,
    };
  }
}

