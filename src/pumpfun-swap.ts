import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_BONDING_CURVE_SEED = 'bonding-curve';
const LAMPORTS_PER_SOL = 1_000_000_000;

// Pump.fun instruction discriminators
const BUY_INSTRUCTION = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]); // buy
const SELL_INSTRUCTION = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]); // sell

/**
 * Pump.fun Direct Swap
 * Прямое взаимодействие с bonding curve без посредников
 * ОПТИМИЗИРОВАНО ДЛЯ МАКСИМАЛЬНОЙ СКОРОСТИ - КАЖДАЯ МИЛЛИСЕКУНДА НА СЧЕТУ!
 */
export class PumpFunSwap {
  // Кэш для PDA адресов - избегаем пересчета
  private bondingCurvePDACache = new Map<string, PublicKey>();
  private associatedBondingCurveCache = new Map<string, PublicKey>();
  private userTokenAccountCache = new Map<string, PublicKey>();

  constructor(private connection: Connection) {}

  /**
   * Получить bonding curve PDA (с кэшем для скорости)
   */
  private async getBondingCurvePDA(tokenMint: PublicKey): Promise<PublicKey> {
    const mintStr = tokenMint.toString();
    
    // Проверяем кэш - избегаем дорогого findProgramAddress
    if (this.bondingCurvePDACache.has(mintStr)) {
      return this.bondingCurvePDACache.get(mintStr)!;
    }

    const [pda] = await PublicKey.findProgramAddress(
      [Buffer.from(PUMP_FUN_BONDING_CURVE_SEED), tokenMint.toBuffer()],
      PUMP_FUN_PROGRAM
    );
    
    // Сохраняем в кэш
    this.bondingCurvePDACache.set(mintStr, pda);
    return pda;
  }

  /**
   * Получить associated bonding curve (для токенов bonding curve) с кэшем
   */
  private async getAssociatedBondingCurve(tokenMint: PublicKey): Promise<PublicKey> {
    const mintStr = tokenMint.toString();
    
    // Проверяем кэш
    if (this.associatedBondingCurveCache.has(mintStr)) {
      return this.associatedBondingCurveCache.get(mintStr)!;
    }

    const bondingCurve = await this.getBondingCurvePDA(tokenMint);
    const associated = await getAssociatedTokenAddress(tokenMint, bondingCurve, true);
    
    // Сохраняем в кэш
    this.associatedBondingCurveCache.set(mintStr, associated);
    return associated;
  }

