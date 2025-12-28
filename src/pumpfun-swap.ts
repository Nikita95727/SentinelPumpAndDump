import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Pump.fun Swap - SDK + RETRY логика для Custom:3012
 * ⚡ Retry 2-3 раза с 150-300ms задержкой если токен ещё не готов
 */
export class PumpFunSwap {
  private sdk: PumpFunSDK;
  private provider: AnchorProvider;

  constructor(private connection: Connection) {
    const wallet = new NodeWallet(new Keypair());
    this.provider = new AnchorProvider(connection, wallet, { commitment: 'processed' });
    this.sdk = new PumpFunSDK(this.provider);
  }

  /**
   * BUY с RETRY логикой для Custom:3012
   */
  /**
   * BUY - выполняется только когда токен готов (readiness check выполнен в position-manager)
   * Retry логика: одна попытка, если 3012/3031 - одна повторная через 800-1200ms
   */
  async buy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number // в SOL
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    // Попытка 1: сразу (readiness check уже выполнен в position-manager)
    const firstAttempt = await this.executeBuy(wallet, tokenMint, amountSol, 1);

    if (firstAttempt.success) {
      return firstAttempt;
    }

    // Проверяем ошибку
    const errorMsg = firstAttempt.error || '';
    const is3012Error = errorMsg.includes('Custom:3012') || errorMsg.includes('"Custom":3012');
    const is3031Error = errorMsg.includes('Custom:3031') || errorMsg.includes('"Custom":3031');

