import * as dotenv from 'dotenv';
import { Config } from './types';

dotenv.config();

export const config: Config = {
  initialDeposit: parseFloat(process.env.INITIAL_DEPOSIT || '0.03'),
  solUsdRate: parseFloat(process.env.SOL_USD_RATE || '170'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '100', 10),
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT || '25'),
  batchSize: 10,
  minDelaySeconds: 10,
  maxDelaySeconds: 30,
  minPurchases: 5,
  minVolumeUsd: 2000,
  takeProfitMultiplier: 4,
  exitTimerSeconds: 90,
  trailingStopPct: 25,
  priorityFee: 0.001,
  signatureFee: 0.000005,
  slippageMin: 0.01,
  slippageMax: 0.03,
  // Rate limiting: Helius free tier ~100-200 req/sec
  // Безопасная задержка: 50-100ms между запросами (10-20 req/sec)
  // Это оставляет запас для других операций
  rpcRequestDelay: parseInt(process.env.RPC_REQUEST_DELAY || '80', 10), // ms между RPC запросами
  filterCheckDelay: parseInt(process.env.FILTER_CHECK_DELAY || '100', 10), // ms между проверками фильтров
  rateLimitRetryDelay: parseInt(process.env.RATE_LIMIT_RETRY_DELAY || '1000', 10), // ms при 429 ошибке
  heliusWsUrl: process.env.HELIUS_WS_URL || '',
  heliusHttpUrl: process.env.HELIUS_HTTP_URL || process.env.HELIUS_WS_URL?.replace('wss://', 'https://').replace('ws://', 'http://') || '',
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined,
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  logDir: process.env.LOG_DIR || './logs',
};

if (!config.heliusWsUrl) {
  throw new Error('HELIUS_WS_URL is required in .env file');
}

export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

