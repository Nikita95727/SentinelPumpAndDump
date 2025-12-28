/**
 * Balance Manager - управление торговым балансом
 * Автоматический вывод излишка на личный кошелек
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

export class BalanceManager {
  private connection: Connection;
  private walletKeypair: Keypair | null = null;

  constructor(connection: Connection, walletKeypair?: Keypair) {
    this.connection = connection;
    this.walletKeypair = walletKeypair || null;
  }

  /**
   * Устанавливает кошелек для операций
   */
  setWallet(keypair: Keypair): void {
    this.walletKeypair = keypair;
  }

  /**
   * Проверяет баланс и выводит излишек на личный кошелек
   * @param currentBalance - текущий баланс торгового кошелька
   * @returns true если был выполнен вывод, false если нет
   */
  async checkAndWithdrawExcess(currentBalance: number): Promise<boolean> {
    // Проверяем, что все настройки заданы
    if (!config.personalWalletAddress) {
      // Логируем только один раз, чтобы не спамить
      return false;
    }

    if (!this.walletKeypair) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: `⚠️ BalanceManager: Wallet not set, cannot withdraw excess`,
      });
      return false;
    }

    // Проверяем, превышает ли баланс лимит
    if (currentBalance <= config.maxTradingBalance) {
      return false; // Баланс в норме
    }

    // Рассчитываем излишек
    const excess = currentBalance - config.maxTradingBalance;
    
    // Оставляем небольшой резерв для комиссий (0.001 SOL)
    const withdrawAmount = excess - 0.001;
    
    if (withdrawAmount <= 0.001) {
      // Излишек слишком мал для вывода (меньше комиссии)
      return false;
    }

    try {
      // Выводим излишек
      const success = await this.withdrawToPersonalWallet(withdrawAmount);
      
      if (success) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `✅ Excess balance withdrawn: ${withdrawAmount.toFixed(6)} SOL → ${config.personalWalletAddress.substring(0, 8)}... | Trading balance: ${config.maxTradingBalance.toFixed(6)} SOL`,
        });
      }
      
      return success;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to withdraw excess balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Отправляет SOL на личный кошелек
   * @param amountSol - количество SOL для отправки
   */
  private async withdrawToPersonalWallet(amountSol: number): Promise<boolean> {
    if (!this.walletKeypair) {
      throw new Error('Wallet not set');
    }

    if (!config.personalWalletAddress) {
      throw new Error('Personal wallet address not configured');
    }

    try {
      const recipientPubkey = new PublicKey(config.personalWalletAddress);
      const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

      // Создаем транзакцию перевода
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.walletKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: amountLamports,
        })
      );

      // Отправляем транзакцию
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.walletKeypair],
        {
          commitment: 'confirmed',
          skipPreflight: false,
        }
      );

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ SOL withdrawal successful: ${amountSol.toFixed(6)} SOL → ${config.personalWalletAddress.substring(0, 8)}... | Signature: ${signature} | Explorer: https://solscan.io/tx/${signature}`,
      });

      return true;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ SOL withdrawal failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Получает текущий баланс кошелька
   */
  async getCurrentBalance(): Promise<number> {
    if (!this.walletKeypair) {
      return 0;
    }

    try {
      const balance = await this.connection.getBalance(this.walletKeypair.publicKey, 'confirmed');
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to get balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 0;
    }
  }
}

