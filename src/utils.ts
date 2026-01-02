import { Connection, PublicKey } from '@solana/web3.js';
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
  // Случайный slippage от 1% до 3%
  return config.slippageMin + Math.random() * (config.slippageMax - config.slippageMin);
}

export function calculateExitPrice(entryPrice: number, multiplier: number, slippage: number): number {
  const targetPrice = entryPrice * multiplier;
  return targetPrice * (1 - slippage);
}

export function calculateProfit(invested: number, entryPrice: number, exitPrice: number, exitFee: number): number {
  const multiplier = exitPrice / entryPrice;
  const grossProfit = invested * multiplier;
  return grossProfit - exitFee;
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export function formatSol(lamports: number): number {
  return lamports / 1e9;
}

export function solToLamports(sol: number): number {
  return Math.floor(sol * 1e9);
}

export function formatUsd(sol: number): number {
  return sol * config.solUsdRate;
}

export async function getConnection(): Promise<Connection> {
  const connection = new Connection(config.primaryRpcHttpUrl, {
    commitment: 'confirmed',
  });
  return connection;
}

export function calculateDrawdown(current: number, peak: number): number {
  if (peak === 0) return 0;
  return ((peak - current) / peak) * 100;
}

