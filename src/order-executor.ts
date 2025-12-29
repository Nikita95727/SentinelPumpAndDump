/**
 * Order Executor
 * Выполняет ордера на Bybit (market или aggressive limit)
 */

import { BybitClient } from './bybit-client';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

export interface OrderResult {
  success: boolean;
  orderId?: string;
  filled?: number;
  averagePrice?: number;
  error?: string;
}

export class OrderExecutor {
  private bybitClient: BybitClient;

  constructor(bybitClient: BybitClient) {
    this.bybitClient = bybitClient;
  }

  /**
   * Выполняет покупку (Market Buy)
   */
  async executeBuy(symbol: string, amountUsd: number): Promise<OrderResult> {
    try {
      // Получаем текущую цену для расчета количества
      const ticker = await this.bybitClient.getTicker(symbol);
      if (!ticker || ticker.lastPrice <= 0) {
        return {
          success: false,
          error: `Invalid ticker for ${symbol}`,
        };
      }

      // Рассчитываем количество (amount в базовой валюте)
      const quantity = amountUsd / ticker.lastPrice;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        symbol,
        message: `🔄 Order Executor: MARKET BUY ${symbol} | amount=${amountUsd.toFixed(2)} USD, quantity=${quantity.toFixed(8)}, price=${ticker.lastPrice.toFixed(8)}`,
      });

      const result = await this.bybitClient.marketBuy(symbol, quantity);

      if (result.success) {
        return {
          success: true,
          orderId: result.orderId,
          filled: result.filled,
          averagePrice: result.averagePrice || ticker.lastPrice,
        };
      } else {
        return {
          success: false,
          error: result.error,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        symbol,
        message: `❌ Order Executor: BUY ERROR ${symbol} | amount=${amountUsd.toFixed(2)} USD, error=${errorMessage}`,
      });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Выполняет продажу (Market Sell)
   * ⚠️ ВАЖНО: Полная продажа, НЕТ partial sells
   */
  async executeSell(symbol: string, quantity: number): Promise<OrderResult> {
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        symbol,
        message: `🔄 Order Executor: MARKET SELL ${symbol} | quantity=${quantity.toFixed(8)}`,
      });

      const result = await this.bybitClient.marketSell(symbol, quantity);

      if (result.success) {
        // Получаем среднюю цену выполнения
        const ticker = await this.bybitClient.getTicker(symbol);
        const averagePrice = result.averagePrice || ticker?.lastPrice || 0;

        return {
          success: true,
          orderId: result.orderId,
          filled: result.filled,
          averagePrice,
        };
      } else {
        return {
          success: false,
          error: result.error,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        symbol,
        message: `❌ Order Executor: SELL ERROR ${symbol} | quantity=${quantity.toFixed(8)}, error=${errorMessage}`,
      });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}

