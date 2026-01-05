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
  wsUrl: process.env.PRIMARY_RPC_WS_URL || '',
  httpUrl: process.env.PRIMARY_RPC_HTTP_URL || process.env.PRIMARY_RPC_WS_URL?.replace('wss://', 'https://').replace('ws://', 'http://') || '',
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
    throw new Error('PRIMARY_RPC_WS_URL is required in .env file for mainnet mode');
  }

  return PUMP_FUN_MAINNET_CONFIG;
};

// Получаем текущую конфигурацию сети
const networkConfig = getNetworkConfig();

export const config: Config = {
  initialDeposit: parseFloat(process.env.INITIAL_DEPOSIT || '0.03'),
  solUsdRate: parseFloat(process.env.SOL_USD_RATE || '170'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '15', 10), // Increased to 15 for wider coverage
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT || '25'),
  batchSize: 10,
  minDelaySeconds: 10,
  maxDelaySeconds: 30,
  // ✅ ЕДИНАЯ ОЧЕРЕДЬ: Все токены обрабатываются через одну очередь
  // Фильтрация и readiness check определяют момент входа
  minPurchases: 5,
  minMarketCap: 5000, // ⭐ EXPERT REC: Raised to $5000 to filter rugs
  minVolumeUsd: 2000,
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '5000'),
  maxSingleHolderPct: parseFloat(process.env.MAX_SINGLE_HOLDER_PCT || '50'),
  minEntryMultiplier: parseFloat(process.env.MIN_ENTRY_MULTIPLIER || '1.02'), // ⭐ EXPERT REC: Lowered to 1.02x to enter earlier (avoid buying tops)
  takeProfitMultiplier: parseFloat(process.env.TAKE_PROFIT_MULTIPLIER || '1.35'),
  exitTimerSeconds: 45,
  trailingStopPct: 25,
  priorityFee: 0.001,
  signatureFee: 0.000005,
  slippageMin: 0.01,
  slippageMax: 0.03,
  exitSlippageMin: 0.20,
  exitSlippageMax: 0.35,

  // ~0.5 req/sec для публичного RPC (SAFETY MODE)
  rpcRequestDelay: parseInt(process.env.RPC_REQUEST_DELAY || '2000', 10), // Increased to 2000ms for public RPC stability
  filterCheckDelay: parseInt(process.env.FILTER_CHECK_DELAY || '500', 10), // Increased to 500ms
  rateLimitRetryDelay: parseInt(process.env.RATE_LIMIT_RETRY_DELAY || '5000', 10), // Increased to 5000ms
  notificationProcessDelay: parseInt(process.env.NOTIFICATION_PROCESS_DELAY || '500', 10), // Increased to 500ms

  primaryRpcWsUrl: networkConfig.wsUrl,
  primaryRpcHttpUrl: networkConfig.httpUrl,
  pumpPortalWsUrl: process.env.PUMP_PORTAL_WS_URL || 'wss://pumpportal.fun/api/data',
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined,
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  logDir: process.env.LOG_DIR || './logs',

  maxSolPerTrade: parseFloat(process.env.MAX_SOL_PER_TRADE || '0.05'),
  maxTradingBalance: parseFloat(process.env.MAX_TRADING_BALANCE || '0.3'),
  minPositionSize: parseFloat(process.env.MIN_POSITION_SIZE || '0.004'),
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.004'),
  personalWalletAddress: process.env.PERSONAL_WALLET_ADDRESS || '',
  maxReservePercent: parseFloat(process.env.MAX_RESERVE_PERCENT || '1.0'),

  tradingMode: (process.env.TRADING_MODE || 'paper') as 'real' | 'paper',
  realTradingEnabled: process.env.REAL_TRADING_ENABLED === 'true',
  walletMnemonic: process.env.WALLET_MNEMONIC || '',
  jitoEnabled: process.env.JITO_ENABLED === 'true',
  jitoTipAmount: parseFloat(process.env.JITO_TIP_AMOUNT || '0.001'),
  secondaryRpcUrls: process.env.SECONDARY_RPC_URLS ? process.env.SECONDARY_RPC_URLS.split(',') : [],

  sellStrategy: (process.env.SELL_STRATEGY || 'single') as 'single' | 'partial_50_50',
  partialSellDelayMs: parseInt(process.env.PARTIAL_SELL_DELAY_MS || '15000', 10),

  paperImpactThresholdSol: parseFloat(process.env.PAPER_IMPACT_THRESHOLD_SOL || '0.0037'),
  paperImpactPower: parseFloat(process.env.PAPER_IMPACT_POWER || '2.2'),
  paperImpactBase: parseFloat(process.env.PAPER_IMPACT_BASE || '0.05'),
  paperImpactK: parseFloat(process.env.PAPER_IMPACT_K || '0.30'),

  maxExpectedImpact: parseFloat(process.env.MAX_EXPECTED_IMPACT || '0.25'),
  skipIfImpactTooHigh: process.env.SKIP_IF_IMPACT_TOO_HIGH === 'true',

  writeOffThresholdPct: parseFloat(process.env.WRITE_OFF_THRESHOLD_PCT || '0.3'),

  // Panic Sell & Momentum
  panicSellJitoTip: parseFloat(process.env.PANIC_SELL_JITO_TIP || '0.005'), // High base, but will be dynamically capped
  hardStopLossPct: parseFloat(process.env.HARD_STOP_LOSS_PCT || '10'),
  momentumExitSensitivity: parseInt(process.env.MOMENTUM_EXIT_SENSITIVITY || '1', 10), // ⭐ EXPERT REC: 1 drop = exit (High Sensitivity)

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
    wsUrl: config.primaryRpcWsUrl,
    httpUrl: config.primaryRpcHttpUrl,
  };
};

