import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

/**
 * Pump.fun Swap using Official SDK
 * ОПТИМИЗИРОВАНО ДЛЯ МАКСИМАЛЬНОЙ СКОРОСТИ - КАЖДАЯ МИЛЛИСЕКУНДА НА СЧЕТУ!
 */
export class PumpFunSwap {
  private sdk: PumpFunSDK;
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
    
    // Create AnchorProvider for SDK (dummy wallet, we'll pass real keypair to buy/sell)
    const wallet = new NodeWallet(new Keypair());
    const provider = new AnchorProvider(connection, wallet, {
      commitment: 'finalized', // SDK требует finalized для корректной работы
    });
    
    this.sdk = new PumpFunSDK(provider);
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
      const buyAmountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun BUY (SDK): ${amountSol} SOL → ${tokenMint}`,
      });

      // Get wallet token balance BEFORE buy
      const userTokenAccount = await this.sdk.connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: mintPubkey }
      );
      const tokenBalanceBefore = userTokenAccount.value.length > 0
        ? parseInt(userTokenAccount.value[0].account.data.parsed.info.tokenAmount.amount)
        : 0;

      // ⚡ КРИТИЧНО: Агрессивные priority fees для быстрого включения в блок
      const priorityFees = {
        unitLimit: 200_000,
        unitPrice: 100_000, // 100k microLamports = агрессивный приоритет
      };

      // SLIPPAGE: 10% (1000 basis points)
      const slippageBasisPoints = BigInt(1000);

      // Execute buy via SDK
      const result = await this.sdk.buy(
        wallet,
        mintPubkey,
        buyAmountLamports,
        slippageBasisPoints,
        priorityFees,
        'finalized', // commitment
        'finalized' // finality
      );

      const buyEndTime = Date.now();
      const buyDuration = buyEndTime - buyStartTime;

      if (!result.success) {
        throw new Error(result.error ? String(result.error) : 'Buy failed');
      }

      // Get wallet token balance AFTER buy
      const userTokenAccountAfter = await this.sdk.connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: mintPubkey }
      );
      const tokenBalanceAfter = userTokenAccountAfter.value.length > 0
        ? parseInt(userTokenAccountAfter.value[0].account.data.parsed.info.tokenAmount.amount)
        : 0;

      const tokensReceived = tokenBalanceAfter - tokenBalanceBefore;

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ (после операции - не замедляет!)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Pump.fun BUY (SDK) success: ${result.signature} | Tokens received: ${tokensReceived}, Duration: ${buyDuration}ms, Explorer: https://solscan.io/tx/${result.signature}`,
        token: tokenMint,
      });

      return {
        success: true,
        signature: result.signature,
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
        message: `❌ Pump.fun BUY (SDK) FAILED: ${errorMessage} | Invested: ${amountSol} SOL, Duration: ${buyDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
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
    amountTokens: number // в токенах (raw amount, не с decimals)
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    const sellStartTime = Date.now(); // ⚡ Timing для мониторинга скорости
    
    try {
      const mintPubkey = new PublicKey(tokenMint);
      const sellAmount = BigInt(Math.floor(amountTokens));

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Pump.fun SELL (SDK): ${amountTokens} tokens → SOL for ${tokenMint}`,
      });

      // Get SOL balance BEFORE sell
      const solBalanceBefore = await this.connection.getBalance(wallet.publicKey);

      // ⚡ КРИТИЧНО: Агрессивные priority fees для быстрого выхода
      const priorityFees = {
        unitLimit: 200_000,
        unitPrice: 150_000, // 150k microLamports = еще более агрессивный приоритет для sell
      };

      // SLIPPAGE: 10% (1000 basis points)
      const slippageBasisPoints = BigInt(1000);

      // Execute sell via SDK
      const result = await this.sdk.sell(
        wallet,
        mintPubkey,
        sellAmount,
        slippageBasisPoints,
        priorityFees,
        'finalized', // commitment
        'finalized' // finality
      );

      const sellEndTime = Date.now();
      const sellDuration = sellEndTime - sellStartTime;

      if (!result.success) {
        throw new Error(result.error ? String(result.error) : 'Sell failed');
      }

      // Get SOL balance AFTER sell
      const solBalanceAfter = await this.connection.getBalance(wallet.publicKey);
      const solReceived = (solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL;

      // ⚡ ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ (после операции - не замедляет!)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: tokenMint,
        message: `✅ Pump.fun SELL (SDK) success: ${result.signature} | Sold: ${amountTokens} tokens, Received: ${solReceived.toFixed(6)} SOL, Duration: ${sellDuration}ms, Balance: ${(solBalanceBefore / LAMPORTS_PER_SOL).toFixed(6)} → ${(solBalanceAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL, Explorer: https://solscan.io/tx/${result.signature}`,
      });

      return {
        success: true,
        signature: result.signature,
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
        message: `❌ Pump.fun SELL (SDK) FAILED: ${errorMessage} | Tokens: ${amountTokens}, Duration: ${sellDuration}ms, Wallet: ${wallet.publicKey.toString()}, Stack: ${errorStack?.substring(0, 200)}`,
      });

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Ensure token account exists (pre-create ATA)
   * NOTE: SDK handles ATA creation automatically, so this is optional
   */
  async ensureTokenAccount(wallet: Keypair, tokenMint: string): Promise<void> {
    // SDK handles ATA creation automatically, no need to pre-create
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `ℹ️ SDK handles ATA creation automatically for ${tokenMint}`,
    });
  }
}
