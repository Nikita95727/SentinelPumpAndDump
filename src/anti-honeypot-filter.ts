import { Connection, PublicKey } from '@solana/web3.js';
import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';
import { getRpcPool } from './rpc-pool';
import { config } from './config';

/**
 * AntiHoneypotFilter — ЕДИНСТВЕННЫЙ жёсткий фильтр
 * 
 * Задача: проверить что токен НЕ honeypot
 * Критерий: uniqueBuyers > 1
 * 
 * Это ЕДИНСТВЕННЫЙ фильтр который НАВСЕГДА отклоняет токен
 * Все остальные проверки делаются в MetricsCollector и TokenClassifier
 */
export class AntiHoneypotFilter {
  private connection: Connection;
  private rpcPool = getRpcPool();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Проверяет токен на honeypot
   * Возвращает { passed: true } если НЕ honeypot
   * Возвращает { passed: false, reason } если honeypot
   */
  async check(candidate: TokenCandidate): Promise<{ passed: boolean; reason?: string; uniqueBuyers?: number }> {
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🔍 ANTI-HONEYPOT CHECK: ${candidate.mint.substring(0, 8)}...`,
      });

      const mintPubkey = new PublicKey(candidate.mint);

      // Получаем транзакции токена
      await sleep(config.rpcRequestDelay);
      const connection = this.rpcPool.getConnection();
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        limit: 50,
      });

      const buyerAddresses = new Set<string>();

      // Батчинг getTransaction запросов
      const signaturesToCheck = signatures.slice(0, Math.min(signatures.length, 30));
      const batchSize = 5;

      for (let i = 0; i < signaturesToCheck.length; i += batchSize) {
        const batch = signaturesToCheck.slice(i, i + batchSize);

        const txPromises = batch.map(async (sigInfo) => {
          try {
            await sleep(config.rpcRequestDelay);
            const connection = this.rpcPool.getConnection();
            return await connection.getTransaction(sigInfo.signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            });
          } catch (error: any) {
            if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
              await sleep(config.rateLimitRetryDelay);
            }
            return null;
          }
        });

        const transactions = await Promise.all(txPromises);

        for (const tx of transactions) {
          if (!tx) continue;

          // Извлекаем адреса участников транзакции
          let accountKeys: string[] = [];
          if (tx.transaction?.message) {
            try {
              const accountKeysObj = tx.transaction.message.getAccountKeys();
              accountKeys = accountKeysObj.staticAccountKeys.map((key: any) => key.toString());
            } catch (e) {
              const tokenBalances = tx.meta?.postTokenBalances || [];
              tokenBalances.forEach((balance: any) => {
                if (balance.owner) {
                  accountKeys.push(balance.owner);
                }
              });
              const preTokenBalances = tx.meta?.preTokenBalances || [];
              preTokenBalances.forEach((balance: any) => {
                if (balance.owner) {
                  accountKeys.push(balance.owner);
                }
              });
            }
          }

          accountKeys.forEach((address: string) => {
            if (address &&
              address !== candidate.mint &&
              address !== '11111111111111111111111111111111' &&
              address !== 'So11111111111111111111111111111111111111112') {
              buyerAddresses.add(address);
            }
          });
        }
      }

      const uniqueBuyers = buyerAddresses.size;

      // КРИТИЧНО: uniqueBuyers <= 1 = HONEYPOT
      if (uniqueBuyers <= 1) {
        const reason = `HONEYPOT: only ${uniqueBuyers} unique buyer(s)`;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `❌ FILTER_REJECT: ${reason}`,
        });
        return { passed: false, reason, uniqueBuyers };
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ ANTI-HONEYPOT PASSED: ${uniqueBuyers} unique buyers`,
      });

      return { passed: true, uniqueBuyers };
    } catch (error: any) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        message: `Error in anti-honeypot check: ${error?.message || String(error)}`,
      });
      // В случае ошибки считаем honeypot (безопаснее)
      return { passed: false, reason: 'Check error (safe reject)', uniqueBuyers: 0 };
    }
  }
}

