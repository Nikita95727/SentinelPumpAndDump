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
  // Увеличенные задержки для стабильной работы в пределах лимитов
  // ~3-5 req/sec для безопасной работы с запасом
  rpcRequestDelay: parseInt(process.env.RPC_REQUEST_DELAY || '250', 10), // ms между RPC запросами (было 80)
  filterCheckDelay: parseInt(process.env.FILTER_CHECK_DELAY || '200', 10), // ms между проверками фильтров (было 100)
  rateLimitRetryDelay: parseInt(process.env.RATE_LIMIT_RETRY_DELAY || '2000', 10), // ms при 429 ошибке (было 1000)
  notificationProcessDelay: parseInt(process.env.NOTIFICATION_PROCESS_DELAY || '500', 10), // ms между обработкой уведомлений
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

