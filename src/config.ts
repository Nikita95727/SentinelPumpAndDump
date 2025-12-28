import * as dotenv from 'dotenv';
import { Config } from './types';

dotenv.config();

/**
 * Конфигурация для Pump.fun Testnet
 * Примечание: Pump.fun использует собственную тестовую сеть, не стандартный Solana testnet
 */
const PUMP_FUN_TESTNET_CONFIG = {
  programId: process.env.PUMP_FUN_TESTNET_PROGRAM_ID || '', // Будет установлен после получения документации
  wsUrl: process.env.PUMP_FUN_TESTNET_WS_URL || '',
  httpUrl: process.env.PUMP_FUN_TESTNET_HTTP_URL || '',
};

/**
 * Конфигурация для Pump.fun Mainnet
 */
const PUMP_FUN_MAINNET_CONFIG = {
  programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  wsUrl: process.env.HELIUS_WS_URL || '',
  httpUrl: process.env.HELIUS_HTTP_URL || process.env.HELIUS_WS_URL?.replace('wss://', 'https://').replace('ws://', 'http://') || '',
};

/**
 * Определяет, используется ли testnet режим
 * Если установлен PUMP_FUN_TESTNET=true или REAL_TRADING_ENABLED=false, используется testnet
 */
export const isTestnetMode = (): boolean => {
  // Если явно указан testnet режим
  if (process.env.PUMP_FUN_TESTNET === 'true') {
    return true;
  }
  // Если реальная торговля отключена, используем testnet для безопасности
  if (process.env.REAL_TRADING_ENABLED !== 'true') {
    return true;
  }
  return false;
};

/**
 * Получает конфигурацию для текущего режима (testnet/mainnet)
 */
const getNetworkConfig = () => {
  const useTestnet = isTestnetMode();
  
  if (useTestnet) {
    // Проверяем, что testnet конфигурация установлена
    if (!PUMP_FUN_TESTNET_CONFIG.programId || !PUMP_FUN_TESTNET_CONFIG.wsUrl) {
      throw new Error(
        'Testnet mode is enabled but testnet configuration is missing. ' +
        'Please set PUMP_FUN_TESTNET_PROGRAM_ID, PUMP_FUN_TESTNET_WS_URL, and PUMP_FUN_TESTNET_HTTP_URL in .env'
      );
    }
    return PUMP_FUN_TESTNET_CONFIG;
  }
  
  // Проверяем mainnet конфигурацию
  if (!PUMP_FUN_MAINNET_CONFIG.wsUrl) {
    throw new Error('HELIUS_WS_URL is required in .env file for mainnet mode');
  }
  
  return PUMP_FUN_MAINNET_CONFIG;
};

// Получаем текущую конфигурацию сети
const networkConfig = getNetworkConfig();

export const config: Config = {
  initialDeposit: parseFloat(process.env.INITIAL_DEPOSIT || '0.03'),
  solUsdRate: parseFloat(process.env.SOL_USD_RATE || '170'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '15', 10),
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT || '25'),
      batchSize: 10,
      minDelaySeconds: 10,
      maxDelaySeconds: 30,
      // Три очереди для разных временных окон
      // Очередь 1: 0-5 сек (самый ранний вход)
      queue1MinDelaySeconds: parseFloat(process.env.QUEUE1_MIN_DELAY_SECONDS || '0'),
      queue1MaxDelaySeconds: parseFloat(process.env.QUEUE1_MAX_DELAY_SECONDS || '5'),
      // Очередь 2: 5-15 сек (ранний вход)
      queue2MinDelaySeconds: parseFloat(process.env.QUEUE2_MIN_DELAY_SECONDS || '5'),
      queue2MaxDelaySeconds: parseFloat(process.env.QUEUE2_MAX_DELAY_SECONDS || '15'),
      // Очередь 3: 10-30 сек (стандартный вход) - использует minDelaySeconds/maxDelaySeconds
  minPurchases: 5,
  minVolumeUsd: 2000,
      takeProfitMultiplier: parseFloat(process.env.TAKE_PROFIT_MULTIPLIER || '2.5'), // Оптимизировано: 2.5x для гарантированного выхода до дампа
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
  // Используем конфигурацию из текущего режима (testnet/mainnet)
  heliusWsUrl: networkConfig.wsUrl,
  heliusHttpUrl: networkConfig.httpUrl,
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined,
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  logDir: process.env.LOG_DIR || './logs',
  // Safety mechanisms
  maxSolPerTrade: parseFloat(process.env.MAX_SOL_PER_TRADE || '0.05'), // Hard cap per trade (stealth) - безопасный размер, не влияет на цену
  maxReservePercent: parseFloat(process.env.MAX_RESERVE_PERCENT || '1.0'), // Max % of reserves per trade (if data available)
  nightModeEnabled: process.env.NIGHT_MODE_ENABLED !== 'false',
  nightModeStartHour: parseInt(process.env.NIGHT_MODE_START_HOUR || '0', 10), // UTC hour (0-23)
  nightModeEndHour: parseInt(process.env.NIGHT_MODE_END_HOUR || '8', 10), // UTC hour (0-23)
  nightModePositionMultiplier: parseFloat(process.env.NIGHT_MODE_POSITION_MULTIPLIER || '0.5'), // Reduce position size during night
  sessionMaxDrawdownPct: parseFloat(process.env.SESSION_MAX_DRAWDOWN_PCT || '5.0'), // Hard stop if drawdown exceeds this
  profitLockEnabled: process.env.PROFIT_LOCK_ENABLED !== 'false',
  profitLockThresholdPct: parseFloat(process.env.PROFIT_LOCK_THRESHOLD_PCT || '20.0'), // Lock profit if balance increases by this %
  profitLockPercent: parseFloat(process.env.PROFIT_LOCK_PERCENT || '50.0'), // Lock this % of profit above threshold
  // Real trading configuration
  realTradingEnabled: process.env.REAL_TRADING_ENABLED === 'true', // 🔴 IMPORTANT: Must be explicitly enabled
  walletMnemonic: process.env.WALLET_MNEMONIC || '', // Seed-фраза для кошелька (опционально, для реальной торговли)
  // Network configuration
  testnetMode: isTestnetMode(),
};

/**
 * Динамический PUMP_FUN_PROGRAM_ID в зависимости от режима (testnet/mainnet)
 */
export const PUMP_FUN_PROGRAM_ID = networkConfig.programId;

/**
 * Получить информацию о текущем режиме сети
 */
export const getNetworkInfo = () => {
  const useTestnet = isTestnetMode();
  return {
    mode: useTestnet ? 'testnet' : 'mainnet',
    programId: PUMP_FUN_PROGRAM_ID,
    wsUrl: config.heliusWsUrl,
    httpUrl: config.heliusHttpUrl,
  };
};

