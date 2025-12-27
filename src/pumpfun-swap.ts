import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';
import { Buffer } from 'buffer';

const LAMPORTS_PER_SOL = 1_000_000_000;
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_DEPLOYER = new PublicKey('39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg');
const TOKEN_METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const GLOBAL_SEED = 'global';
const BONDING_CURVE_SEED = 'bonding-curve';
const ASSOCIATED_SEED = 'associated-token-seed';

// Discriminators for Pump.fun instructions
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]); // 8 bytes
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]); // 8 bytes

/**
 * Pump.fun Swap - ПОЛНОСТЬЮ САМОПИСНАЯ РЕАЛИЗАЦИЯ
 * ⚡ Прямое взаимодействие с bonding curve БЕЗ SDK
 */
export class PumpFunSwap {
  private connection: Connection;
  private bondingCurvePDACache = new Map<string, PublicKey>();
  private associatedBondingCurveCache = new Map<string, PublicKey>();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * BUY: Покупка токенов напрямую через bonding curve
   */
  async buy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number // в SOL
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const buyStartTime = Date.now();

    try {
      const mintPubkey = new PublicKey(tokenMint);
      const buyAmountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun BUY (Direct): ${amountSol} SOL → ${tokenMint}`,
      });

      // Получаем все необходимые PDA (локально, без RPC!)
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from(BONDING_CURVE_SEED), mintPubkey.toBuffer()],
        PUMP_FUN_PROGRAM
      );

      const associatedBondingCurve = await getAssociatedTokenAddress(
        mintPubkey,
        bondingCurve,
        true
      );

      const associatedUser = await getAssociatedTokenAddress(
        mintPubkey,
        wallet.publicKey,
        false
      );

      // Global account (статический адрес)
      const [global] = PublicKey.findProgramAddressSync(
        [Buffer.from(GLOBAL_SEED)],
        PUMP_FUN_PROGRAM
      );

      // ⚡ КРИТИЧНО: Получаем feeRecipient из global account (1 RPC call)
      const globalAccountInfo = await this.connection.getAccountInfo(global);
      if (!globalAccountInfo) {
        throw new Error('Global account not found');
      }
      
      // Парсим global account: feeRecipient находится по offset 8 (первые 8 байт - discriminator)
      const feeRecipient = new PublicKey(globalAccountInfo.data.slice(8, 40)); // 32 bytes

      // Max SOL cost (20% slippage для агрессивного входа)
      const maxSolCost = Math.floor(buyAmountLamports * 1.2);

      // Создаем BUY instruction
      const buyInstruction = this.createBuyInstruction(
        wallet.publicKey,
        mintPubkey,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        global,
        feeRecipient,
        buyAmountLamports,
        maxSolCost
      );

      // Создаем транзакцию
      const transaction = new Transaction();
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
      );
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }) // Aggressive priority
      );
      transaction.add(buyInstruction);

      // Отправляем транзакцию
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
        message: `✅ Pump.fun BUY (Direct) success: ${signature} | Duration: ${buyDuration}ms | Explorer: https://solscan.io/tx/${signature}`,
        token: tokenMint,
        investedSol: amountSol,
      });

      return {
        success: true,
        signature,
        outAmount: 0, // We don't parse outAmount from logs for now
      };
    } catch (error: any) {
      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Pump.fun BUY (Direct) FAILED: ${errorMessage} | Invested: ${amountSol} SOL, Duration: ${buyDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
        token: tokenMint,
        investedSol: amountSol,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * SELL: Продажа токенов напрямую через bonding curve
   */
  async sell(
    wallet: Keypair,
    tokenMint: string,
    amountTokens: number // в tokens (raw amount with decimals)
  ): Promise<{ success: boolean; signature?: string; error?: string; solReceived?: number }> {
    const sellStartTime = Date.now();

    try {
      const mintPubkey = new PublicKey(tokenMint);
      const sellTokenAmount = Math.floor(amountTokens);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun SELL (Direct): ${amountTokens} tokens → ${tokenMint}`,
      });

      // Получаем все необходимые PDA
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from(BONDING_CURVE_SEED), mintPubkey.toBuffer()],
        PUMP_FUN_PROGRAM
      );

      const associatedBondingCurve = await getAssociatedTokenAddress(
        mintPubkey,
        bondingCurve,
        true
      );

      const associatedUser = await getAssociatedTokenAddress(
        mintPubkey,
        wallet.publicKey,
        false
      );

      const [global] = PublicKey.findProgramAddressSync(
        [Buffer.from(GLOBAL_SEED)],
        PUMP_FUN_PROGRAM
      );

      const globalAccountInfo = await this.connection.getAccountInfo(global);
      if (!globalAccountInfo) {
        throw new Error('Global account not found');
      }
      const feeRecipient = new PublicKey(globalAccountInfo.data.slice(8, 40));

      // Min SOL output (20% slippage для быстрого выхода)
      const minSolOutput = 0; // Для агрессивной продажи принимаем любую цену

      // Создаем SELL instruction
      const sellInstruction = this.createSellInstruction(
        wallet.publicKey,
        mintPubkey,
        bondingCurve,
        associatedBondingCurve,
        associatedUser,
        global,
        feeRecipient,
        sellTokenAmount,
        minSolOutput
      );

      const transaction = new Transaction();
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })
      );
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }) // More aggressive for sell
      );
      transaction.add(sellInstruction);

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
        message: `✅ Pump.fun SELL (Direct) success: ${signature} | Sold: ${amountTokens} tokens, Duration: ${sellDuration}ms, Explorer: https://solscan.io/tx/${signature}`,
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
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ Pump.fun SELL (Direct) FAILED: ${errorMessage} | Tokens: ${amountTokens}, Duration: ${sellDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Создает BUY instruction для Pump.fun
   * ⚡ ИСПРАВЛЕНО: mint теперь writable, БЕЗ createAssociatedTokenAccountInstruction
   */
  private createBuyInstruction(
    user: PublicKey,
    mint: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    associatedUser: PublicKey,
    global: PublicKey,
    feeRecipient: PublicKey,
    amount: number,
    maxSolCost: number
  ): TransactionInstruction {
    // Instruction data: discriminator (8 bytes) + amount (8 bytes) + maxSolCost (8 bytes)
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount), 8);
    data.writeBigUInt64LE(BigInt(maxSolCost), 16);

    return new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM,
      keys: [
        { pubkey: global, isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true }, // ✅ ИСПРАВЛЕНО: writable
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedUser, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_DEPLOYER, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Создает SELL instruction для Pump.fun
   * ⚡ ИСПРАВЛЕНО: mint теперь writable
   */
  private createSellInstruction(
    user: PublicKey,
    mint: PublicKey,
    bondingCurve: PublicKey,
    associatedBondingCurve: PublicKey,
    associatedUser: PublicKey,
    global: PublicKey,
    feeRecipient: PublicKey,
    amount: number,
    minSolOutput: number
  ): TransactionInstruction {
    // Instruction data: discriminator (8 bytes) + amount (8 bytes) + minSolOutput (8 bytes)
    const data = Buffer.alloc(24);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(amount), 8);
    data.writeBigUInt64LE(BigInt(minSolOutput), 16);

    return new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM,
      keys: [
        { pubkey: global, isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: true }, // ✅ ИСПРАВЛЕНО: writable
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedUser, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_DEPLOYER, isSigner: false, isWritable: false },
        { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
      ],
      data,
    });
  }
}
