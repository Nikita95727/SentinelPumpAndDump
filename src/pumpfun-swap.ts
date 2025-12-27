import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
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
  async buy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number // в SOL
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 200; // 200ms между попытками

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.executeBuy(wallet, tokenMint, amountSol, attempt);

      // Успех - возвращаем результат
      if (result.success) {
        return result;
      }

      // Проверяем ошибку
      const is3012Error = result.error?.includes('Custom:3012') || result.error?.includes('"Custom":3012');

      // Если НЕ 3012 или последняя попытка - возвращаем ошибку
      if (!is3012Error || attempt === MAX_RETRIES) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `❌ BUY FAILED after ${attempt} attempts: ${result.error}`,
        });
        return result;
      }

      // Ретрай для 3012 (токен ещё не готов)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `🔁 Custom:3012 (token not ready), retry ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS}ms...`,
      });

      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    }

    // Не должно сюда попасть, но на всякий случай
    return { success: false, error: 'Max retries exceeded' };
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

      // ✅ FIX: Создаем ATA правильно через SPL Token helper
      const ata = await getAssociatedTokenAddress(
        mintPubkey,
        wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

      // Проверяем существует ли ATA
      const ataAccountInfo = await this.connection.getAccountInfo(ata);
      const needsAta = ataAccountInfo === null;

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
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
      );
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
      );

      // ✅ FIX: Добавляем ПРАВИЛЬНУЮ ATA creation ТОЛЬКО если нужно
      if (needsAta) {
        const ataIx = createAssociatedTokenAccountInstruction(
          wallet.publicKey, // payer
          ata,              // ata address
          wallet.publicKey, // owner
          mintPubkey,       // mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        transaction.add(ataIx);
      }

      transaction.add(...buyInstructions.instructions);

      // Отправляем с skipPreflight
      const signature = await sendAndConfirmTransaction(this.connection, transaction, [wallet], {
        commitment: 'processed',
        skipPreflight: true,
        preflightCommitment: 'processed',
        maxRetries: 5,
      });

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
      const errorMessage = error instanceof Error ? error.message : String(error);

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

      const sellInstructions = await this.sdk.getSellInstructionsByTokenAmount(
        wallet.publicKey,
        mintPubkey,
        sellTokenAmount,
        slippageBasisPoints,
        'processed'
      );

      const transaction = new Transaction();
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
      );
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 })
      );
      transaction.add(...sellInstructions.instructions);

      const signature = await sendAndConfirmTransaction(this.connection, transaction, [wallet], {
        commitment: 'processed',
        skipPreflight: true,
        preflightCommitment: 'processed',
        maxRetries: 5,
      });

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

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ Pump.fun SELL (SDK) attempt ${attempt} FAILED: ${errorMessage} | Duration: ${sellDuration}ms`,
      });

      return { success: false, error: errorMessage };
    }
  }
}
