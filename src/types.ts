/**
 * TypeScript типы для Bybit Spot Trading Bot
 */

export interface VolatileAsset {
  symbol: string;
  ticker: {
    symbol: string;
    lastPrice: number;
    volume24h: number;
    priceChange24h: number;
    volatility24h: number;
    high24h: number;
    low24h: number;
  };
  volatility24h: number;
  priceChange5m: number;
  volume24h: number;
  score: number;
  detectedAt: number;
}

export interface Position {
  symbol: string;
  entryPrice: number;
  investedUsd: number; // Сумма инвестиций в USD
  quantity: number; // Количество купленных активов
  entryTime: number;
  peakPrice: number; // Пиковая цена для трейлинг-стопа
  currentPrice?: number;
  lastPriceUpdate: number;
  priceHistory?: Array<{ price: number; timestamp: number }>; // История цен для расчета импульса
  takeProfitTarget?: number;
  stopLossTarget?: number;
  exitTimer?: number; // Timestamp когда нужно закрыть
  status: 'active' | 'closing' | 'closed';
  errorCount?: number;
}

export interface PositionStats {
  activePositions: number;
  availableSlots: number;
  positions: Array<{
    symbol: string;
    multiplier: string;
    age: string;
  }>;
}

export interface TradeLog {
  timestamp: string;
  type: 'buy' | 'sell' | 'error' | 'warning' | 'info' | 'asset_detected' | 'position_opened' | 'position_closed';
  symbol?: string;
  investedUsd?: number;
  entryPrice?: number;
  exitPrice?: number;
  multiplier?: number;
  profitUsd?: number;
  profitPct?: number;
  reason?: string;
  message?: string;
}

export interface DailyStats {
  date: string;
  initialDeposit: number;
  finalDeposit: number;
  peakDeposit: number;
  totalTrades: number;
  profitableTrades: number;
  losingTrades: number;
  avgProfitPct: number;
  maxDrawdownPct: number;
  totalProfitUsd: number;
}

export interface Config {
  // Bybit API
  bybitApiKey: string;
  bybitApiSecret: string;
  bybitTestnet: boolean;
  
  // Trading parameters
  initialDeposit: number;
  solUsdRate: number;
  maxOpenPositions: number;
  maxDrawdownPct: number;
  batchSize: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  minPurchases: number;
  minVolumeUsd: number;
  minLiquidityUsd: number;
  maxSingleHolderPct: number;
  minEntryMultiplier: number;
  takeProfitMultiplier: number;
  exitTimerSeconds: number;
  trailingStopPct: number;
  priorityFee: number;
  signatureFee: number;
  slippageMin: number;
  slippageMax: number;
  exitSlippageMin: number;
  exitSlippageMax: number;
  
  // Volatility filters
  minVolatility24h: number;
  minPriceChange5m: number;
  minVolume24h: number;
  
  // Network configuration
  rpcRequestDelay: number;
  filterCheckDelay: number;
  rateLimitRetryDelay: number;
  notificationProcessDelay: number;
  heliusWsUrl: string;
  heliusHttpUrl: string;
  redisHost?: string;
  redisPort?: number;
  redisPassword?: string;
  logDir: string;
  
  // Safety mechanisms
  maxSolPerTrade: number;
  maxTradingBalance: number;
  minPositionSize: number;
  maxPositionSize: number;
  personalWalletAddress: string;
  maxReservePercent: number;
  
  // Real trading configuration
  realTradingEnabled: boolean;
  walletMnemonic: string;
  
  // Network configuration (legacy)
  testnetMode: boolean;
}
