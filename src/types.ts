export interface TokenCandidate {
  mint: string;
  createdAt: number; // timestamp в миллисекундах
  signature: string; // signature создания токена
  isRisky?: boolean; // Флаг для токенов из очередей 1-2 (более рисковые, но не honeypot)
}

export interface Position {
  token: string;
  batchId?: number; // Опционально для обратной совместимости
  entryPrice: number;
  investedSol: number;
  investedUsd?: number; // Опционально
  entryTime: number;
  localHigh?: number; // локальный максимум для трейлинг-стопа (опционально)
  peakPrice: number; // пиковая цена для трейлинг-стопа
  currentPrice?: number; // кэш текущей цены
  takeProfitTarget?: number; // entryPrice * multiplier (опционально)
  stopLossTarget?: number; // для трейлинг-стопа (опционально)
  exitTimer?: number; // timestamp когда нужно закрыть (90 сек) (опционально)
  slippage?: number; // использованный slippage (опционально)
  status: 'active' | 'closing' | 'closed';
  errorCount?: number;
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
  queue1MinDelaySeconds: number;
  queue1MaxDelaySeconds: number;
  queue2MinDelaySeconds: number;
  queue2MaxDelaySeconds: number;
  minPurchases: number;
  minVolumeUsd: number;
  takeProfitMultiplier: number;
  exitTimerSeconds: number;
  trailingStopPct: number;
  priorityFee: number;
  signatureFee: number;
  slippageMin: number;
  slippageMax: number;
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
}