    // Если НЕ 3012/3031 - возвращаем ошибку сразу
    if (!is3012Error && !is3031Error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ BUY FAILED: ${firstAttempt.error}`,
      });
      return firstAttempt;
    }

    // 3012/3031 - ждем 800-1200ms перед повторной попыткой
    const retryDelay = 800 + Math.random() * 400; // 800-1200ms
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: tokenMint,
      message: `🔁 ${is3012Error ? 'Custom:3012' : 'Custom:3031'} (token not ready), waiting ${retryDelay.toFixed(0)}ms before retry...`,
    });

    await new Promise(resolve => setTimeout(resolve, retryDelay));

    // Попытка 2: одна повторная попытка
    const secondAttempt = await this.executeBuy(wallet, tokenMint, amountSol, 2);

    if (secondAttempt.success) {
      return secondAttempt;
    }

    // Проверяем ошибку повторной попытки
    const secondErrorMsg = secondAttempt.error || '';
    const isSecond3012 = secondErrorMsg.includes('Custom:3012') || secondErrorMsg.includes('"Custom":3012');
    const isSecond3031 = secondErrorMsg.includes('Custom:3031') || secondErrorMsg.includes('"Custom":3031');

    if (isSecond3012 || isSecond3031) {
      // Повторная попытка тоже вернула 3012/3031 - прекращаем
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ BUY FAILED: ${isSecond3012 ? 'Custom:3012' : 'Custom:3031'} on retry, discarding token`,
      });
      return { success: false, error: `${isSecond3012 ? 'Custom:3012' : 'Custom:3031'} on retry` };
    }

    // Другая ошибка на повторной попытке
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'error',
      token: tokenMint,
      message: `❌ BUY FAILED after retry: ${secondAttempt.error}`,
    });
    return secondAttempt;
  }

  /**
   * Одна попытка BUY через SDK
   */
  private async executeBuy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number,
    attempt: number
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const buyStartTime = Date.now();

    try {
      const mintPubkey = new PublicKey(tokenMint);
      const amountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
      const slippageBasisPoints = BigInt(2000); // 20% slippage

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun BUY (SDK) attempt ${attempt}: ${amountSol} SOL → ${tokenMint}`,
      });

      // Получаем инструкции через SDK
      const buyInstructions = await this.sdk.getBuyInstructionsBySolAmount(
        wallet.publicKey,
        mintPubkey,
        amountLamports,
        slippageBasisPoints,
        'processed'
      );

      // Создаем транзакцию
      const transaction = new Transaction();
      
      // Compute budget
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
      );

      // ✅ ИСПОЛЬЗУЕМ ИНСТРУКЦИИ SDK КАК ЕСТЬ - НЕ ФИЛЬТРУЕМ!
      transaction.add(...buyInstructions.instructions);
      

      // Отправляем
      const signature = await sendAndConfirmTransaction(
        this.connection, 
        transaction, 
        [wallet],
        {
          commitment: 'processed',
          skipPreflight: true,
          maxRetries: 5,
        }
      );

      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Pump.fun BUY (SDK) SUCCESS (attempt ${attempt}): ${signature} | Duration: ${buyDuration}ms | Explorer: https://solscan.io/tx/${signature}`,
        token: tokenMint,
        investedSol: amountSol,
      });

      return {
        success: true,
        signature,
        outAmount: 0,
      };
    } catch (error: any) {
      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;
      
      // Улучшенная обработка ошибок для Solana
      let errorMessage = 'Unknown error';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (error && typeof error === 'object') {
        // Пытаемся извлечь сообщение из Solana ошибки
        if (error.logs && Array.isArray(error.logs)) {
          errorMessage = `Solana error: ${error.logs.join('; ')}`;
        } else if (error.message) {
          errorMessage = error.message;
        } else {
          errorMessage = JSON.stringify(error);
        }
      }
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Pump.fun BUY (SDK) attempt ${attempt} FAILED: ${errorMessage} | Duration: ${buyDuration}ms`,
        token: tokenMint,
        investedSol: amountSol,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * SELL с RETRY логикой
   */
  async sell(
    wallet: Keypair,
    tokenMint: string,
    amountTokens: number
  ): Promise<{ success: boolean; signature?: string; error?: string; solReceived?: number }> {
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 200;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.executeSell(wallet, tokenMint, amountTokens, attempt);

      if (result.success) {
        return result;
      }

      // ✅ FIX: НЕ ретраим при критичных ошибках инфраструктуры (ATA/programId)
      // Эти ошибки не исправятся ретраем - нужна ручная проверка
      const errorMsg = result.error || '';
      const isInfrastructureError = 
        errorMsg.includes('incorrect program id') ||
        errorMsg.includes('IncorrectProgramId') ||
        errorMsg.includes('missing account') ||
        errorMsg.includes('AccountNotFound') ||
        errorMsg.includes('invalid account');
      
      if (isInfrastructureError) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `❌ CRITICAL: SELL FAILED due to infrastructure error (ATA/programId) - STOPPING retries to prevent fee burn: ${result.error}`,
        });
        return result;
      }

      const is3012Error = result.error?.includes('Custom:3012') || result.error?.includes('"Custom":3012');

      if (!is3012Error || attempt === MAX_RETRIES) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `❌ SELL FAILED after ${attempt} attempts: ${result.error}`,
        });
        return result;
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `🔁 Custom:3012 on SELL, retry ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS}ms...`,
      });

      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    return { success: false, error: 'Max retries exceeded' };
  }

  /**
   * Одна попытка SELL через SDK
   */
  private async executeSell(
    wallet: Keypair,
    tokenMint: string,
    amountTokens: number,
    attempt: number
  ): Promise<{ success: boolean; signature?: string; error?: string; solReceived?: number }> {
    const sellStartTime = Date.now();

    try {
      const mintPubkey = new PublicKey(tokenMint);
      const sellTokenAmount = BigInt(Math.floor(amountTokens));
      const slippageBasisPoints = BigInt(2000);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun SELL (SDK) attempt ${attempt}: ${amountTokens} tokens → ${tokenMint}`,
      });

      // Получаем инструкции через SDK
      const sellInstructions = await this.sdk.getSellInstructionsByTokenAmount(
        wallet.publicKey,
        mintPubkey,
        sellTokenAmount,
        slippageBasisPoints,
        'processed'
      );

      // Создаем транзакцию
      const transaction = new Transaction();
      
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 })
      );

      // ✅ ИСПОЛЬЗУЕМ КАК ЕСТЬ - НЕ ФИЛЬТРУЕМ!
      transaction.add(...sellInstructions.instructions);

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [wallet],
        {
          commitment: 'processed',
          skipPreflight: true,
          maxRetries: 5,
        }
      );

      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `✅ Pump.fun SELL (SDK) SUCCESS (attempt ${attempt}): ${signature} | Duration: ${sellDuration}ms | Explorer: https://solscan.io/tx/${signature}`,
      });

      return {
        success: true,
        signature,
        solReceived: 0,
      };
    } catch (error: any) {
      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // ✅ FIX: Определяем тип ошибки для правильной обработки
      const isInfrastructureError = 
        errorMessage.includes('incorrect program id') ||
        errorMessage.includes('IncorrectProgramId') ||
        errorMessage.includes('missing account') ||
        errorMessage.includes('AccountNotFound') ||
        errorMessage.includes('invalid account');

      // ✅ FIX: Логируем критичные ошибки инфраструктуры отдельно
      if (isInfrastructureError) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `❌ CRITICAL: Pump.fun SELL (SDK) attempt ${attempt} FAILED due to infrastructure error: ${errorMessage} | Duration: ${sellDuration}ms | This may indicate ATA/programId issue - position may need manual intervention`,
        });
      } else {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `❌ Pump.fun SELL (SDK) attempt ${attempt} FAILED: ${errorMessage} | Duration: ${sellDuration}ms`,
        });
      }

      return { 
        success: false, 
        error: errorMessage
      };
    }
  }
}
