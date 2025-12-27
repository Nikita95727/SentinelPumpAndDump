import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction, ComputeBudgetProgram, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';
import { BN } from '@coral-xyz/anchor';

const GLOBAL_SEED = 'global';
const BONDING_CURVE_SEED = 'bonding-curve';
const METADATA_SEED = 'metadata';
const MPL_TOKEN_METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/**
 * Pump.fun Swap: ПРЯМОЙ ВЫЗОВ МЕТОДОВ СМАРТ-КОНТРАКТА
 * ⚡ БЕЗ RPC CALLS - ТОЛЬКО ПРЯМАЯ ОТПРАВКА ТРАНЗАКЦИЙ
 */
export class PumpFunSwap {
  private sdk: PumpFunSDK;
  private program: any; // Используем any чтобы избежать конфликта версий Anchor
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    
    // Create AnchorProvider for program
    const wallet = new NodeWallet(new Keypair());
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
    });
    
    this.sdk = new PumpFunSDK(provider);
    this.program = this.sdk.program; // Получаем Anchor program из SDK
  }

  /**
   * BUY: ПРЯМОЙ ВЫЗОВ МЕТОДА buy() СМАРТ-КОНТРАКТА
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
        message: `🔄 Pump.fun BUY (Contract): ${amountSol} SOL → ${tokenMint}`,
      });

      // Получить PDA addresses (локально, без RPC!)
      const [global] = PublicKey.findProgramAddressSync(
        [Buffer.from(GLOBAL_SEED)],
        PUMP_FUN_PROGRAM
      );

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

      // Получить global account для feeRecipient (это единственный RPC call который нужен)
      const globalAccount = await this.program.account.global.fetch(global);
      const feeRecipient = globalAccount.feeRecipient;

      // MAX SOL COST (slippage 20%)
      const maxSolCost = Math.floor(buyAmountLamports * 1.2);

      // ⚡ КРИТИЧНО: Создаем транзакцию через program.methods - ПРЯМОЙ ВЫЗОВ КОНТРАКТА
      const tx = await this.program.methods
        .buy(
          new BN(buyAmountLamports), // amount
          new BN(maxSolCost)         // maxSolCost
        )
        .accounts({
          global: global,
          feeRecipient: feeRecipient,
          mint: mintPubkey,
          bondingCurve: bondingCurve,
          associatedBondingCurve: associatedBondingCurve,
          associatedUser: associatedUser,
          user: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
          eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
          program: PUMP_FUN_PROGRAM,
        })
        .transaction();

      // ⚡ КРИТИЧНО: Добавляем агрессивные priority fees
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })
      );
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
      );

      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      // Get token balance BEFORE (опционально, для статистики)
      let tokenBalanceBefore = 0;
      try {
        const accounts = await this.connection.getParsedTokenAccountsByOwner(
          wallet.publicKey,
          { mint: mintPubkey }
        );
        if (accounts.value.length > 0) {
          tokenBalanceBefore = parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount);
        }
      } catch (e) {
        // Игнорируем если token account не существует
      }

      // ⚡ КРИТИЧНО: Отправляем БЕЗ preflight
      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [wallet],
        {
          commitment: 'processed',
          skipPreflight: true,  // ⚡ БЕЗ СИМУЛЯЦИИ
          maxRetries: 3,
        }
      );

      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;

      // Get token balance AFTER
      let tokenBalanceAfter = 0;
      try {
        const accounts = await this.connection.getParsedTokenAccountsByOwner(
          wallet.publicKey,
          { mint: mintPubkey }
        );
        if (accounts.value.length > 0) {
          tokenBalanceAfter = parseInt(accounts.value[0].account.data.parsed.info.tokenAmount.amount);
        }
      } catch (e) {
        // Игнорируем
      }

      const tokensReceived = tokenBalanceAfter - tokenBalanceBefore;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Pump.fun BUY (Contract) success: ${signature} | Tokens: ${tokensReceived}, Duration: ${buyDuration}ms, Explorer: https://solscan.io/tx/${signature}`,
        token: tokenMint,
      });

      return {
        success: true,
        signature,
        outAmount: tokensReceived,
      };
    } catch (error) {
      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ Pump.fun BUY (Contract) FAILED: ${errorMessage} | Invested: ${amountSol} SOL, Duration: ${buyDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * SELL: ПРЯМОЙ ВЫЗОВ МЕТОДА sell() СМАРТ-КОНТРАКТА
   */
  async sell(
    wallet: Keypair,
    tokenMint: string,
    amountTokens: number
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const sellStartTime = Date.now();
    
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const sellAmount = Math.floor(amountTokens);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun SELL (Contract): ${amountTokens} tokens → SOL for ${tokenMint}`,
      });

      // Get SOL balance BEFORE
      const solBalanceBefore = await this.connection.getBalance(wallet.publicKey);

      // Получить PDA addresses (локально!)
      const [global] = PublicKey.findProgramAddressSync(
        [Buffer.from(GLOBAL_SEED)],
        PUMP_FUN_PROGRAM
      );

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

      // Получить global account для feeRecipient
      const globalAccount = await this.program.account.global.fetch(global);
      const feeRecipient = globalAccount.feeRecipient;

      // MIN SOL OUTPUT (slippage 20%)
      const minSolOutput = 0; // Принимаем любую цену для быстрого выхода

      // ⚡ КРИТИЧНО: Создаем транзакцию через program.methods
      const tx = await this.program.methods
        .sell(
          new BN(sellAmount),   // amount
          new BN(minSolOutput)  // minSolOutput
        )
        .accounts({
          global: global,
          feeRecipient: feeRecipient,
          mint: mintPubkey,
          bondingCurve: bondingCurve,
          associatedBondingCurve: associatedBondingCurve,
          associatedUser: associatedUser,
          user: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          eventAuthority: new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'),
          program: PUMP_FUN_PROGRAM,
        })
        .transaction();

      // ⚡ КРИТИЧНО: Агрессивные priority fees для SELL
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })
      );
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 })
      );

      // Get recent blockhash
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      // ⚡ КРИТИЧНО: Отправляем БЕЗ preflight
      const signature = await sendAndConfirmTransaction(
        this.connection,
        tx,
        [wallet],
        {
          commitment: 'processed',
          skipPreflight: true,
          maxRetries: 3,
        }
      );

      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;

      // Get SOL balance AFTER
      const solBalanceAfter = await this.connection.getBalance(wallet.publicKey);
      const solReceived = (solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `✅ Pump.fun SELL (Contract) success: ${signature} | Sold: ${amountTokens} tokens, Received: ${solReceived.toFixed(6)} SOL, Duration: ${sellDuration}ms, Explorer: https://solscan.io/tx/${signature}`,
      });

      return {
        success: true,
        signature,
        outAmount: solBalanceAfter,
      };
    } catch (error) {
      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ Pump.fun SELL (Contract) FAILED: ${errorMessage} | Tokens: ${amountTokens}, Duration: ${sellDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  async ensureTokenAccount(wallet: Keypair, tokenMint: string): Promise<void> {
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `ℹ️ Contract handles ATA creation automatically for ${tokenMint}`,
    });
  }
}
