import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  PUMP_PROGRAM_ID,
} from '@pump-fun/pump-sdk';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Pump.fun Swap - Official @pump-fun/pump-sdk
 * ⚡ Использует официальный SDK с правильной структурой аккаунтов
 */
export class PumpFunSwap {
  private sdk: OnlinePumpSdk;
  private offlineSdk: PumpSdk;

  constructor(private connection: Connection) {
    this.sdk = new OnlinePumpSdk(connection);
    this.offlineSdk = new PumpSdk();

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `✅ PumpFunSwap initialized with official @pump-fun/pump-sdk`,
    });
    
    // 🔍 ДИАГНОСТИКА: Проверяем programId из SDK
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔍 SDK PUMP_PROGRAM_ID: ${PUMP_PROGRAM_ID.toString()}`,
    });
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔍 SDK TOKEN_PROGRAM_ID: ${TOKEN_PROGRAM_ID.toString()}`,
    });
  }

  /**
   * BUY с RETRY логикой для Custom:3012
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
   * Одна попытка BUY через официальный SDK
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
      const userPubkey = wallet.publicKey;
      const solAmountBN = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));
      const slippage = 20; // 20% slippage

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun BUY (Official SDK) attempt ${attempt}: ${amountSol} SOL → ${tokenMint}`,
      });

      // Получаем глобальное состояние и feeConfig
      const global = await this.sdk.fetchGlobal();
      const feeConfig = await this.sdk.fetchFeeConfig();

      // Получаем состояние для покупки (bonding curve + ATA info)
      const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
        await this.sdk.fetchBuyState(mintPubkey, userPubkey, TOKEN_PROGRAM_ID);

      // Вычисляем количество токенов
      const tokenAmount = getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve ? bondingCurve.tokenTotalSupply : null,
        bondingCurve,
        amount: solAmountBN,
      });

      // 🔴 FIX: Проверяем, не завершена ли bonding curve (миграция на Raydium)
      if (bondingCurve && bondingCurve.complete) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `❌ SKIP BUY: Token has completed bonding curve and migrated to Raydium/PumpSwap. Cannot buy on bonding curve.`,
        });
        return {
          success: false,
          error: 'Token migrated (bonding curve complete)'
        };
      }

      // Получаем инструкции для покупки
      let buyInstructions = await this.offlineSdk.buyInstructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        associatedUserAccountInfo,
        mint: mintPubkey,
        user: userPubkey,
        amount: tokenAmount,
        solAmount: solAmountBN,
        slippage,
        tokenProgram: TOKEN_PROGRAM_ID,
      });

      // 🔧 FIX: Исправляем инструкцию ATA Create - убираем data, если она есть
      // SDK добавляет data: [1] в ATA Create инструкцию, но правильная инструкция не должна иметь data
      // Это вызывает IncorrectProgramId в симуляции, когда ATA Program вызывает TOKEN_PROGRAM
      buyInstructions = buyInstructions.map((ix) => {
        const programId = ix.programId.toString();
        
        // Если это ATA Create инструкция и у неё есть data, убираем её
        if (programId === ASSOCIATED_TOKEN_PROGRAM_ID.toString() && ix.data.length > 0) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'warning',
            token: tokenMint,
            message: `🔧 FIX: Removing data from ATA Create instruction (SDK added ${ix.data.length} bytes, should be empty)`,
          });
          
          // Создаем новую инструкцию без data
          return new TransactionInstruction({
            programId: ix.programId,
            keys: ix.keys,
            data: Buffer.alloc(0), // Пустой data
          });
        }
        
        return ix;
      });

      // 🔍 ДИАГНОСТИКА: Логируем инструкции для отладки IncorrectProgramId
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `🔍 BUY Instructions Debug: ${buyInstructions.length} instructions`,
      });
      
      buyInstructions.forEach((ix, idx) => {
        const programId = ix.programId.toString();
        const keys = ix.keys.map(k => k.pubkey.toString()).join(', ');
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: tokenMint,
          message: `  Instruction ${idx}: ProgramId=${programId} | Data length: ${ix.data.length} | Keys: ${keys.substring(0, 100)}...`,
        });
      });

      // Создаем транзакцию
      const transaction = new Transaction();

      // Compute budget
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
      );

      // Добавляем инструкции из SDK
      transaction.add(...buyInstructions);

      // ⚡ PREFLIGHT SIMULATION: Проверяем транзакцию ДО отправки (БЕСПЛАТНО)
      // Используем современный VersionedTransaction API (без deprecated warnings)
      const { blockhash } = await this.connection.getLatestBlockhash('processed');

      // Собираем все инструкции
      const allInstructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
        ...buyInstructions,
      ];

      // Создаём VersionedTransaction для симуляции
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: allInstructions,
      }).compileToV0Message();

      const versionedTx = new VersionedTransaction(messageV0);
      versionedTx.sign([wallet]);

      const simulationResult = await this.connection.simulateTransaction(versionedTx, {
        commitment: 'processed',
        sigVerify: false,
      });

      if (simulationResult.value.err) {
        // Симуляция показала ошибку — НЕ отправляем, НЕ платим комиссию
        const simError = JSON.stringify(simulationResult.value.err);
        const simLogs = simulationResult.value.logs?.join('; ') || '';

        // Проверяем тип ошибки
        const is3012 = simError.includes('3012') || simLogs.includes('3012');
        const is3031 = simError.includes('3031') || simLogs.includes('3031');
        const isIncorrectProgramId = simError.includes('IncorrectProgramId') || simLogs.includes('IncorrectProgramId');

        if (is3012 || is3031) {
          // 3012/3031 в симуляции — токен не готов, можно retry без потери комиссии
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: tokenMint,
            message: `⚡ PREFLIGHT: ${is3012 ? '3012' : '3031'} detected in simulation (FREE), token not ready yet`,
          });
          return {
            success: false,
            error: `Preflight:${is3012 ? '3012' : '3031'} (simulation, no fee lost)`
          };
        }

        // 🔍 IncorrectProgramId - игнорируем (ошибка блокируется PREFLIGHT, комиссия не сжигается)
        if (isIncorrectProgramId) {
          // Тихая ошибка - не логируем, просто возвращаем failure
          // Это не критично, так как комиссия не сжигается и транзакция не отправляется
          return {
            success: false,
            error: 'Preflight:IncorrectProgramId (ignored, no fee lost)'
          };
        }

        // Другая ошибка в симуляции
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `⚡ PREFLIGHT FAILED: ${simError} | Logs: ${simLogs.substring(0, 200)}`,
        });
        return { success: false, error: `Preflight failed: ${simError}` };
      }

      // ✅ Симуляция успешна — отправляем транзакцию
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `⚡ PREFLIGHT SUCCESS: Simulation passed, sending real transaction...`,
      });

      // Устанавливаем blockhash для legacy Transaction
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;

      // Отправляем (skipPreflight=true т.к. уже симулировали)
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [wallet],
        {
          commitment: 'processed',
          skipPreflight: true, // Уже симулировали выше
          maxRetries: 3,
        }
      );

      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Pump.fun BUY (Official SDK) SUCCESS (attempt ${attempt}): ${signature} | Duration: ${buyDuration}ms | Explorer: https://solscan.io/tx/${signature}`,
        token: tokenMint,
        investedSol: amountSol,
      });

      return {
        success: true,
        signature,
        outAmount: tokenAmount.toNumber(),
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
        message: `❌ Pump.fun BUY (Official SDK) attempt ${attempt} FAILED: ${errorMessage} | Duration: ${buyDuration}ms`,
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
   * Одна попытка SELL через официальный SDK
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
      const userPubkey = wallet.publicKey;
      const sellTokenAmount = new BN(Math.floor(amountTokens));
      const slippage = 20; // 20% slippage

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun SELL (Official SDK) attempt ${attempt}: ${amountTokens} tokens → ${tokenMint}`,
      });

      // Получаем глобальное состояние и feeConfig
      const global = await this.sdk.fetchGlobal();
      const feeConfig = await this.sdk.fetchFeeConfig();

      // Получаем состояние для продажи (bonding curve)
      const { bondingCurveAccountInfo, bondingCurve } =
        await this.sdk.fetchSellState(mintPubkey, userPubkey, TOKEN_PROGRAM_ID);

      // Вычисляем минимальный выход SOL
      const minSolOutput = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: bondingCurve.tokenTotalSupply,
        bondingCurve,
        amount: sellTokenAmount,
      });

      // Получаем инструкции для продажи
      const sellInstructions = await this.offlineSdk.sellInstructions({
        global,
        bondingCurveAccountInfo,
        bondingCurve,
        mint: mintPubkey,
        user: userPubkey,
        amount: sellTokenAmount,
        solAmount: minSolOutput,
        slippage,
        tokenProgram: TOKEN_PROGRAM_ID,
        mayhemMode: false,
      });

      // 🔍 ДИАГНОСТИКА: Логируем инструкции для отладки IncorrectProgramId
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `🔍 SELL Instructions Debug: ${sellInstructions.length} instructions`,
      });
      
      sellInstructions.forEach((ix, idx) => {
        const programId = ix.programId.toString();
        const keys = ix.keys.map(k => k.pubkey.toString()).join(', ');
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: tokenMint,
          message: `  Instruction ${idx}: ProgramId=${programId.substring(0, 20)}... | Keys: ${keys.substring(0, 100)}...`,
        });
      });

      // Создаем транзакцию
      const transaction = new Transaction();

      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 })
      );

      // Добавляем инструкции из SDK
      transaction.add(...sellInstructions);

      // ⚡ PREFLIGHT SIMULATION: Проверяем транзакцию ДО отправки (БЕСПЛАТНО)
      // Используем современный VersionedTransaction API (без deprecated warnings)
      const { blockhash } = await this.connection.getLatestBlockhash('processed');

      // Собираем все инструкции
      const allSellInstructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }),
        ...sellInstructions,
      ];

      // Создаём VersionedTransaction для симуляции
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: allSellInstructions,
      }).compileToV0Message();

      const versionedTx = new VersionedTransaction(messageV0);
      versionedTx.sign([wallet]);

      const simulationResult = await this.connection.simulateTransaction(versionedTx, {
        commitment: 'processed',
        sigVerify: false,
      });

      if (simulationResult.value.err) {
        // Симуляция показала ошибку — НЕ отправляем, НЕ платим комиссию
        const simError = JSON.stringify(simulationResult.value.err);
        const simLogs = simulationResult.value.logs?.join('; ') || '';

        const isIncorrectProgramId = simError.includes('IncorrectProgramId') || simLogs.includes('IncorrectProgramId');

        // 🔍 IncorrectProgramId - игнорируем (ошибка блокируется PREFLIGHT, комиссия не сжигается)
        if (isIncorrectProgramId) {
          // Тихая ошибка - не логируем, просто возвращаем failure
          // Это не критично, так как комиссия не сжигается и транзакция не отправляется
          return {
            success: false,
            error: 'Preflight:IncorrectProgramId (ignored, no fee lost)'
          };
        }

        // Другая ошибка в симуляции
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `⚡ PREFLIGHT SELL FAILED: ${simError} | Logs: ${simLogs.substring(0, 200)}`,
        });
        return { success: false, error: `Preflight failed: ${simError}` };
      }

      // ✅ Симуляция успешна — отправляем транзакцию
      // Устанавливаем blockhash для legacy Transaction
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = wallet.publicKey;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [wallet],
        {
          commitment: 'processed',
          skipPreflight: true, // Уже симулировали выше
          maxRetries: 3,
        }
      );

      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;

      // Конвертируем SOL обратно из lamports
      const solReceived = minSolOutput.toNumber() / LAMPORTS_PER_SOL;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `✅ Pump.fun SELL (Official SDK) SUCCESS (attempt ${attempt}): ${signature} | Duration: ${sellDuration}ms | Explorer: https://solscan.io/tx/${signature}`,
      });

      return {
        success: true,
        signature,
        solReceived,
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
          message: `❌ CRITICAL: Pump.fun SELL (Official SDK) attempt ${attempt} FAILED due to infrastructure error: ${errorMessage} | Duration: ${sellDuration}ms | This may indicate ATA/programId issue - position may need manual intervention`,
        });
      } else {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          token: tokenMint,
          message: `❌ Pump.fun SELL (Official SDK) attempt ${attempt} FAILED: ${errorMessage} | Duration: ${sellDuration}ms`,
        });
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }
}
