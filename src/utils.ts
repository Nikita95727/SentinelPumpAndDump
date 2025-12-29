/**
 * Утилиты для Bybit Trading Bot
 */

import { config } from './config';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getCurrentDateUTC(): string {
  return new Date().toISOString().split('T')[0];
}

export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

export function calculateSlippage(): number {
  // Случайный slippage от min до max
  return config.slippageMin + Math.random() * (config.slippageMax - config.slippageMin);
}

export function calculateProfit(invested: number, entryPrice: number, exitPrice: number, exitFee: number = 0): number {
  const multiplier = exitPrice / entryPrice;
  const grossProfit = invested * multiplier;
  return grossProfit - exitFee;
}

export function formatUsd(amount: number): number {
  return amount; // Уже в USD для Bybit
}

export function calculateDrawdown(current: number, peak: number): number {
  if (peak <= 0) return 0;
  return ((peak - current) / peak) * 100;
}
