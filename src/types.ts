export type Tier = 1 | 2 | 3 | null; // Tier 1 = безопасный, Tier 2 = умеренный риск, Tier 3 = высокий риск, null = не допущен

export interface TierInfo {
  tier: Tier;
  liquidity: number;
  holders: number;
  positionSizeMultiplier: number; // Множитель для размера позиции (1.0 для Tier 1, 0.5 для Tier 2, etc.)
  allowsPartialSells: boolean;
  minEffectiveMultiplier?: number; // Минимальный эффективный multiplier для входа (для Tier 2/3)
}

export type TokenType = 'MANIPULATOR' | 'GEM' | 'REGULAR';

export interface TokenCandidate {
  mint: string;
  createdAt: number; // timestamp в миллисекундах
  signature: string; // signature создания токена
  isRisky?: boolean; // Флаг для рискованных токенов (не honeypot, но требуют осторожности)
  tokenType?: TokenType; // Тип токена: манипулятор, самородок или обычный
}

export interface Position {
  token: string;
  batchId?: number; // Опционально для обратной совместимости
  entryPrice: number;
  executionPrice?: number; // Реальная цена исполнения (с учетом slippage)
  markPrice?: number; // Mark price при входе
  investedSol: number; // Amount actually invested (after entry fees)
  investedUsd?: number; // Опционально
  reservedAmount?: number; // Amount reserved/locked for this position (for accounting)
  entryTime: number;
  localHigh?: number; // локальный максимум для трейлинг-стопа (опционально)
  peakPrice: number; // пиковая цена для трейлинг-стопа
  currentPrice?: number; // кэш текущей цены
  lastRealPriceUpdate: number; // timestamp последнего обновления реальной цены
  takeProfitTarget?: number; // entryPrice * multiplier (опционально)
  stopLossTarget?: number; // для трейлинг-стопа (опционально)
  exitTimer?: number; // timestamp когда нужно закрыть (90 сек) (опционально)
  slippage?: number; // использованный slippage (опционально)
  estimatedImpact?: number; // Оценка impact при входе
  tier?: Tier; // Tier токена при входе (1, 2, 3 или null)
  status: 'active' | 'closing' | 'closed' | 'abandoned'; // abandoned = write-off
  errorCount?: number;
  // Price history for momentum calculation
  priceHistory?: Array<{ price: number; timestamp: number }>; // Последние 2-3 цены для расчета импульса
}

export interface PositionStats {
  activePositions: number;
  availableSlots: number;
  positions: Array<{
    token: string;
    multiplier: string;
    age: string;
  }>;
}

export interface Batch {
  id: number;
  candidates: TokenCandidate[];
  positions: Map<string, Position>;
  startTime: number;
  depositBefore: number;
}

export interface TradeLog {
  timestamp: string;
  type: 'buy' | 'sell' | 'batch_complete' | 'batch_start' | 'error' | 'warning' | 'info' | 'token_received' | 'filter_check' | 'filter_passed' | 'filter_failed' | 'token_added' | 'token_rejected';
  batchId?: number;
  token?: string;
  investedSol?: number;
  entryPrice?: number;
  exitPrice?: number;
  multiplier?: number;
  profitSol?: number;
  profitPct?: number;
  reason?: string;
  netProfitPct?: number;
  depositBefore?: number;
  depositAfter?: number;
  message?: string;
  filterStage?: string;
  filterResult?: boolean;
  filterDetails?: {
    age?: number;
    purchaseCount?: number;
    volumeUsd?: number;
    isLpBurned?: boolean;
    isMintRenounced?: boolean;
    hasSnipers?: boolean;
    rejectionReason?: string;
  };
}

export interface DailyStats {
  date: string;
  initialDeposit: number;
  finalDeposit: number;
  peakDeposit: number;
  totalBatches: number;
  winBatches: number;
  avgBatchProfitPct: number;
  totalTrades: number;
  hitsAbove3x: number;
  maxDrawdownPct: number;
  totalProfitSol: number;
  totalProfitUsd: number;
}

export interface Config {
  initialDeposit: number;
  solUsdRate: number;
  maxOpenPositions: number;
  maxDrawdownPct: number;
  batchSize: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  minPurchases: number;
  minMarketCap: number;
  minVolumeUsd: number;
  minLiquidityUsd: number; // ⭐ Минимальная базовая ликвидность для входа
  maxSingleHolderPct: number; // ⭐ Максимальный % токенов у одного держателя
  minEntryMultiplier: number; // ⭐ КРИТИЧНО: Минимальный multiplier для входа
  takeProfitMultiplier: number;
  exitTimerSeconds: number;
  trailingStopPct: number;
  priorityFee: number;
  signatureFee: number;
  slippageMin: number;
  slippageMax: number;
  exitSlippageMin: number; // ⭐ Минимальный slippage при выходе
  exitSlippageMax: number; // ⭐ Максимальный slippage при выходе
  rpcRequestDelay: number;
  filterCheckDelay: number;
  rateLimitRetryDelay: number;
  notificationProcessDelay: number;
  primaryRpcWsUrl: string;
  primaryRpcHttpUrl: string;
  pumpPortalWsUrl: string;
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
  jitoEnabled: boolean;
  jitoTipAmount: number;
  secondaryRpcUrls: string[];
  // Trading mode configuration
  tradingMode: 'real' | 'paper';
  realTradingEnabled: boolean; // Legacy
  walletMnemonic: string;

  // Sell strategy
  sellStrategy: 'single' | 'partial_50_50';
  partialSellDelayMs: number;

  // Impact/Slippage model
  paperImpactThresholdSol: number;
  paperImpactPower: number;
  paperImpactBase: number;
  paperImpactK: number;

  // Risk-aware sizing
  maxExpectedImpact: number;
  skipIfImpactTooHigh: boolean;

  // Write-off threshold
  writeOffThresholdPct: number;

  // Panic Sell & Momentum
  panicSellJitoTip: number;
  hardStopLossPct: number;
  momentumExitSensitivity: number;

  // Notifications
  telegramBotToken?: string;
  telegramChatId?: string;

  // Network configuration
  testnetMode: boolean;
}

