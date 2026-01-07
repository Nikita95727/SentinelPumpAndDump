import { TokenType, StrategyContext, EntryParams, MonitorDecision, ExitPlan, Position } from '../types';

/**
 * Интерфейс стратегии торговли
 * 
 * Каждый TokenType имеет свою стратегию
 * Стратегия инкапсулирует ВСЮ торговую логику для данного типа токена
 */
export interface Strategy {
  type: TokenType;

  /**
   * Решает, нужно ли входить в позицию
   * @param ctx - контекст с метриками токена
   * @returns решение о входе и причина
   */
  shouldEnter(ctx: StrategyContext): { enter: boolean; reason: string };

  /**
   * Вычисляет параметры входа (размер позиции, stop-loss, take-profit, timeout)
   * @param ctx - контекст с метриками токена
   * @param availableBalance - доступный баланс для входа
   * @returns параметры входа
   */
  entryParams(ctx: StrategyContext, availableBalance: number): EntryParams;

  /**
   * Тик мониторинга позиции (вызывается каждую секунду)
   * @param position - текущая позиция
   * @param ctx - актуальный контекст (текущая цена, метрики)
   * @returns решение о дальнейших действиях
   */
  monitorTick(position: Position, ctx: StrategyContext): MonitorDecision;

  /**
   * Создаёт план выхода из позиции
   * @param position - позиция
   * @param ctx - актуальный контекст
   * @param reason - причина выхода
   * @returns план выхода (jito tip, slippage, urgency)
   */
  exitPlan(position: Position, ctx: StrategyContext, reason: string): ExitPlan;
}

