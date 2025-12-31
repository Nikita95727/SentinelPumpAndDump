/**
 * Real Trading Adapter
 * Реальная торговля через Pump.fun / Jupiter
 * Реализует ITradingAdapter для единого интерфейса
 */

import { WalletManager } from '../wallet';
import { PumpFunSwap } from '../pumpfun-swap';
import { JupiterSwap } from '../jupiter-swap';
import { Connection } from '@solana/web3.js';
import { logger } from '../logger';
import { getCurrentTimestamp } from '../utils';
import { ITradingAdapter, TradeResult } from './trading-adapter.interface';
import { calculateImpact, getImpactModel } from './execution-model';
import { priceFetcher } from '../price-fetcher';
import { config } from '../config';

export class RealTradingAdapter implements ITradingAdapter {
  private walletManager: WalletManager;
  private pumpFunSwap: PumpFunSwap;
  private jupiterSwap: JupiterSwap;
  private tokenBalanceCache = new Map<string, { balance: number; timestamp: number }>();
  private readonly CACHE_TTL = 5000;
  private impactModel = getImpactModel();

  constructor(private connection: Connection) {
    this.walletManager = new WalletManager();
    this.pumpFunSwap = new PumpFunSwap(connection);
    this.jupiterSwap = new JupiterSwap(connection);
  }

  getMode(): 'real' {
    return 'real';
  }

  /**
   * Оценивает ожидаемый impact для размера позиции
   */
  estimateImpact(amountSol: number): number {
    return calculateImpact(amountSol, this.impactModel);
  }

  /**
   * Получить WalletManager
   */
  getWalletManager(): WalletManager {
    return this.walletManager;
  }

  /**
   * Инициализировать кошелек
   */
  async initialize(mnemonic: string): Promise<boolean> {
    const success = await this.walletManager.initialize(mnemonic);
    
    if (success) {
      const balance = await this.walletManager.getBalance();
      const address = this.walletManager.getPublicKeyString();
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Real trading wallet initialized: ${address}, Balance: ${balance.toFixed(6)} SOL`,
      });
      
      console.log(`\n🔴 ===== REAL TRADING MODE ENABLED =====`);
      console.log(`Wallet: ${address}`);
      console.log(`Balance: ${balance.toFixed(6)} SOL`);
      console.log(`🔴 ======================================\n`);
    } else {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: '❌ Failed to initialize real trading wallet',
      });
    }
    
    return success;
  }

  /**
   * Получить баланс SOL
   */
  async getBalance(): Promise<number> {
    return await this.walletManager.getBalance();
  }

  /**
   * Получить публичный адрес
   */
  getPublicKeyString(): string | null {
    return this.walletManager.getPublicKeyString();
  }

  /**
   * Выполнить покупку (SOL → Token)
   */
  async executeBuy(mint: string, amountSol: number): Promise<TradeResult> {
    const buyStartTime = Date.now();
    const keypair = this.walletManager.getKeypair();
    
    if (!keypair) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `🔴 REAL BUY FAILED: Wallet not initialized`,
      });
      return { success: false, error: 'Wallet not initialized' };
    }

    const balanceBefore = await this.getBalance();

    // Получаем mark price для логирования
    const markPrice = await priceFetcher.getPrice(mint).catch(() => null);
    const estimatedImpact = this.estimateImpact(amountSol);

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔄 Executing REAL BUY: ${amountSol} SOL → ${mint}, balance: ${balanceBefore.toFixed(6)} SOL, estimatedImpact: ${(estimatedImpact * 100).toFixed(2)}%`,
    });

    // Выполнить swap через Pump.fun
    const result = await this.pumpFunSwap.buy(keypair, mint, amountSol);

    const buyDuration = Date.now() - buyStartTime;
    const balanceAfter = await this.getBalance().catch(() => balanceBefore);

