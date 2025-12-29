/**
 * Risk Manager
 * Управляет рисками: лимиты сделок, стоп-торговля, защита депозита
 */

import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

export interface RiskState {
  canTrade: boolean;
  reason?: string;
  dailyTradesCount: number;
  consecutiveLosses: number;
  currentDrawdown: number;
}

export class RiskManager {
  private dailyTradesCount = 0;
  private consecutiveLosses = 0;
  private lastTradeDate: string = '';
  private peakBalance: number;
  private currentBalance: number;
  private currentDrawdown = 0;
  private isTradingStopped = false;
  private stopReason: string = '';

  constructor(initialBalance: number) {
    this.peakBalance = initialBalance;
    this.currentBalance = initialBalance;
    this.lastTradeDate = new Date().toISOString().split('T')[0];
  }

  /**
   * Проверяет, можно ли открыть новую позицию
   */
  canOpenPosition(maxOpenPositions: number, currentOpenPositions: number): RiskState {
    // Проверка стоп-торговли
    if (this.isTradingStopped) {
      return {
        canTrade: false,
        reason: `Trading stopped: ${this.stopReason}`,
        dailyTradesCount: this.dailyTradesCount,
        consecutiveLosses: this.consecutiveLosses,
        currentDrawdown: this.currentDrawdown,
      };
    }

    // Проверка лимита открытых позиций
    if (currentOpenPositions >= maxOpenPositions) {
      return {
        canTrade: false,
        reason: `Max open positions reached: ${currentOpenPositions}/${maxOpenPositions}`,
        dailyTradesCount: this.dailyTradesCount,
        consecutiveLosses: this.consecutiveLosses,
        currentDrawdown: this.currentDrawdown,
      };
    }

    // Проверка дневного лимита сделок (например, 20 сделок в день)
    const today = new Date().toISOString().split('T')[0];
    if (today !== this.lastTradeDate) {
      // Новый день - сбрасываем счетчик
      this.dailyTradesCount = 0;
      this.lastTradeDate = today;
    }

    const maxDailyTrades = 20;
    if (this.dailyTradesCount >= maxDailyTrades) {
      return {
        canTrade: false,
        reason: `Daily trades limit reached: ${this.dailyTradesCount}/${maxDailyTrades}`,
        dailyTradesCount: this.dailyTradesCount,
        consecutiveLosses: this.consecutiveLosses,
        currentDrawdown: this.currentDrawdown,
      };
    }

    // Проверка серии убытков (стоп после 3 подряд убытков)
    if (this.consecutiveLosses >= 3) {
      this.stopTrading(`Consecutive losses: ${this.consecutiveLosses}`);
      return {
        canTrade: false,
        reason: `Consecutive losses: ${this.consecutiveLosses}`,
        dailyTradesCount: this.dailyTradesCount,
        consecutiveLosses: this.consecutiveLosses,
        currentDrawdown: this.currentDrawdown,
      };
    }

    return {
      canTrade: true,
      dailyTradesCount: this.dailyTradesCount,
      consecutiveLosses: this.consecutiveLosses,
      currentDrawdown: this.currentDrawdown,
    };
  }

  /**
   * Регистрирует открытие позиции
   */
  onPositionOpened(): void {
    this.dailyTradesCount++;
  }

  /**
   * Регистрирует закрытие позиции
   */
  onPositionClosed(profit: number): void {
    if (profit > 0) {
      // Прибыльная сделка - сбрасываем счетчик убытков
      this.consecutiveLosses = 0;
    } else {
      // Убыточная сделка
      this.consecutiveLosses++;
    }
  }

  /**
   * Обновляет баланс и проверяет drawdown
   */
  updateBalance(balance: number): void {
    this.currentBalance = balance;
    
    if (balance > this.peakBalance) {
      this.peakBalance = balance;
    }

    // Рассчитываем drawdown
    this.currentDrawdown = ((this.peakBalance - this.currentBalance) / this.peakBalance) * 100;

    // Стоп-торговля при превышении максимального drawdown
    if (this.currentDrawdown >= config.maxDrawdownPct) {
      this.stopTrading(`Max drawdown exceeded: ${this.currentDrawdown.toFixed(2)}% >= ${config.maxDrawdownPct}%`);
    }
  }

  /**
   * Останавливает торговлю
   */
  stopTrading(reason: string): void {
    if (!this.isTradingStopped) {
      this.isTradingStopped = true;
      this.stopReason = reason;
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: `🛑 Risk Manager: Trading stopped - ${reason}`,
      });
    }
  }

  /**
   * Возобновляет торговлю (вручную)
   */
  resumeTrading(): void {
    if (this.isTradingStopped) {
      this.isTradingStopped = false;
      this.stopReason = '';
      this.consecutiveLosses = 0; // Сбрасываем счетчик убытков
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Risk Manager: Trading resumed`,
      });
    }
  }

  /**
   * Получает текущее состояние рисков
   */
  getRiskState(): RiskState {
    return {
      canTrade: !this.isTradingStopped,
      reason: this.isTradingStopped ? this.stopReason : undefined,
      dailyTradesCount: this.dailyTradesCount,
      consecutiveLosses: this.consecutiveLosses,
      currentDrawdown: this.currentDrawdown,
    };
  }
}

