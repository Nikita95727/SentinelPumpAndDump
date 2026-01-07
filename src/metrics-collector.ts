import { Connection, PublicKey } from '@solana/web3.js';
import { TokenCandidate, TokenMetrics } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';
import { getRpcPool } from './rpc-pool';
import { priceFetcher } from './price-fetcher';
import { config } from './config';
import { cache } from './cache';
import { getMint } from '@solana/spl-token';

/**
 * MetricsCollector — сбор метрик токена без принятия решений
 * 
 * Задача: собрать ОБЪЕКТИВНЫЕ данные о токене:
 * - liquidity (объем торгов)
 * - marketCap
 * - holders (уникальные покупатели)
 * - price
 * - multiplier (от стартовой цены)
 * - concentrated liquidity признаки
 * - early activity
 * 
 * НЕ делает: фильтрацию, классификацию, принятие решений
 */
export class MetricsCollector {
  private connection: Connection;
  private rpcPool = getRpcPool();
  private readonly PUMP_FUN_START_PRICE = 0.000000028; // Стартовая цена на pump.fun

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Собирает метрики токена
   * Возвращает null если данные недоступны
   */
  async collectMetrics(candidate: TokenCandidate): Promise<TokenMetrics | null> {
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `📊 Collecting metrics for ${candidate.mint.substring(0, 8)}...`,
      });

      const mintPubkey = new PublicKey(candidate.mint);

      // 1. Получаем цену
      const price = await priceFetcher.getPrice(candidate.mint);
      if (price <= 0) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: candidate.mint,
          message: `Price not available for ${candidate.mint.substring(0, 8)}...`,
        });
        return null;
      }

      // 2. Получаем market data
      const marketData = await priceFetcher.getMarketData(candidate.mint);
      const marketCapUSD = marketData?.marketCap || 0;

      // 3. Получаем volume (используем getTradingVolume из существующего кода)
      const volumeUSD = await this.getTradingVolume(candidate.mint);

      // 4. Получаем уникальных покупателей
      const { uniqueBuyers, hasSells } = await this.getUniqueBuyers(candidate.mint);

      // 5. Проверяем concentrated liquidity
      const hasConcentratedLiquidity = await this.checkConcentratedLiquidity(candidate.mint);

      // 6. Проверяем early activity
      const { earlyActivityTracker } = await import('./early-activity-tracker');
      const hasActivity = earlyActivityTracker.hasEarlyActivity(candidate.mint);
      const earlyActivityScore = hasActivity ? 1.0 : 0.5;

      // 7. Вычисляем multiplier
      const multiplier = price / this.PUMP_FUN_START_PRICE;

      const metrics: TokenMetrics = {
        liquidityUSD: volumeUSD,
        marketCapUSD,
        holdersCount: uniqueBuyers,
        price,
        multiplier,
        hasConcentratedLiquidity,
        earlyActivityScore,
        volumeUSD,
        uniqueBuyers,
      };

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ Metrics collected: price=${price.toFixed(10)}, multiplier=${multiplier.toFixed(2)}x, liquidity=$${volumeUSD.toFixed(2)}, marketCap=$${marketCapUSD.toFixed(2)}, holders=${uniqueBuyers}, concentrated=${hasConcentratedLiquidity}`,
      });

      return metrics;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        message: `Error collecting metrics: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
  }

  /**
   * Получает объем торгов токена в USD
   */
  private async getTradingVolume(mint: string): Promise<number> {
    try {
      const mintPubkey = new PublicKey(mint);
      const connection = this.rpcPool.getConnection();

      // Получаем все транзакции
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        limit: 100,
      });

      let totalVolumeSol = 0;

      for (let idx = 0; idx < Math.min(signatures.length, 30); idx++) {
        const sigInfo = signatures[idx];
        try {
          if (idx > 0) {
            await sleep(config.rpcRequestDelay);
          }

          const connection = this.rpcPool.getConnection();
          const tx = await connection.getTransaction(sigInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta) continue;

          // Суммируем SOL transfers в транзакции
          const preBalances = tx.meta.preBalances || [];
          const postBalances = tx.meta.postBalances || [];

          for (let i = 0; i < preBalances.length; i++) {
            const balanceChange = Math.abs((postBalances[i] || 0) - (preBalances[i] || 0));
            if (balanceChange > 0) {
              totalVolumeSol += balanceChange / 1e9; // lamports to SOL
            }
          }
        } catch (error: any) {
          if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
            await sleep(config.rateLimitRetryDelay);
          }
          continue;
        }
      }

      const volumeUsd = totalVolumeSol * config.solUsdRate;
      return volumeUsd;
    } catch (error: any) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error getting trading volume: ${error?.message || String(error)}`,
      });
      return 0;
    }
  }

  /**
   * Получает количество уникальных покупателей
   */
  private async getUniqueBuyers(mint: string): Promise<{ uniqueBuyers: number; hasSells: boolean }> {
    try {
      const mintPubkey = new PublicKey(mint);
      await sleep(config.rpcRequestDelay);
      const connection = this.rpcPool.getConnection();
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        limit: 50,
      });

      const buyerAddresses = new Set<string>();
      let hasSellTransactions = false;

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

          const logs = tx.meta?.logMessages || [];

          // Проверяем логи на наличие продажи
          const hasSellLog = logs.some((log: string) => {
            const lowerLog = log.toLowerCase();
            return lowerLog.includes('sell') ||
              (lowerLog.includes('swap') && lowerLog.includes('out'));
          });

          if (hasSellLog) {
            hasSellTransactions = true;
          }

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
              address !== mint &&
              address !== '11111111111111111111111111111111' &&
              address !== 'So11111111111111111111111111111111111111112') {
              buyerAddresses.add(address);
            }
          });
        }
      }

      return {
        uniqueBuyers: buyerAddresses.size,
        hasSells: hasSellTransactions,
      };
    } catch (error: any) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error getting unique buyers: ${error?.message || String(error)}`,
      });
      return { uniqueBuyers: 0, hasSells: false };
    }
  }

  /**
   * Проверяет признаки concentrated liquidity (один держатель с >20%)
   */
  private async checkConcentratedLiquidity(mint: string): Promise<boolean> {
    try {
      const mintPubkey = new PublicKey(mint);
      await sleep(config.rpcRequestDelay);

      // Кеширование
      const cacheKey = `largest:${mint}`;
      const cached = await cache.get<Array<{ address: string; amount: string }>>(cacheKey);

      let largestAccounts;
      if (cached) {
        largestAccounts = {
          value: cached.map(acc => ({
            address: new PublicKey(acc.address),
            amount: BigInt(acc.amount),
          })),
        } as any;
      } else {
        const connection = this.rpcPool.getConnection();
        largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);

        await cache.set(cacheKey, largestAccounts.value.map(acc => ({
          address: acc.address.toString(),
          amount: acc.amount.toString(),
        })), 5);
      }

      if (largestAccounts.value.length === 0) {
        return false;
      }

      // Получаем supply
      const mintCacheKey = `mint:${mint}`;
      const mintCached = await cache.get<{ supply: string }>(mintCacheKey);

      let totalSupply;
      if (mintCached) {
        totalSupply = Number(BigInt(mintCached.supply));
      } else {
        await sleep(config.rpcRequestDelay);
        const connection = this.rpcPool.getConnection();
        const mintInfo = await getMint(connection, mintPubkey);
        totalSupply = Number(mintInfo.supply);

        await cache.set(mintCacheKey, {
          supply: mintInfo.supply.toString(),
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
          decimals: mintInfo.decimals,
        }, 10);
      }

      if (totalSupply === 0) {
        return false;
      }

      // Проверяем топ держателя
      const topHolderAmount = Number(largestAccounts.value[0].amount);
      const percentage = (topHolderAmount / totalSupply) * 100;

      // Concentrated liquidity если топ держатель имеет >20%
      return percentage > 20;
    } catch (error: any) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error checking concentrated liquidity: ${error?.message || String(error)}`,
      });
      return false;
    }
  }

}

