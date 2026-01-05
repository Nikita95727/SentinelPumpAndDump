/**
 * Trading Adapter Interface
 * Единый интерфейс для real и paper trading
 */

export interface TradeResult {
  success: boolean;
  signature?: string; // Transaction signature (real) or fake signature (paper)
  tokensReceived?: number; // For BUY
  solReceived?: number; // For SELL
  executionPrice?: number; // Реальная цена исполнения (с учетом slippage)
  markPrice?: number; // Mark price (до исполнения)
  estimatedImpact?: number; // Оценка impact в %
  error?: string;
}

export interface ITradingAdapter {
  /**
   * Выполняет покупку токена
   */
  executeBuy(tokenMint: string, amountSol: number): Promise<TradeResult>;

  /**
   * Выполняет продажу токена
   */
  executeSell(tokenMint: string, amountTokens: number, options?: { jitoTip?: number }): Promise<TradeResult>;

  /**
   * Получает режим работы адаптера
   */
  getMode(): 'real' | 'paper';

  /**
   * Оценивает ожидаемый impact для размера позиции
   */
  estimateImpact(amountSol: number): number; // Возвращает impact в % (0-1)
}

