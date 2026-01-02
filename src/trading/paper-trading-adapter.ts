/**
 * Paper Trading Adapter
 * Симулирует торговлю без реальных транзакций
 * Полностью идентичная логика, но с симуляцией результатов
 */

import { Connection } from '@solana/web3.js';
import { ITradingAdapter, TradeResult } from './trading-adapter.interface';
import { priceFetcher } from '../price-fetcher';
import { config } from '../config';
import { logger } from '../logger';
import { getCurrentTimestamp, sleep } from '../utils';
import { calculateImpact, calculateExecutionPrice, calculateTokensReceived, calculateSolReceived, getImpactModel } from './execution-model';

interface PaperPosition {
  mint: string;
  tokensOwned: number;
  entryPrice: number;
  entryTime: number;
}

export class PaperTradingAdapter implements ITradingAdapter {
  private positions = new Map<string, PaperPosition>();
  private solBalance: number;
  private impactModel = getImpactModel();

  private getEffectiveFees(): number {
    const standardFee = config.priorityFee + config.signatureFee;
    const jitoTip = config.jitoEnabled ? config.jitoTipAmount : 0;
    return standardFee + jitoTip;
  }

  constructor(private connection: Connection, initialBalance: number) {
    this.solBalance = initialBalance;
  }

  getMode(): 'paper' {
    return 'paper';
  }

  /**
   * Оценивает ожидаемый impact для размера позиции
   */
  estimateImpact(amountSol: number): number {
    return calculateImpact(amountSol, this.impactModel);
  }

  /**
   * Симулирует покупку токена
   */
  async executeBuy(mint: string, amountSol: number): Promise<TradeResult> {
    const startTime = Date.now();

    try {
      // Получаем mark price
      const markPrice = await priceFetcher.getPrice(mint);
      if (!markPrice || markPrice <= 0) {
        return {
          success: false,
          error: `Invalid mark price for ${mint}`,
        };
      }

      // Рассчитываем ожидаемый impact
      const estimatedImpact = this.estimateImpact(amountSol);

      // Рассчитываем текущие комиссии (включая Jito Tip если включен)
      const currentFees = this.getEffectiveFees();

      // Рассчитываем execution price (с учетом impact)
      const executionPrice = calculateExecutionPrice(markPrice, estimatedImpact, true);

      // Рассчитываем количество токенов (с учетом fees и impact)
      const tokensReceived = calculateTokensReceived(amountSol, markPrice, estimatedImpact, currentFees);

      // Обновляем баланс
      this.solBalance -= amountSol;

      // Сохраняем позицию
      this.positions.set(mint, {
        mint,
        tokensOwned: tokensReceived,
        entryPrice: executionPrice,
        entryTime: Date.now(),
      });

      // Генерируем fake signature
      const fakeSignature = `paper-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      const duration = Date.now() - startTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `📄 PAPER BUY: ${mint} | Invested: ${amountSol.toFixed(6)} SOL (Fee: ${currentFees.toFixed(6)} SOL) ${config.jitoEnabled ? '🌩️ Jito Simulated' : ''} | MarkPrice: ${markPrice.toFixed(10)}, ExecutionPrice: ${executionPrice.toFixed(10)}, Impact: ${(estimatedImpact * 100).toFixed(2)}%, Tokens: ${tokensReceived.toFixed(2)}, Signature: ${fakeSignature}, Duration: ${duration}ms, Balance: ${this.solBalance.toFixed(6)} SOL`,
      });

      return {
        success: true,
        signature: fakeSignature,
        tokensReceived,
        executionPrice,
        markPrice,
        estimatedImpact,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ PAPER BUY FAILED: ${mint} | ${errorMessage}`,
      });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Симулирует продажу токена
   * Поддерживает partial sells если включено в конфиге
   */
  async executeSell(mint: string, amountTokens: number): Promise<TradeResult> {
    const startTime = Date.now();

    try {
      const position = this.positions.get(mint);
      if (!position || position.tokensOwned === 0) {
        return {
          success: false,
          error: `No position found for ${mint}`,
        };
      }

      // Проверяем, что у нас достаточно токенов
      const tokensToSell = Math.min(amountTokens, position.tokensOwned);

      // Получаем mark price
      const markPrice = await priceFetcher.getPrice(mint);
      if (!markPrice || markPrice <= 0) {
        return {
          success: false,
          error: `Invalid mark price for ${mint}`,
        };
      }

      // Рассчитываем impact для продажи
      // Impact зависит от размера продажи в SOL эквиваленте
      const sellSizeSol = tokensToSell * markPrice;
      const estimatedImpact = this.estimateImpact(sellSizeSol);

      // Рассчитываем текущие комиссии (включая Jito Tip если включен)
      const currentFees = this.getEffectiveFees();

      // Рассчитываем execution price (с учетом impact)
      const executionPrice = calculateExecutionPrice(markPrice, estimatedImpact, false);

      // Рассчитываем SOL полученный (с учетом fees и impact)
      const solReceived = calculateSolReceived(tokensToSell, markPrice, estimatedImpact, currentFees);

      // Обновляем баланс
      this.solBalance += solReceived;

      // Обновляем позицию
      position.tokensOwned -= tokensToSell;
      if (position.tokensOwned <= 0) {
        this.positions.delete(mint);
      }

      // Генерируем fake signature
      const fakeSignature = `paper-${Date.now()}-${Math.random().toString(36).substring(7)}`;

      const duration = Date.now() - startTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `📄 PAPER SELL: ${mint} | Sold: ${tokensToSell.toFixed(2)} tokens (Fee: ${currentFees.toFixed(6)} SOL) ${config.jitoEnabled ? '🌩️ Jito Simulated' : ''} | MarkPrice: ${markPrice.toFixed(10)}, ExecutionPrice: ${executionPrice.toFixed(10)}, Impact: ${(estimatedImpact * 100).toFixed(2)}%, Received: ${solReceived.toFixed(6)} SOL, Signature: ${fakeSignature}, Duration: ${duration}ms, Balance: ${this.solBalance.toFixed(6)} SOL`,
      });

      return {
        success: true,
        signature: fakeSignature,
        solReceived,
        executionPrice,
        markPrice,
        estimatedImpact,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ PAPER SELL FAILED: ${mint} | ${errorMessage}`,
      });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Получает текущий баланс SOL
   */
  getBalance(): number {
    return this.solBalance;
  }

  /**
   * Получает позицию по mint
   */
  getPosition(mint: string): PaperPosition | undefined {
    return this.positions.get(mint);
  }

  /**
   * Получает все позиции
   */
  getAllPositions(): Map<string, PaperPosition> {
    return new Map(this.positions);
  }
}