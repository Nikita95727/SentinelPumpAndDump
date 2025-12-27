import { WalletManager } from './wallet';
import { PumpFunSwap } from './pumpfun-swap';
import { Connection } from '@solana/web3.js';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

/**
 * Real Trading Adapter
 * Интегрирует WalletManager и PumpFunSwap для реальной торговли
 * Использует прямые свапы через Pump.fun (быстрее и незаметнее чем Jupiter)
 */
export class RealTradingAdapter {
  private walletManager: WalletManager;
  private pumpFunSwap: PumpFunSwap;
  private tokenBalanceCache = new Map<string, { balance: number; timestamp: number }>(); // mint → {balance, timestamp}
  private readonly CACHE_TTL = 5000; // 5 секунд

  constructor(private connection: Connection) {
    this.walletManager = new WalletManager();
    this.pumpFunSwap = new PumpFunSwap(connection);
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
  async executeBuy(
    mint: string,
    amountSol: number
  ): Promise<{ success: boolean; signature?: string; error?: string; tokensReceived?: number }> {
    const buyStartTime = Date.now(); // ⚡ Timing
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

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔄 Executing REAL BUY: ${amountSol} SOL → ${mint}, balance: ${balanceBefore.toFixed(6)} SOL`,
    });

    // Выполнить swap через Pump.fun
    const result = await this.pumpFunSwap.buy(keypair, mint, amountSol);

    const buyDuration = Date.now() - buyStartTime;
    const balanceAfter = await this.getBalance().catch(() => balanceBefore); // Fallback on error

    if (result.success) {
      // Сохранить в кэш (примерное количество токенов)
      if (result.outAmount) {
        this.tokenBalanceCache.set(mint, {
          balance: result.outAmount,
          timestamp: Date.now(),
        });
      }

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ SUCCESS
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `✅ REAL BUY SUCCESS: ${result.signature} | Invested: ${amountSol} SOL, Tokens: ${result.outAmount}, Duration: ${buyDuration}ms, Balance: ${balanceBefore.toFixed(6)} → ${balanceAfter.toFixed(6)} SOL (${(balanceAfter - balanceBefore >= 0 ? '+' : '')}${(balanceAfter - balanceBefore).toFixed(6)}), Explorer: https://solscan.io/tx/${result.signature}`,
      });

      return {
        success: true,
        signature: result.signature,
        tokensReceived: result.outAmount,
      };
    } else {
      // 🔴 КРИТИЧНОЕ ЛОГИРОВАНИЕ FAIL
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
   */
  async executeSell(
    mint: string,
    expectedAmountSol: number // Ожидаемая сумма для расчёта (не используется для swap)
  ): Promise<{ success: boolean; signature?: string; error?: string; solReceived?: number }> {
    const sellStartTime = Date.now(); // ⚡ Timing
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

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔄 Executing REAL SELL: ${mint} → SOL (expected ~${expectedAmountSol.toFixed(6)} SOL), balance: ${balanceBefore.toFixed(6)} SOL`,
    });

    // Получить баланс токенов
    const tokenBalance = await this.getTokenBalance(mint);

    if (tokenBalance === 0) {
      const error = 'No tokens to sell';
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ REAL SELL FAILED: ${error}`,
      });
      return { success: false, error };
    }

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `Token balance: ${tokenBalance} units, selling all`,
    });

    // Выполнить swap через Pump.fun
    const result = await this.pumpFunSwap.sell(keypair, mint, tokenBalance);

    const sellDuration = Date.now() - sellStartTime;
    const balanceAfter = await this.getBalance().catch(() => balanceBefore); // Fallback on error

    if (result.success) {
      const solReceived = result.outAmount ? result.outAmount / 1e9 : 0;

      // Очистить кэш
      this.tokenBalanceCache.delete(mint);

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ SUCCESS
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `✅ REAL SELL SUCCESS: ${result.signature} | Received: ${solReceived.toFixed(6)} SOL (expected: ${expectedAmountSol.toFixed(6)}), Duration: ${sellDuration}ms, Balance: ${balanceBefore.toFixed(6)} → ${balanceAfter.toFixed(6)} SOL (${(balanceAfter - balanceBefore >= 0 ? '+' : '')}${(balanceAfter - balanceBefore).toFixed(6)}), Explorer: https://solscan.io/tx/${result.signature}`,
      });

      return {
        success: true,
        signature: result.signature,
        solReceived,
      };
    } else {
      // 🔴 КРИТИЧНОЕ ЛОГИРОВАНИЕ FAIL
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ REAL SELL FAILED: ${result.error} | Expected: ${expectedAmountSol.toFixed(6)} SOL, Duration: ${sellDuration}ms, Balance: ${balanceBefore.toFixed(6)} → ${balanceAfter.toFixed(6)} SOL`,
      });

      return {
        success: false,
        error: result.error,
      };
    }
  }

  /**
   * Получить баланс токена (с кэшированием)
   */
  async getTokenBalance(mint: string): Promise<number> {
    const cached = this.tokenBalanceCache.get(mint);
    const now = Date.now();

    // Использовать кэш если он свежий
    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached.balance;
    }

    // Запросить реальный баланс
    const publicKey = this.walletManager.getPublicKey();
    if (!publicKey) {
      return 0;
    }

    const { getAssociatedTokenAddress } = await import('@solana/spl-token');
    const tokenAccount = await getAssociatedTokenAddress(
      new (await import('@solana/web3.js')).PublicKey(mint),
      publicKey
    );
    
    const balance = await this.pumpFunSwap.getTokenBalance(tokenAccount);

    // Обновить кэш
    this.tokenBalanceCache.set(mint, { balance, timestamp: now });

    return balance;
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

  /**
   * Предварительно создать ATA для токена
   * Вызывается ЗАРАНЕЕ чтобы не замедлять buy транзакцию
   */
  async prepareTokenAccount(mint: string): Promise<boolean> {
    const keypair = this.walletManager.getKeypair();
    
    if (!keypair) {
      return false;
    }

    try {
      await this.pumpFunSwap.ensureTokenAccount(keypair, mint);
      return true;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ Failed to prepare token account: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }
}

