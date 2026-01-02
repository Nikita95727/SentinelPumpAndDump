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
  // Если явно указан mainnet режим
  if (process.env.PUMP_FUN_TESTNET === 'false') {
    return false;
  }
  // Если TRADING_MODE=paper, используем mainnet (для paper trading на реальных данных)
  if (process.env.TRADING_MODE === 'paper') {
    return false; // Paper trading на mainnet для реалистичности
  }
  // Если реальная торговля отключена и не указан TRADING_MODE, используем testnet для безопасности
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
  initialDeposit: parseFloat(process.env.INITIAL_DEPOSIT || '0.55'),
  solUsdRate: parseFloat(process.env.SOL_USD_RATE || '170'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '10', 10),
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT || '25'),
  batchSize: 10,
  minDelaySeconds: 10,
  maxDelaySeconds: 30,
  // ✅ ЕДИНАЯ ОЧЕРЕДЬ: Все токены обрабатываются через одну очередь
  // Фильтрация и readiness check определяют момент входа
  minPurchases: 5,
  minVolumeUsd: 2000,
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '5000'), // ⭐ Минимальная базовая ликвидность для входа (увеличено до $5000 для снижения slippage)
  maxSingleHolderPct: parseFloat(process.env.MAX_SINGLE_HOLDER_PCT || '50'), // ⭐ Максимальный % токенов у одного держателя (защита от надутой ликвидности)
  minEntryMultiplier: parseFloat(process.env.MIN_ENTRY_MULTIPLIER || '2.5'), // ⭐ КРИТИЧНО: Минимальный multiplier для входа (гарантирует прибыль даже с slippage 35%)
  immediateEntry: process.env.IMMEDIATE_ENTRY === 'true', // true по умолчанию для стратегии
  takeProfitMultiplier: 50.0, // ⭐ ОТКЛЮЧАЕМ ЖЕСТКИЙ ЛИМИТ (было 2.0). Теперь выход только по Trailing Stop или Momentum.
  exitTimerSeconds: 45, // ⭐ Уменьшено с 90 до 45 секунд для уменьшения slippage (SLIPPAGE_SOLUTIONS.md)
  momentumExitSensitivity: 0.9, // 0.9 = Очень высокая чувствительность (1-1.5 сек stall)
  trailingStopPct: 25,
  priorityFee: 0.001,
  signatureFee: 0.000005,
  jitoEnabled: true, // ⭐ Включаем Jito по умолчанию для защиты от сэндвичей
  jitoTipAmount: 0.001, // 0.001 SOL чаевые за быстрый выход
  slippageMin: 0.01,
  slippageMax: 0.03,
  exitSlippageMin: 0.20, // ⭐ Минимальный slippage при выходе (20% для токенов с хорошей ликвидностью)
  exitSlippageMax: 0.35, // ⭐ Максимальный slippage при выходе (35% для токенов с низкой ликвидностью)
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
  maxSolPerTrade: parseFloat(process.env.MAX_SOL_PER_TRADE || '0.1'), // Hard cap per trade (stealth) - безопасный размер, не влияет на цену
  maxTradingBalance: parseFloat(process.env.MAX_TRADING_BALANCE || '0.8'), // Максимальный торговый баланс (излишек выводится)
  minPositionSize: parseFloat(process.env.MIN_POSITION_SIZE || '0.01'), // Минимальный размер позиции: 0.01 SOL
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.1'), // Максимальный размер позиции: 0.1 SOL (позволяет 0.055)
  personalWalletAddress: process.env.PERSONAL_WALLET_ADDRESS || '', // Адрес личного кошелька для вывода излишка
  maxReservePercent: parseFloat(process.env.MAX_RESERVE_PERCENT || '1.0'), // Max % of reserves per trade (if data available)
  // Trading mode configuration
  tradingMode: (process.env.TRADING_MODE || 'paper') as 'real' | 'paper', // По умолчанию paper mode
  realTradingEnabled: process.env.REAL_TRADING_ENABLED === 'true', // Legacy, для обратной совместимости (не используется в логике)
  walletMnemonic: process.env.WALLET_MNEMONIC || '', // Seed-фраза для кошелька (опционально, для реальной торговли)

  // Sell strategy
  sellStrategy: (process.env.SELL_STRATEGY || 'single') as 'single' | 'partial_50_50',
  partialSellDelayMs: parseInt(process.env.PARTIAL_SELL_DELAY_MS || '15000', 10),

  // Impact/Slippage model (для paper и оценки в real)
  paperImpactThresholdSol: parseFloat(process.env.PAPER_IMPACT_THRESHOLD_SOL || '0.0037'),
  paperImpactPower: parseFloat(process.env.PAPER_IMPACT_POWER || '2.2'),
  paperImpactBase: parseFloat(process.env.PAPER_IMPACT_BASE || '0.05'),
  paperImpactK: parseFloat(process.env.PAPER_IMPACT_K || '0.30'),

  // Risk-aware sizing
  maxExpectedImpact: parseFloat(process.env.MAX_EXPECTED_IMPACT || '0.25'), // Максимальный допустимый impact (25%)
  skipIfImpactTooHigh: process.env.SKIP_IF_IMPACT_TOO_HIGH === 'true',

  // Write-off threshold
  writeOffThresholdPct: parseFloat(process.env.WRITE_OFF_THRESHOLD_PCT || '0.3'), // Если ожидаемые proceeds < 30% от invested, write-off

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

