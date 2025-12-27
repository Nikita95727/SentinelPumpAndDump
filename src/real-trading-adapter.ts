import { WalletManager } from './wallet';
import { JupiterSwap } from './jupiter-swap';
import { Connection } from '@solana/web3.js';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

/**
 * Real Trading Adapter
 * Интегрирует WalletManager и JupiterSwap для реальной торговли
 */
export class RealTradingAdapter {
  private walletManager: WalletManager;
  private jupiterSwap: JupiterSwap;
  private tokenBalanceCache = new Map<string, { balance: number; timestamp: number }>(); // mint → {balance, timestamp}
  private readonly CACHE_TTL = 5000; // 5 секунд

  constructor(private connection: Connection) {
    this.walletManager = new WalletManager();
    this.jupiterSwap = new JupiterSwap(connection);
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
    const keypair = this.walletManager.getKeypair();
    
    if (!keypair) {
      return { success: false, error: 'Wallet not initialized' };
    }

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔄 Executing REAL BUY: ${amountSol} SOL → ${mint}`,
    });

    // Выполнить swap через Jupiter
    const result = await this.jupiterSwap.buy(keypair, mint, amountSol);

    if (result.success) {
      // Сохранить в кэш (примерное количество токенов)
      if (result.outAmount) {
        this.tokenBalanceCache.set(mint, {
          balance: result.outAmount,
          timestamp: Date.now(),
        });
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `✅ REAL BUY SUCCESS: ${result.signature}, received ~${result.outAmount} tokens`,
      });

      return {
        success: true,
        signature: result.signature,
        tokensReceived: result.outAmount,
      };
    } else {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ REAL BUY FAILED: ${result.error}`,
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
    const keypair = this.walletManager.getKeypair();
    
    if (!keypair) {
      return { success: false, error: 'Wallet not initialized' };
    }

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: mint,
      message: `🔄 Executing REAL SELL: ${mint} → SOL (expected ~${expectedAmountSol.toFixed(6)} SOL)`,
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

    // Выполнить swap через Jupiter
    const result = await this.jupiterSwap.sell(keypair, mint, tokenBalance);

    if (result.success) {
      const solReceived = result.outAmount ? result.outAmount / 1e9 : 0;

      // Очистить кэш
      this.tokenBalanceCache.delete(mint);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `✅ REAL SELL SUCCESS: ${result.signature}, received ${solReceived.toFixed(6)} SOL`,
      });

      return {
        success: true,
        signature: result.signature,
        solReceived,
      };
    } else {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `❌ REAL SELL FAILED: ${result.error}`,
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

    const balance = await this.jupiterSwap.getTokenBalance(publicKey, mint);

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
}

