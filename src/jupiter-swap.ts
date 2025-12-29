import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import fetch from 'node-fetch';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

// Jupiter API v6 endpoints (из примера ChatGPT)
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

// SOL mint address (wrapped SOL)
const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Jupiter Aggregator Swap
 * Поддерживает все токены на Solana, включая pump.fun
 */
export class JupiterSwap {
  constructor(private connection: Connection) {}

  /**
   * Получить quote для swap
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number, // в lamports или token units
    slippageBps: number = 300 // 3% slippage (300 basis points)
  ): Promise<any> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    });

    const response = await fetch(`${JUPITER_QUOTE_API}?${params}`);
    
    if (!response.ok) {
      throw new Error(`Jupiter quote API error: ${response.statusText}`);
    }
    
    const quote = await response.json();

    if (!quote || !quote.routePlan) {
      throw new Error(`No route found for ${inputMint} → ${outputMint}`);
    }

    return quote;
  }

  /**
   * Выполнить swap
   */
  async executeSwap(wallet: Keypair, quote: any): Promise<string> {
    try {
      // Получить swap transaction
      const response = await fetch(JUPITER_SWAP_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toString(),
          wrapAndUnwrapSol: true, // Автоматически wrap/unwrap SOL
          dynamicComputeUnitLimit: true, // Оптимизация compute units
          prioritizationFeeLamports: 'auto', // Автоматический priority fee
        }),
      });

      if (!response.ok) {
        throw new Error(`Jupiter swap API error: ${response.statusText}`);
      }

      const { swapTransaction } = await response.json();

      if (!swapTransaction) {
        throw new Error('No swap transaction returned from Jupiter');
      }

      // Deserialize transaction
      const transactionBuf = Buffer.from(swapTransaction, 'base64');
      let transaction;
      
      try {
        // Try VersionedTransaction first (v0 transactions)
        transaction = VersionedTransaction.deserialize(transactionBuf);
        transaction.sign([wallet]);
        
        const signature = await this.connection.sendTransaction(transaction, {
          skipPreflight: false,
          maxRetries: 3,
        });
        
        // Ждать подтверждения
        await this.connection.confirmTransaction(signature, 'confirmed');
        
        return signature;
      } catch (versionedError) {
        // Fallback to legacy transaction
        transaction = Transaction.from(transactionBuf);
        transaction.sign(wallet);
        
        const signature = await this.connection.sendRawTransaction(
          transaction.serialize(),
          { skipPreflight: false, maxRetries: 3 }
        );
        
        // Ждать подтверждения
        await this.connection.confirmTransaction(signature, 'confirmed');
        
        return signature;
      }
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Jupiter executeSwap error: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * BUY: SOL → Token
   */
  async buy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number // в SOL
  ): Promise<{ success: boolean; signature?: string; error?: string; outAmount?: number }> {
    try {
      const amountLamports = Math.floor(amountSol * 1e9);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Jupiter BUY: ${amountSol} SOL → ${tokenMint}`,
      });

      // Получить quote
      const quote = await this.getQuote(SOL_MINT, tokenMint, amountLamports, 300);

      const outAmount = parseInt(quote.outAmount);
      const priceImpact = parseFloat(quote.priceImpactPct || '0');

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Jupiter quote: ${amountSol} SOL → ${outAmount} tokens (impact: ${priceImpact.toFixed(2)}%)`,
      });

      // Проверить price impact
      if (priceImpact > 10) {
        return {
          success: false,
          error: `Price impact too high: ${priceImpact.toFixed(2)}%`,
        };
      }

      // Выполнить swap
      const signature = await this.executeSwap(wallet, quote);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Jupiter BUY success: ${signature}`,
      });

      return { success: true, signature, outAmount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Jupiter BUY error: ${errorMessage}`,
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
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Jupiter SELL: ${amountTokens} tokens → SOL (${tokenMint})`,
      });

      // Получить quote
      const quote = await this.getQuote(tokenMint, SOL_MINT, Math.floor(amountTokens), 5000); // 50% slippage для sell (увеличено для токенов с низкой ликвидностью)

      const outAmount = parseInt(quote.outAmount);
      const outSol = outAmount / 1e9;
      const priceImpact = parseFloat(quote.priceImpactPct || '0');

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Jupiter quote: ${amountTokens} tokens → ${outSol.toFixed(6)} SOL (impact: ${priceImpact.toFixed(2)}%)`,
      });

      // Проверить price impact (для sell допустим больший impact)
      if (priceImpact > 20) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          message: `⚠️ High price impact on sell: ${priceImpact.toFixed(2)}%, proceeding anyway`,
        });
      }

      // Выполнить swap
      const signature = await this.executeSwap(wallet, quote);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Jupiter SELL success: ${signature}, received ${outSol.toFixed(6)} SOL`,
      });

      return { success: true, signature, outAmount };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Jupiter SELL error: ${errorMessage}`,
      });
      
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Получить баланс токена в кошельке
   */
  async getTokenBalance(wallet: PublicKey, mint: string): Promise<number> {
    try {
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(wallet, {
        mint: new PublicKey(mint),
      });

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      // Вернуть raw amount (не decimals-adjusted)
      const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
      return parseInt(balance);
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting token balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 0;
    }
  }
}

