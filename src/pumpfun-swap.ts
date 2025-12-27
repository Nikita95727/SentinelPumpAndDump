import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

/**
 * Pump.fun Swap: SDK инструкции + прямая отправка БЕЗ preflight
 * ⚡ КРИТИЧНО ДЛЯ СНАЙПИНГА: skipPreflight + processed commitment
 */
export class PumpFunSwap {
  private sdk: PumpFunSDK;
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    
    // Create AnchorProvider for SDK (dummy wallet, we'll pass real keypair to buy/sell)
    const wallet = new NodeWallet(new Keypair());
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'confirmed', // Для SDK internal calls
    });
    
    this.sdk = new PumpFunSDK(provider);
  }

  /**
   * BUY: SOL → Token
   * Использует SDK для инструкций, но отправляет БЕЗ preflight для скорости
   */
  async buy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number // в SOL
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const buyStartTime = Date.now();
    
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const buyAmountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun BUY (Direct): ${amountSol} SOL → ${tokenMint}`,
      });

      // SLIPPAGE: 20% (2000 basis points) для агрессивного входа
      const slippageBasisPoints = BigInt(2000);

      // Получить инструкции buy через SDK
      const buyTx = await this.sdk.getBuyInstructionsBySolAmount(
        wallet.publicKey,
        mintPubkey,
        buyAmountLamports,
        slippageBasisPoints,
        'confirmed' // commitment для getInstructions
      );

      // ⚡ КРИТИЧНО: Добавляем агрессивные priority fees
      buyTx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })
      );
      buyTx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }) // Агрессивный приоритет
      );

      // Get wallet token balance BEFORE buy (для расчета полученных токенов)
      const userTokenAccountsBefore = await this.connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: mintPubkey }
      );
      const tokenBalanceBefore = userTokenAccountsBefore.value.length > 0
        ? parseInt(userTokenAccountsBefore.value[0].account.data.parsed.info.tokenAmount.amount)
        : 0;

      // ⚡ КРИТИЧНО: Отправляем транзакцию БЕЗ preflight для максимальной скорости
      const signature = await sendAndConfirmTransaction(
        this.connection,
        buyTx,
        [wallet],
        {
          commitment: 'processed', // ⚡ МАКСИМАЛЬНАЯ СКОРОСТЬ
          skipPreflight: true,     // ⚡ БЕЗ СИМУЛЯЦИИ - КРИТИЧНО!
          maxRetries: 3,
        }
      );

      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;

      // Get wallet token balance AFTER buy
      const userTokenAccountsAfter = await this.connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: mintPubkey }
      );
      const tokenBalanceAfter = userTokenAccountsAfter.value.length > 0
        ? parseInt(userTokenAccountsAfter.value[0].account.data.parsed.info.tokenAmount.amount)
        : 0;

      const tokensReceived = tokenBalanceAfter - tokenBalanceBefore;

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Pump.fun BUY (Direct) success: ${signature} | Tokens: ${tokensReceived}, Duration: ${buyDuration}ms, Explorer: https://solscan.io/tx/${signature}`,
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

      // 🔴 КРИТИЧНОЕ: детальное логирование ошибок
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: tokenMint,
        message: `❌ Pump.fun BUY (Direct) FAILED: ${errorMessage} | Invested: ${amountSol} SOL, Duration: ${buyDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * SELL: Token → SOL
   * Использует SDK для инструкций, но отправляет БЕЗ preflight для скорости
   */
  async sell(
    wallet: Keypair,
    tokenMint: string,
    amountTokens: number // в токенах (raw amount, не с decimals)
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const sellStartTime = Date.now();
    
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const sellAmount = BigInt(Math.floor(amountTokens));

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun SELL (Direct): ${amountTokens} tokens → SOL for ${tokenMint}`,
      });

      // Get SOL balance BEFORE sell
      const solBalanceBefore = await this.connection.getBalance(wallet.publicKey);

      // SLIPPAGE: 20% (2000 basis points) для агрессивного выхода
      const slippageBasisPoints = BigInt(2000);

      // Получить инструкции sell через SDK
      const sellTx = await this.sdk.getSellInstructionsByTokenAmount(
        wallet.publicKey,
        mintPubkey,
        sellAmount,
        slippageBasisPoints,
        'confirmed' // commitment для getInstructions
      );

      // ⚡ КРИТИЧНО: Добавляем агрессивные priority fees для SELL
      sellTx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })
      );
      sellTx.add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }) // ЕЩЕ АГРЕССИВНЕЕ для sell
      );

      // ⚡ КРИТИЧНО: Отправляем транзакцию БЕЗ preflight для максимальной скорости
      const signature = await sendAndConfirmTransaction(
        this.connection,
        sellTx,
        [wallet],
        {
          commitment: 'processed', // ⚡ МАКСИМАЛЬНАЯ СКОРОСТЬ
          skipPreflight: true,     // ⚡ БЕЗ СИМУЛЯЦИИ - КРИТИЧНО!
          maxRetries: 3,
        }
      );

      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;

      // Get SOL balance AFTER sell
      const solBalanceAfter = await this.connection.getBalance(wallet.publicKey);
      const solReceived = (solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL;

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `✅ Pump.fun SELL (Direct) success: ${signature} | Sold: ${amountTokens} tokens, Received: ${solReceived.toFixed(6)} SOL, Duration: ${sellDuration}ms, Balance: ${(solBalanceBefore / LAMPORTS_PER_SOL).toFixed(6)} → ${(solBalanceAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL, Explorer: https://solscan.io/tx/${signature}`,
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
        message: `❌ Pump.fun SELL (Direct) FAILED: ${errorMessage} | Tokens: ${amountTokens}, Duration: ${sellDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Ensure token account exists (pre-create ATA)
   * SDK handles ATA creation automatically
   */
  async ensureTokenAccount(wallet: Keypair, tokenMint: string): Promise<void> {
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `ℹ️ SDK handles ATA creation automatically for ${tokenMint}`,
    });
  }
}