    if (result.success) {
      // Сохранить в кэш
      if (result.outAmount) {
        this.tokenBalanceCache.set(mint, {
          balance: result.outAmount,
          timestamp: Date.now(),
        });
      }

      // ⭐ КРИТИЧНО: Нормализуем outAmount перед расчетом executionPrice
      // outAmount возвращается в raw units (с учетом decimals токена, обычно 9 для pump.fun)
      const TOKEN_DECIMALS = 9; // pump.fun tokens обычно имеют 9 decimals
      const normalizedTokens = result.outAmount ? result.outAmount / Math.pow(10, TOKEN_DECIMALS) : 0;
      
      // Рассчитываем execution price из фактического результата
      const executionPrice = normalizedTokens > 0
        ? amountSol / normalizedTokens
        : markPrice || 0;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `✅ REAL BUY SUCCESS: ${result.signature} | Invested: ${amountSol} SOL, Tokens (raw): ${result.outAmount}, Tokens (normalized): ${normalizedTokens.toFixed(6)}, MarkPrice: ${markPrice?.toFixed(10) || 'N/A'}, ExecutionPrice: ${executionPrice.toFixed(10)}, Duration: ${buyDuration}ms, Balance: ${balanceBefore.toFixed(6)} → ${balanceAfter.toFixed(6)} SOL, Explorer: https://solscan.io/tx/${result.signature}`,
      });

      return {
        success: true,
        signature: result.signature,
        tokensReceived: normalizedTokens, // ⭐ Возвращаем нормализованное количество токенов
        executionPrice,
        markPrice: markPrice || undefined,
        estimatedImpact,
      };
    } else {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ REAL BUY FAILED: ${result.error} | Invested: ${amountSol} SOL, Duration: ${buyDuration}ms, Balance: ${balanceBefore.toFixed(6)} → ${balanceAfter.toFixed(6)} SOL`,
      });

      return {
        success: false,
        error: result.error,
      };
    }
  }

  /**
   * Выполнить продажу (Token → SOL)
   * Поддерживает partial sells если включено в конфиге
   */
  async executeSell(mint: string, amountTokens: number): Promise<TradeResult> {
    const sellStartTime = Date.now();
    const keypair = this.walletManager.getKeypair();
    
    if (!keypair) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `🔴 REAL SELL FAILED: Wallet not initialized`,
      });
      return { success: false, error: 'Wallet not initialized' };
    }

    const balanceBefore = await this.getBalance();

    // Получаем mark price
    const markPrice = await priceFetcher.getPrice(mint).catch(() => null);
    const sellSizeSol = markPrice ? amountTokens * markPrice : 0;
    const estimatedImpact = sellSizeSol > 0 ? this.estimateImpact(sellSizeSol) : 0;

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔄 Executing REAL SELL: ${mint} → SOL (${amountTokens} tokens), balance: ${balanceBefore.toFixed(6)} SOL, estimatedImpact: ${(estimatedImpact * 100).toFixed(2)}%`,
    });

    // Проверяем стратегию продажи
    if (config.sellStrategy === 'partial_50_50' && config.partialSellDelayMs) {
      return await this.executePartialSell(mint, amountTokens, balanceBefore, markPrice, estimatedImpact);
    }

    // Полная продажа
    // ⭐ КРИТИЧНО: amountTokens приходит нормализованным (из tokensReceived в TradeResult)
    // Но PumpFunSwap.sell() ожидает raw tokens (с учетом decimals)
    // Конвертируем нормализованные токены в raw tokens
    const TOKEN_DECIMALS = 9; // pump.fun tokens обычно имеют 9 decimals
    const rawTokensToSell = Math.floor(amountTokens * Math.pow(10, TOKEN_DECIMALS));
    
    const tokenBalance = await this.getTokenBalance(mint); // tokenBalance уже в raw units
    const tokensToSell = Math.min(rawTokensToSell, tokenBalance);

    if (tokensToSell === 0) {
      const error = 'No tokens to sell';
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ REAL SELL FAILED: ${error}`,
      });
      return { success: false, error };
    }

    // ⭐ Логируем для отладки
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔄 Converting tokens for sell: normalized=${amountTokens.toFixed(6)}, raw=${tokensToSell}, balance=${tokenBalance}`,
    });

    const result = await this.pumpFunSwap.sell(keypair, mint, tokensToSell);
    const sellDuration = Date.now() - sellStartTime;
    const balanceAfter = await this.getBalance().catch(() => balanceBefore);

    if (result.success) {
      const solReceived = result.solReceived || 0;
      
      // ⭐ КРИТИЧНО: Рассчитываем execution price из фактического результата
      // tokensToSell в raw units, но для расчета цены нужны нормализованные токены
      const TOKEN_DECIMALS = 9; // pump.fun tokens обычно имеют 9 decimals
      const normalizedTokensSold = tokensToSell / Math.pow(10, TOKEN_DECIMALS);
      const executionPrice = normalizedTokensSold > 0
        ? solReceived / normalizedTokensSold
        : markPrice || 0;

      // Очистить кэш
      this.tokenBalanceCache.delete(mint);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `✅ REAL SELL SUCCESS: ${result.signature} | Sold: ${normalizedTokensSold.toFixed(6)} tokens (raw: ${tokensToSell}), Received: ${solReceived.toFixed(6)} SOL, MarkPrice: ${markPrice?.toFixed(10) || 'N/A'}, ExecutionPrice: ${executionPrice.toFixed(10)}, Duration: ${sellDuration}ms, Balance: ${balanceBefore.toFixed(6)} → ${balanceAfter.toFixed(6)} SOL, Explorer: https://solscan.io/tx/${result.signature}`,
      });

      return {
        success: true,
        signature: result.signature,
        solReceived,
        executionPrice,
        markPrice: markPrice || undefined,
        estimatedImpact,
      };
    } else {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ REAL SELL FAILED: ${result.error} | Duration: ${sellDuration}ms`,
      });
      return {
        success: false,
        error: result.error,
      };
    }
  }

  /**
   * Выполняет частичную продажу (50% + 50%)
   */
  private async executePartialSell(
    mint: string,
    totalTokens: number,
    balanceBefore: number,
    markPrice: number | null,
    estimatedImpact: number
  ): Promise<TradeResult> {
    const firstHalf = Math.floor(totalTokens / 2);
    const secondHalf = totalTokens - firstHalf;

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `📊 PARTIAL SELL: First half: ${firstHalf} tokens (50%), Second half: ${secondHalf} tokens (50%)`,
    });

    const keypair = this.walletManager.getKeypair()!;

    // ПЕРВАЯ ПОЛОВИНА
    const firstHalfResult = await this.pumpFunSwap.sell(keypair, mint, firstHalf);

    if (!firstHalfResult.success) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ PARTIAL SELL FAILED: First half failed: ${firstHalfResult.error}`,
      });
      return { success: false, error: `First half failed: ${firstHalfResult.error}` };
    }

    const firstHalfSol = firstHalfResult.solReceived || 0;
    const balanceAfterFirstHalf = await this.getBalance().catch(() => balanceBefore);

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `✅ FIRST HALF SOLD: Received ${firstHalfSol.toFixed(6)} SOL, waiting ${config.partialSellDelayMs}ms before second half...`,
    });

    // Ждем перед второй половиной
    await new Promise(resolve => setTimeout(resolve, config.partialSellDelayMs || 15000));

    // ВТОРАЯ ПОЛОВИНА
    const remainingBalance = await this.getTokenBalance(mint);
    if (remainingBalance === 0) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        token: mint,
        message: `⚠️ No remaining tokens after first half`,
      });
      return {
        success: true,
        signature: firstHalfResult.signature,
        solReceived: firstHalfSol,
        executionPrice: firstHalf > 0 ? firstHalfSol / firstHalf : markPrice || 0,
        markPrice: markPrice || undefined,
        estimatedImpact,
      };
    }

    const secondHalfResult = await this.pumpFunSwap.sell(keypair, mint, remainingBalance);
    const balanceAfter = await this.getBalance().catch(() => balanceAfterFirstHalf);

    if (secondHalfResult.success) {
      const secondHalfSol = secondHalfResult.solReceived || 0;
      const totalSolReceived = firstHalfSol + secondHalfSol;

      // Очистить кэш
      this.tokenBalanceCache.delete(mint);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `✅ PARTIAL SELL SUCCESS: First half: ${firstHalfSol.toFixed(6)} SOL, Second half: ${secondHalfSol.toFixed(6)} SOL, Total: ${totalSolReceived.toFixed(6)} SOL, Signatures: ${firstHalfResult.signature}, ${secondHalfResult.signature}`,
      });

      return {
        success: true,
        signature: `${firstHalfResult.signature},${secondHalfResult.signature}`,
        solReceived: totalSolReceived,
        executionPrice: totalTokens > 0 ? totalSolReceived / totalTokens : markPrice || 0,
        markPrice: markPrice || undefined,
        estimatedImpact,
      };
    } else {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        token: mint,
        message: `⚠️ PARTIAL SELL PARTIAL SUCCESS: First half sold (${firstHalfSol.toFixed(6)} SOL), but second half failed: ${secondHalfResult.error}`,
      });
      return {
        success: true,
        signature: firstHalfResult.signature,
        solReceived: firstHalfSol,
        executionPrice: firstHalf > 0 ? firstHalfSol / firstHalf : markPrice || 0,
        markPrice: markPrice || undefined,
        estimatedImpact,
      };
    }
  }

  /**
   * Получить баланс токена (с кэшированием)
   */
  async getTokenBalance(mint: string): Promise<number> {
    const cached = this.tokenBalanceCache.get(mint);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached.balance;
    }

    const publicKey = this.walletManager.getPublicKey();
    if (!publicKey) {
      return 0;
    }

    const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const { PublicKey } = await import('@solana/web3.js');
    
    const tokenAccount = await getAssociatedTokenAddress(
      new PublicKey(mint),
      publicKey,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    
    try {
      const accountInfo = await this.connection.getTokenAccountBalance(tokenAccount);
      const balance = parseInt(accountInfo.value.amount);
      
      this.tokenBalanceCache.set(mint, { balance, timestamp: now });
      
      return balance;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Проверить здоровье адаптера
   */
  async healthCheck(): Promise<{ healthy: boolean; balance?: number; error?: string }> {
    try {
      const balance = await this.getBalance();
      
      if (balance < 0.01) {
        return {
          healthy: false,
          balance,
          error: `Low balance: ${balance.toFixed(6)} SOL`,
        };
      }

      return { healthy: true, balance };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

