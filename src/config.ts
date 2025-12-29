import * as dotenv from 'dotenv';
import { Config } from './types';

dotenv.config();

/**
 * Конфигурация для Bybit Spot Trading Bot
 */
export const config: Config = {
  // Bybit API
  bybitApiKey: process.env.BYBIT_API_KEY || '',
  bybitApiSecret: process.env.BYBIT_API_SECRET || '',
  bybitTestnet: process.env.BYBIT_TESTNET === 'true',
  
  // Trading parameters
  initialDeposit: parseFloat(process.env.INITIAL_DEPOSIT || '100'), // USD
  solUsdRate: parseFloat(process.env.SOL_USD_RATE || '170'),
  maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '5'),
  maxDrawdownPct: parseFloat(process.env.MAX_DRAWDOWN_PCT || '20'),
  batchSize: parseInt(process.env.BATCH_SIZE || '5'),
  minDelaySeconds: parseInt(process.env.MIN_DELAY_SECONDS || '0'),
  maxDelaySeconds: parseInt(process.env.MAX_DELAY_SECONDS || '300'),
  minPurchases: parseInt(process.env.MIN_PURCHASES || '10'),
  minVolumeUsd: parseFloat(process.env.MIN_VOLUME_USD || '100000'),
  minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '50000'),
  maxSingleHolderPct: parseFloat(process.env.MAX_SINGLE_HOLDER_PCT || '50'),
  minEntryMultiplier: parseFloat(process.env.MIN_ENTRY_MULTIPLIER || '1.05'),
  takeProfitMultiplier: parseFloat(process.env.TAKE_PROFIT_MULTIPLIER || '2.0'),
  exitTimerSeconds: parseInt(process.env.EXIT_TIMER_SECONDS || '300'), // 5 минут
  trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT || '15'),
  priorityFee: parseFloat(process.env.PRIORITY_FEE || '0.0005'),
  signatureFee: parseFloat(process.env.SIGNATURE_FEE || '0.000005'),
  slippageMin: parseFloat(process.env.SLIPPAGE_MIN || '0.01'),
  slippageMax: parseFloat(process.env.SLIPPAGE_MAX || '0.05'),
  exitSlippageMin: parseFloat(process.env.EXIT_SLIPPAGE_MIN || '0.01'),
  exitSlippageMax: parseFloat(process.env.EXIT_SLIPPAGE_MAX || '0.05'),
  
  // Volatility filters
  minVolatility24h: parseFloat(process.env.MIN_VOLATILITY_24H || '10'), // 10% минимальная волатильность за 24ч
  minPriceChange5m: parseFloat(process.env.MIN_PRICE_CHANGE_5M || '2'), // 2% изменение за 5 минут
  minVolume24h: parseFloat(process.env.MIN_VOLUME_24H || '5000000'), // $5M минимальный объем за 24ч
  
  // Network configuration
  rpcRequestDelay: parseInt(process.env.RPC_REQUEST_DELAY || '100'),
  filterCheckDelay: parseInt(process.env.FILTER_CHECK_DELAY || '200'),
  rateLimitRetryDelay: parseInt(process.env.RATE_LIMIT_RETRY_DELAY || '2000'),
  notificationProcessDelay: parseInt(process.env.NOTIFICATION_PROCESS_DELAY || '50'),
  
  // Logging
  logDir: process.env.LOG_DIR || './logs',
  
  // Safety mechanisms
  maxSolPerTrade: parseFloat(process.env.MAX_SOL_PER_TRADE || '0.05'),
  maxTradingBalance: parseFloat(process.env.MAX_TRADING_BALANCE || '1.0'),
  minPositionSize: parseFloat(process.env.MIN_POSITION_SIZE || '10'), // $10 минимальная позиция
  maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '1000'), // $1000 максимальная позиция
  personalWalletAddress: process.env.PERSONAL_WALLET_ADDRESS || '',
  maxReservePercent: parseFloat(process.env.MAX_RESERVE_PERCENT || '80'),
  
  // Real trading configuration
  realTradingEnabled: process.env.REAL_TRADING_ENABLED === 'true',
  walletMnemonic: process.env.WALLET_MNEMONIC || '',
  
  // Network configuration (legacy, не используется для Bybit)
  testnetMode: false,
  heliusWsUrl: '',
  heliusHttpUrl: '',
  redisHost: process.env.REDIS_HOST,
  redisPort: parseInt(process.env.REDIS_PORT || '6379'),
  redisPassword: process.env.REDIS_PASSWORD,
};

// Валидация обязательных параметров
if (config.realTradingEnabled) {
  if (!config.bybitApiKey || !config.bybitApiSecret) {
    throw new Error('BYBIT_API_KEY and BYBIT_API_SECRET are required when REAL_TRADING_ENABLED=true');
  }
}

export default config;
