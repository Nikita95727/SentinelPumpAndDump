/**
 * Execution Model
 * Модель расчета slippage/impact для paper и real режимов
 */

import { config } from '../config';

export interface ImpactModel {
  base: number; // Базовый impact (например 0.05 = 5%)
  k: number; // Коэффициент масштабирования
  threshold: number; // Порог в SOL, после которого impact резко растет
  power: number; // Степень роста (например 2.2)
}

/**
 * Рассчитывает ожидаемый impact для размера позиции
 */
export function calculateImpact(amountSol: number, model: ImpactModel): number {
  if (amountSol <= 0) return 0;

  // Простая модель: impact = base + k * (amount / threshold)^power
  const ratio = amountSol / model.threshold;
  const impact = model.base + model.k * Math.pow(ratio, model.power);

  // Ограничиваем максимальным значением (например 50%)
  return Math.min(impact, 0.5);
}

/**
 * Получает модель impact из конфига
 */
export function getImpactModel(): ImpactModel {
  return {
    base: config.paperImpactBase || 0.05,
    k: config.paperImpactK || 0.30,
    threshold: config.paperImpactThresholdSol || 0.0037,
    power: config.paperImpactPower || 2.2,
  };
}

/**
 * Рассчитывает execution price с учетом impact
 */
export function calculateExecutionPrice(markPrice: number, impact: number, isBuy: boolean): number {
  if (isBuy) {
    // При покупке цена выше (платим больше)
    return markPrice * (1 + impact);
  } else {
    // При продаже цена ниже (получаем меньше)
    return markPrice * (1 - impact);
  }
}

/**
 * Рассчитывает количество токенов при покупке с учетом impact
 */
export function calculateTokensReceived(amountSol: number, markPrice: number, impact: number, fees: number): number {
  const executionPrice = calculateExecutionPrice(markPrice, impact, true);
  const amountAfterFees = amountSol - fees;
  return amountAfterFees / executionPrice;
}

/**
 * Рассчитывает SOL при продаже с учетом impact
 */
export function calculateSolReceived(amountTokens: number, markPrice: number, impact: number, fees: number): number {
  const executionPrice = calculateExecutionPrice(markPrice, impact, false);
  const grossSol = amountTokens * executionPrice;
  return Math.max(0, grossSol - fees);
}