  /**
   * BUY: SOL → Token
   */
  async buy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number // в SOL
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const buyStartTime = Date.now(); // ⚡ Timing для мониторинга скорости
    
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun BUY: ${amountSol} SOL → ${tokenMint}`,
      });

      // ⚡ КРИТИЧНО: Параллельные запросы для PDA (экономим время)
      const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);
      const [bondingCurve, associatedBondingCurve] = await Promise.all([
        this.getBondingCurvePDA(mintPubkey),
        this.getAssociatedBondingCurve(mintPubkey),
      ]);
      
      const transaction = new Transaction();

      // ⚡ КРИТИЧНО: Агрессивные priority fees для быстрого включения в блок
      // Compute budget: увеличиваем лимит и платим premium за скорость
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }) // Достаточно для buy
      );
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }) // Агрессивный приоритет
      );

      // Pump.fun сама создает ATA если нужно - не добавляем createAssociatedTokenAccountInstruction!

      // Buy instruction
      const buyIx = this.createBuyInstruction(
        wallet.publicKey,
        mintPubkey,
        bondingCurve,
        associatedBondingCurve,
        userTokenAccount,
        amountLamports
      );
      transaction.add(buyIx);

      // ⚡ КРИТИЧНО: Отправка с максимальной скоростью
      // 'processed' вместо 'confirmed' = на ~400ms быстрее (1 slot вместо ~2-3)
      // Риск: менее финализовано, но для pump.fun скорость важнее
      const signature = await sendAndConfirmTransaction(this.connection, transaction, [wallet], {
        commitment: 'processed', // ⚡ МАКСИМАЛЬНАЯ СКОРОСТЬ (не ждем confirmation)
        skipPreflight: true, // Без симуляции
        preflightCommitment: 'processed',
        maxRetries: 5, // Больше ретраев для компенсации агрессивности
      });

      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;

      // Получить баланс токенов после покупки
      const tokenBalance = await this.getTokenBalance(userTokenAccount);

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ (после операции - не замедляет!)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `✅ Pump.fun BUY success: ${signature} | Invested: ${amountSol} SOL, Received: ${tokenBalance} tokens, Duration: ${buyDuration}ms, Explorer: https://solscan.io/tx/${signature}`,
      });

      return {
        success: true,
        signature,
        outAmount: tokenBalance,
      };
    } catch (error) {
      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // 🔴 КРИТИЧНОЕ: детальное логирование ошибок
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ Pump.fun BUY FAILED: ${errorMessage} | Invested: ${amountSol} SOL, Duration: ${buyDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * SELL: Token → SOL
   */
  async sell(
    wallet: Keypair,
    tokenMint: string,
    amountTokens: number // в token units (raw amount)
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const sellStartTime = Date.now(); // ⚡ Timing для мониторинга скорости
    
    try {
      const mintPubkey = new PublicKey(tokenMint);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun SELL: ${amountTokens} tokens → SOL (${tokenMint})`,
      });

      // ⚡ КРИТИЧНО: Параллельные запросы для SELL (каждая миллисекунда важна!)
      const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);
      const [bondingCurve, associatedBondingCurve, currentBalance] = await Promise.all([
        this.getBondingCurvePDA(mintPubkey),
        this.getAssociatedBondingCurve(mintPubkey),
        this.getTokenBalance(userTokenAccount),
      ]);
      if (currentBalance === 0) {
        return { success: false, error: 'No tokens to sell' };
      }

      // Использовать весь баланс если amountTokens > currentBalance
      const sellAmount = Math.min(Math.floor(amountTokens), currentBalance);

      // Получить баланс SOL до продажи
      const solBalanceBefore = await this.connection.getBalance(wallet.publicKey);

      const transaction = new Transaction();

      // ⚡ КРИТИЧНО: Агрессивные priority fees для быстрого выхода
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }) // Достаточно для sell
      );
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }) // ЕЩЕ БОЛЕЕ агрессивный при продаже
      );

      // Sell instruction
      const sellIx = this.createSellInstruction(
        wallet.publicKey,
        mintPubkey,
        bondingCurve,
        associatedBondingCurve,
        userTokenAccount,
        sellAmount
      );
      transaction.add(sellIx);

      // ⚡ КРИТИЧНО: SELL с МАКСИМАЛЬНОЙ приоритизацией
      // Продажа еще важнее - не хотим упустить прибыль!
      const signature = await sendAndConfirmTransaction(this.connection, transaction, [wallet], {
        commitment: 'processed', // ⚡ МАКСИМАЛЬНАЯ СКОРОСТЬ
        skipPreflight: true,
        preflightCommitment: 'processed',
        maxRetries: 5, // Больше ретраев для SELL (критично!)
      });

      // Получить баланс SOL после продажи
      const solBalanceAfter = await this.connection.getBalance(wallet.publicKey);
      const solReceived = (solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL;
      
      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ (после операции - не замедляет!)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `✅ Pump.fun SELL success: ${signature} | Sold: ${sellAmount} tokens, Received: ${solReceived.toFixed(6)} SOL, Duration: ${sellDuration}ms, Balance: ${(solBalanceBefore / LAMPORTS_PER_SOL).toFixed(6)} → ${(solBalanceAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL, Explorer: https://solscan.io/tx/${signature}`,
      });

      return {
        success: true,
        signature,
        outAmount: solBalanceAfter, // в lamports
      };
    } catch (error) {
      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // 🔴 КРИТИЧНОЕ: детальное логирование ошибок
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ Pump.fun SELL FAILED: ${errorMessage} | Tokens: ${amountTokens}, Duration: ${sellDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Создать buy инструкцию
   */
  private createBuyInstruction(
    userPublicKey: PublicKey,
    mint: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    userTokenAccount: PublicKey,
    amountLamports: number
  ): TransactionInstruction {
    // Инструкция buy:
    // - 8 bytes: discriminator
    // - 8 bytes: amount (u64)
    // - 8 bytes: max_sol_cost (u64) - для slippage protection
    
    const maxSolCost = Math.floor(amountLamports * 1.05); // 5% slippage
    const data = Buffer.alloc(24);
    BUY_INSTRUCTION.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amountLamports), 8);
    data.writeBigUInt64LE(BigInt(maxSolCost), 16);

    return new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM,
      keys: [
        { pubkey: userPublicKey, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Создать sell инструкцию
   */
  private createSellInstruction(
    userPublicKey: PublicKey,
    mint: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    userTokenAccount: PublicKey,
    amountTokens: number
  ): TransactionInstruction {
    // Инструкция sell:
    // - 8 bytes: discriminator
    // - 8 bytes: amount (u64)
    // - 8 bytes: min_sol_output (u64) - для slippage protection
    
    const minSolOutput = 0; // Принимаем любую цену (можно настроить)
    const data = Buffer.alloc(24);
    SELL_INSTRUCTION.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amountTokens), 8);
    data.writeBigUInt64LE(BigInt(minSolOutput), 16);

    return new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM,
      keys: [
        { pubkey: userPublicKey, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Получить баланс токенов
   */
  async getTokenBalance(tokenAccount: PublicKey): Promise<number> {
    try {
      const accountInfo = await this.connection.getTokenAccountBalance(tokenAccount);
      return parseInt(accountInfo.value.amount);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Предварительно создать ATA (Associated Token Account)
   * Вызывается заранее чтобы не замедлять buy транзакцию
   */
  async ensureTokenAccount(wallet: Keypair, tokenMint: string): Promise<PublicKey> {
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const userTokenAccount = await getAssociatedTokenAddress(mintPubkey, wallet.publicKey);

      // Проверить существует ли
      const accountInfo = await this.connection.getAccountInfo(userTokenAccount);
      
      if (!accountInfo) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `⚡ Creating ATA for ${tokenMint}...`,
        });

        // Создать ATA
        const transaction = new Transaction();
        transaction.add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            userTokenAccount,
            wallet.publicKey,
            mintPubkey
          )
        );

        await sendAndConfirmTransaction(this.connection, transaction, [wallet], {
          commitment: 'confirmed',
          skipPreflight: true, // Максимальная скорость
        });

        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `✅ ATA created: ${userTokenAccount.toString()}`,
        });
      }

      return userTokenAccount;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to ensure ATA: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }
}

