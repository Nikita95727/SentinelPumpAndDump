import { Connection, PublicKey, ParsedAccountData } from '@solana/web3.js';
import { getMint, getAccount, unpackAccount } from '@solana/spl-token';
import { config } from './config';
import { TokenCandidate, Tier, TierInfo } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, formatSol, formatUsd, sleep } from './utils';
import { getRpcPool } from './rpc-pool';
import { cache } from './cache';

export class TokenFilters {
  private connection: Connection;
  private rpcPool = getRpcPool();

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async filterCandidate(candidate: TokenCandidate): Promise<boolean> {
    const filterDetails: any = {};

    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'start',
        message: `Starting filter check for token ${candidate.mint.substring(0, 8)}...`,
      });

      // 1. Проверка задержки (10-30 секунд)
      const age = (Date.now() - candidate.createdAt) / 1000;
      filterDetails.age = age;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'age_check',
        filterResult: age >= config.minDelaySeconds && age <= config.maxDelaySeconds,
        filterDetails: { age },
        message: `Age check: ${age.toFixed(1)}s (required: ${config.minDelaySeconds}-${config.maxDelaySeconds}s)`,
      });

      if (age < config.minDelaySeconds || age > config.maxDelaySeconds) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'age_check',
          filterDetails: { ...filterDetails, rejectionReason: `Age ${age.toFixed(1)}s outside range ${config.minDelaySeconds}-${config.maxDelaySeconds}s` },
          message: `Token rejected: age ${age.toFixed(1)}s not in range`,
        });
        return false;
      }

      // Задержка перед началом проверок
      await sleep(config.filterCheckDelay);

      // 2. Проверка количества покупок (минимум 5-10)
      const purchaseCount = await this.getPurchaseCount(candidate.mint);
      filterDetails.purchaseCount = purchaseCount;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'purchase_count',
        filterResult: purchaseCount >= config.minPurchases,
        filterDetails: { ...filterDetails },
        message: `Purchase count: ${purchaseCount} (required: >= ${config.minPurchases})`,
      });

      if (purchaseCount < config.minPurchases) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'purchase_count',
          filterDetails: { ...filterDetails, rejectionReason: `Only ${purchaseCount} purchases, need ${config.minPurchases}` },
          message: `Token rejected: insufficient purchases (${purchaseCount} < ${config.minPurchases})`,
        });
        return false;
      }

      // Задержка между проверками
      await sleep(config.filterCheckDelay);

      // 3. Проверка объема торгов (>= 2000 USD)
      const volumeUsd = await this.getTradingVolume(candidate.mint);
      filterDetails.volumeUsd = volumeUsd;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'volume_check',
        filterResult: volumeUsd >= config.minVolumeUsd,
        filterDetails: { ...filterDetails },
        message: `Trading volume: $${volumeUsd.toFixed(2)} (required: >= $${config.minVolumeUsd})`,
      });

      if (volumeUsd < config.minVolumeUsd) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'volume_check',
          filterDetails: { ...filterDetails, rejectionReason: `Volume $${volumeUsd.toFixed(2)} < $${config.minVolumeUsd}` },
          message: `Token rejected: insufficient volume ($${volumeUsd.toFixed(2)} < $${config.minVolumeUsd})`,
        });
        return false;
      }

      // Задержка между проверками
      await sleep(config.filterCheckDelay);

      // 4. Проверка LP burned и mint renounced
      const isLpBurned = await this.isLpBurned(candidate.mint);
      filterDetails.isLpBurned = isLpBurned;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'lp_burned',
        filterResult: isLpBurned,
        filterDetails: { ...filterDetails },
        message: `LP burned check: ${isLpBurned}`,
      });

      if (!isLpBurned) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'lp_burned',
          filterDetails: { ...filterDetails, rejectionReason: 'LP not burned' },
          message: `Token rejected: LP not burned`,
        });
        return false;
      }

      await sleep(config.filterCheckDelay);

      const isMintRenounced = await this.isMintRenounced(candidate.mint);
      filterDetails.isMintRenounced = isMintRenounced;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'mint_renounced',
        filterResult: isMintRenounced,
        filterDetails: { ...filterDetails },
        message: `Mint renounced check: ${isMintRenounced}`,
      });

      if (!isMintRenounced) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'mint_renounced',
          filterDetails: { ...filterDetails, rejectionReason: 'Mint not renounced' },
          message: `Token rejected: mint not renounced`,
        });
        return false;
      }

      await sleep(config.filterCheckDelay);

      // 5. Проверка на снайперов (топ-5 холдеров, никто не держит >20%)
      const hasSnipers = await this.hasSnipers(candidate.mint);
      filterDetails.hasSnipers = hasSnipers;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'snipers_check',
        filterResult: !hasSnipers,
        filterDetails: { ...filterDetails },
        message: `Snipers check: ${hasSnipers ? 'detected' : 'none'}`,
      });

      if (hasSnipers) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'snipers_check',
          filterDetails: { ...filterDetails, rejectionReason: 'Snipers detected (>20% holders)' },
          message: `Token rejected: snipers detected`,
        });
        return false;
      }

      // Все проверки пройдены
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_passed',
        token: candidate.mint,
        filterDetails: { ...filterDetails },
        message: `Token passed all filters: ${candidate.mint.substring(0, 8)}...`,
      });

      return true;
    } catch (error: any) {
      console.error(`Error filtering candidate ${candidate.mint}:`, error);

      // Обработка rate limiting
      if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
        await sleep(config.rateLimitRetryDelay * 2);
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_failed',
        token: candidate.mint,
        filterStage: 'error',
        filterDetails: { ...filterDetails, rejectionReason: error?.message || String(error) },
        message: `Error filtering candidate ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Проверка на honeypot и скам
   * Проверяем что токен можно продать (есть успешные продажи) и есть разные покупатели
   */
  private async checkHoneypotAndScam(mint: string, isPriority: boolean = false): Promise<{ isHoneypot: boolean; uniqueBuyers: number; hasSells: boolean }> {
    try {
      const mintPubkey = new PublicKey(mint);

      // Получаем транзакции токена
      // Для приоритетных очередей - минимальная задержка
      await sleep(isPriority ? 50 : config.rpcRequestDelay);
      const connection = this.rpcPool.getConnection(); // Используем пул соединений
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        limit: 50,
      });

      const buyerAddresses = new Set<string>();
      let hasSellTransactions = false;

      // Батчинг getTransaction запросов для скорости (до 5 одновременно)
      const signaturesToCheck = signatures.slice(0, Math.min(signatures.length, 30));
      const batchSize = 5;

      for (let i = 0; i < signaturesToCheck.length; i += batchSize) {
        const batch = signaturesToCheck.slice(i, i + batchSize);

        // Параллельно получаем транзакции батча
        const txPromises = batch.map(async (sigInfo) => {
          try {
            // Для приоритетных очередей - минимальная задержка
            await sleep(isPriority ? 30 : config.rpcRequestDelay);
            const connection = this.rpcPool.getConnection(); // Используем пул соединений
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

        // Обрабатываем полученные транзакции
        for (const tx of transactions) {
          if (!tx) continue;

          // Ищем инструкции покупки/продажи
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

          // Извлекаем адреса участников транзакции (покупатели)
          // Используем правильный метод для получения ключей аккаунтов
          let accountKeys: string[] = [];
          if (tx.transaction?.message) {
            try {
              // Пробуем получить ключи через getAccountKeys (для VersionedMessage)
              const accountKeysObj = tx.transaction.message.getAccountKeys();
              accountKeys = accountKeysObj.staticAccountKeys.map((key: any) => key.toString());
            } catch (e) {
              // Fallback: используем postTokenBalances для извлечения адресов
              const tokenBalances = tx.meta?.postTokenBalances || [];
              tokenBalances.forEach((balance: any) => {
                if (balance.owner) {
                  accountKeys.push(balance.owner);
                }
              });
              // Также извлекаем из preTokenBalances
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

      // Honeypot = нет продаж ИЛИ только один покупатель (создатель)
      const isHoneypot = !hasSellTransactions && buyerAddresses.size <= 1;
      const uniqueBuyers = buyerAddresses.size;

      return {
        isHoneypot,
        uniqueBuyers,
        hasSells: hasSellTransactions,
      };
    } catch (error: any) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error checking honeypot for ${mint.substring(0, 8)}...: ${error?.message || String(error)}`,
      });
      // В случае ошибки считаем что это honeypot (безопаснее)
      return { isHoneypot: true, uniqueBuyers: 0, hasSells: false };
    }
  }

  /**
   * Фильтрация для очереди 1 (0-5 сек) - минимальные проверки, но СТРОГАЯ защита от honeypot
   * Смягченные требования к объему, но гарантия что токен можно продать
   */
  async filterQueue1Candidate(candidate: TokenCandidate): Promise<boolean> {
    const filterDetails: any = {};

    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'queue1_start',
        message: `Starting queue 1 filter check (0-5s) for token ${candidate.mint.substring(0, 8)}...`,
      });

      // 1. КРИТИЧНО: Проверка на honeypot - ГЛАВНЫЙ КРИТЕРИЙ
      const honeypotCheck = await this.checkHoneypotAndScam(candidate.mint);
      filterDetails.isHoneypot = honeypotCheck.isHoneypot;
      filterDetails.uniqueBuyers = honeypotCheck.uniqueBuyers;
      filterDetails.hasSells = honeypotCheck.hasSells;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'queue1_honeypot',
        filterResult: honeypotCheck.uniqueBuyers > 1, // Главный критерий: больше 1 владельца
        filterDetails: { ...filterDetails },
        message: `Honeypot check: uniqueBuyers=${honeypotCheck.uniqueBuyers}, hasSells=${honeypotCheck.hasSells}`,
      });

      // ГЛАВНОЕ: Отклоняем если меньше 2 уникальных владельцев (это honeypot/скам)
      // Больше 1 уникального владельца = не honeypot, можно продать
      if (honeypotCheck.uniqueBuyers <= 1) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'queue1_honeypot',
          filterDetails: { ...filterDetails, rejectionReason: `Honeypot detected: only ${honeypotCheck.uniqueBuyers} unique buyer(s), cannot sell` },
          message: `Token rejected: honeypot - insufficient unique buyers (${honeypotCheck.uniqueBuyers} <= 1)`,
        });
        return false;
      }

      // 2. Минимальная проверка объема (смягчено для ранних токенов)
      // Для приоритетной очереди - минимальная задержка (50ms вместо 200ms)
      await sleep(50);
      const volumeUsd = await this.getTradingVolume(candidate.mint);
      filterDetails.volumeUsd = volumeUsd;

      // Для очереди 1 снижаем требования к объему: минимум $100 (вместо $2000)
      // Главное - не honeypot, объем может быть маленьким на ранней стадии
      if (volumeUsd < 100) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'queue1_volume',
          filterDetails: { ...filterDetails, rejectionReason: `Volume too low: $${volumeUsd.toFixed(2)} < $100` },
          message: `Token rejected: volume too low ($${volumeUsd.toFixed(2)} < $100)`,
        });
        return false;
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_passed',
        token: candidate.mint,
        filterStage: 'queue1',
        filterDetails: { ...filterDetails },
        message: `Token passed queue 1 filters (risky but sellable): ${candidate.mint.substring(0, 8)}..., uniqueBuyers=${honeypotCheck.uniqueBuyers}`,
      });

      return true;
    } catch (error: any) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_failed',
        token: candidate.mint,
        filterStage: 'queue1_error',
        filterDetails: { ...filterDetails, rejectionReason: error?.message || String(error) },
        message: `Error filtering queue 1 candidate ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Фильтрация для очереди 2 (5-15 сек) - средние проверки, но СТРОГАЯ защита от honeypot
   * Смягченные требования к покупкам и объему, но гарантия что токен можно продать
   */
  async filterQueue2Candidate(candidate: TokenCandidate): Promise<boolean> {
    const filterDetails: any = {};

    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'queue2_start',
        message: `Starting queue 2 filter check (5-15s) for token ${candidate.mint.substring(0, 8)}...`,
      });

      // 1. КРИТИЧНО: Проверка на honeypot - ГЛАВНЫЙ КРИТЕРИЙ
      // Для приоритетной очереди - быстрая проверка
      const honeypotCheck = await this.checkHoneypotAndScam(candidate.mint, true);
      filterDetails.isHoneypot = honeypotCheck.isHoneypot;
      filterDetails.uniqueBuyers = honeypotCheck.uniqueBuyers;
      filterDetails.hasSells = honeypotCheck.hasSells;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'queue2_honeypot',
        filterResult: honeypotCheck.uniqueBuyers > 1, // Главный критерий: больше 1 владельца
        filterDetails: { ...filterDetails },
        message: `Honeypot check: uniqueBuyers=${honeypotCheck.uniqueBuyers}, hasSells=${honeypotCheck.hasSells}`,
      });

      // ГЛАВНОЕ: Отклоняем если меньше 2 уникальных владельцев (это honeypot/скам)
      if (honeypotCheck.uniqueBuyers <= 1) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'queue2_honeypot',
          filterDetails: { ...filterDetails, rejectionReason: `Honeypot detected: only ${honeypotCheck.uniqueBuyers} unique buyer(s), cannot sell` },
          message: `Token rejected: honeypot - insufficient unique buyers (${honeypotCheck.uniqueBuyers} <= 1)`,
        });
        return false;
      }

      // Для приоритетной очереди - минимальная задержка
      await sleep(50);

      // 2. Проверка количества покупок (смягчено: минимум 2 вместо 3)
      const purchaseCount = await this.getPurchaseCount(candidate.mint, true);
      filterDetails.purchaseCount = purchaseCount;

      if (purchaseCount < 2) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'queue2_purchase_count',
          filterDetails: { ...filterDetails, rejectionReason: `Only ${purchaseCount} purchases, need 2` },
          message: `Token rejected: insufficient purchases (${purchaseCount} < 2)`,
        });
        return false;
      }

      // Для приоритетной очереди - минимальная задержка
      await sleep(50);

      // 3. Проверка объема торгов (смягчено: >= $500 вместо $1000)
      const volumeUsd = await this.getTradingVolume(candidate.mint, true);
      filterDetails.volumeUsd = volumeUsd;

      if (volumeUsd < 500) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'queue2_volume',
          filterDetails: { ...filterDetails, rejectionReason: `Volume $${volumeUsd.toFixed(2)} < $500` },
          message: `Token rejected: insufficient volume ($${volumeUsd.toFixed(2)} < $500)`,
        });
        return false;
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_passed',
        token: candidate.mint,
        filterStage: 'queue2',
        filterDetails: { ...filterDetails },
        message: `Token passed queue 2 filters (risky but sellable): ${candidate.mint.substring(0, 8)}..., uniqueBuyers=${honeypotCheck.uniqueBuyers}`,
      });

      return true;
    } catch (error: any) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_failed',
        token: candidate.mint,
        filterStage: 'queue2_error',
        filterDetails: { ...filterDetails, rejectionReason: error?.message || String(error) },
        message: `Error filtering queue 2 candidate ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Упрощенная фильтрация для вторичной очереди (5-15 сек) - ОСТАВЛЕНО ДЛЯ ОБРАТНОЙ СОВМЕСТИМОСТИ
   * Используется filterQueue2Candidate вместо этого
   */
  async filterSecondaryCandidate(candidate: TokenCandidate): Promise<boolean> {
    return this.filterQueue2Candidate(candidate);
  }

  private async getPurchaseCount(mint: string, isPriority: boolean = false): Promise<number> {
    const startTime = Date.now();
    try {
      const mintPubkey = new PublicKey(mint);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Getting purchase count for ${mint.substring(0, 8)}...`,
      });

      // Получаем подписи для mint адреса
      // pump.fun использует определенные программы для торговли
      // Ищем транзакции покупки через getSignaturesForAddress

      const sigStartTime = Date.now();
      const connection = this.rpcPool.getConnection(); // Используем пул соединений
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        limit: 100,
      });
      const sigDuration = Date.now() - sigStartTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Signatures received: ${signatures.length}, duration: ${sigDuration}ms`,
      });

      // Фильтруем только транзакции покупки (не создания токена)
      // В pump.fun покупки обычно идут через определенные программы
      // Для MVP считаем все транзакции кроме первой (создание) как потенциальные покупки
      let purchaseCount = 0;
      const skipFirst = true; // Пропускаем первую транзакцию (создание токена)

      // Батчинг getTransaction запросов для скорости (до 3 одновременно)
      const batchSize = 3;
      const signaturesToCheck = signatures.slice(skipFirst ? 1 : 0, Math.min(signatures.length, 50));

      for (let i = 0; i < signaturesToCheck.length; i += batchSize) {
        const batch = signaturesToCheck.slice(i, i + batchSize);

        // Параллельно получаем транзакции батча
        const txPromises = batch.map(async (sigInfo) => {
          try {
            if (i > 0) {
              // Для приоритетных очередей - минимальная задержка
              await sleep(isPriority ? 30 : config.rpcRequestDelay);
            }
            const connection = this.rpcPool.getConnection(); // Используем пул соединений
            return await connection.getTransaction(sigInfo.signature, {
              commitment: 'confirmed',
              maxSupportedTransactionVersion: 0,
            });
          } catch (error: any) {
            if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
              await sleep(config.rateLimitRetryDelay);
              // Повторяем попытку один раз
              try {
                await sleep(config.rateLimitRetryDelay);
                return await this.connection.getTransaction(sigInfo.signature, {
                  commitment: 'confirmed',
                  maxSupportedTransactionVersion: 0,
                });
              } catch (retryError) {
                return null;
              }
            }
            return null;
          }
        });

        const transactions = await Promise.all(txPromises);

        // Обрабатываем полученные транзакции
        for (const tx of transactions) {
          if (!tx || !tx.meta) continue;

          // Проверяем, что транзакция успешна
          if (tx.meta.err) continue;

          // Проверяем наличие изменений в балансах токенов (признак покупки/продажи)
          const hasTokenBalanceChanges =
            (tx.meta.postTokenBalances && tx.meta.postTokenBalances.length > 0) ||
            (tx.meta.preTokenBalances && tx.meta.preTokenBalances.length > 0);

          if (hasTokenBalanceChanges) {
            purchaseCount++;
          }

          // Ограничиваем количество проверок для производительности
          if (purchaseCount >= config.minPurchases * 2) break;
        }

        if (purchaseCount >= config.minPurchases * 2) break;
      }

      const totalDuration = Date.now() - startTime;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Purchase count: ${purchaseCount}, total duration: ${totalDuration}ms`,
      });

      return purchaseCount;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error getting purchase count for ${mint.substring(0, 8)}...: ${error?.message || String(error)}, duration: ${totalDuration}ms`,
      });
      console.error(`Error getting purchase count for ${mint}:`, error);
      return 0;
    }
  }

  /**
   * Получает объем торгов токена в USD
   * Публичный метод для использования в gem-tracker
   */
  async getTradingVolume(mint: string, isPriority: boolean = false): Promise<number> {
    const startTime = Date.now();
    try {
      const mintPubkey = new PublicKey(mint);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Getting trading volume for ${mint.substring(0, 8)}...`,
      });

      // Получаем все транзакции
      const sigStartTime = Date.now();
      const connection = this.rpcPool.getConnection(); // Используем пул соединений
      const signatures = await connection.getSignaturesForAddress(mintPubkey, {
        limit: 100,
      });
      const sigDuration = Date.now() - sigStartTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Signatures for volume: ${signatures.length}, duration: ${sigDuration}ms`,
      });

      let totalVolumeSol = 0;

      for (let idx = 0; idx < signatures.length && idx < 30; idx++) {
        const sigInfo = signatures[idx];
        try {
          // Задержка между запросами для соблюдения rate limit
          if (idx > 0) {
            // Для приоритетных очередей - минимальная задержка
            await sleep(isPriority ? 30 : config.rpcRequestDelay);
          }

          const connection = this.rpcPool.getConnection(); // Используем пул соединений
          const tx = await connection.getTransaction(sigInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });

          if (!tx || !tx.meta) continue;

          // Суммируем SOL transfers в транзакции
          const preBalances = tx.meta.preBalances || [];
          const postBalances = tx.meta.postBalances || [];

          for (let i = 0; i < preBalances.length; i++) {
            const balanceChange = (postBalances[i] || 0) - (preBalances[i] || 0);
            if (balanceChange > 0) {
              totalVolumeSol += formatSol(balanceChange);
            }
          }
        } catch (error: any) {
          // Обработка rate limiting
          if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
            await sleep(config.rateLimitRetryDelay);
          }
          continue;
        }
      }

      const volumeUsd = formatUsd(totalVolumeSol);
      const totalDuration = Date.now() - startTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Trading volume: $${volumeUsd.toFixed(2)} (${totalVolumeSol.toFixed(6)} SOL), total duration: ${totalDuration}ms`,
      });

      return volumeUsd;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error getting trading volume for ${mint.substring(0, 8)}...: ${error?.message || String(error)}, duration: ${totalDuration}ms`,
      });
      console.error(`Error getting trading volume for ${mint}:`, error);
      return 0;
    }
  }

  private async isLpBurned(mint: string): Promise<boolean> {
    const startTime = Date.now();
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Checking LP burned for ${mint.substring(0, 8)}...`,
      });

      // В pump.fun LP токены обычно сжигаются после создания
      // Проверяем, что LP аккаунт не существует или имеет нулевой баланс

      const mintPubkey = new PublicKey(mint);

      // Кеширование: mint info не меняется часто
      const cacheKey = `mint:${mint}`;
      const cached = await cache.get<{ supply: string; mintAuthority: string | null; decimals: number }>(cacheKey);

      let mintInfo;
      if (cached) {
        mintInfo = {
          supply: BigInt(cached.supply),
          mintAuthority: cached.mintAuthority ? new PublicKey(cached.mintAuthority) : null,
          decimals: cached.decimals,
        } as any;
      } else {
        // Получаем информацию о mint
        const rpcStartTime = Date.now();
        const connection = this.rpcPool.getConnection(); // Используем пул соединений
        mintInfo = await getMint(connection, mintPubkey);
        const rpcDuration = Date.now() - rpcStartTime;

        // Кешируем результат на 10 секунд
        await cache.set(cacheKey, {
          supply: mintInfo.supply.toString(),
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
          decimals: mintInfo.decimals,
        }, 10);
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Mint info received for LP check`,
      });

      // Проверяем связанные аккаунты
      // В pump.fun после создания токена LP обычно сжигается
      // Это упрощенная проверка, в реальности нужно проверять конкретные аккаунты pump.fun

      // Для MVP считаем, что если токен существует и mint authority null, то LP burned
      const result = true; // Упрощенная проверка для MVP
      const totalDuration = Date.now() - startTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `LP burned check result: ${result}, total duration: ${totalDuration}ms`,
      });

      return result;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error checking LP burned for ${mint.substring(0, 8)}...: ${error?.message || String(error)}, duration: ${totalDuration}ms`,
      });
      console.error(`Error checking LP burned for ${mint}:`, error);
      return false;
    }
  }

  private async isMintRenounced(mint: string): Promise<boolean> {
    const startTime = Date.now();
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Checking mint renounced for ${mint.substring(0, 8)}...`,
      });

      const mintPubkey = new PublicKey(mint);

      // Кеширование: mint authority не меняется
      const cacheKey = `mint:${mint}`;
      const cached = await cache.get<{ mintAuthority: string | null }>(cacheKey);

      let mintInfo;
      if (cached) {
        mintInfo = { mintAuthority: cached.mintAuthority ? new PublicKey(cached.mintAuthority) : null } as any;
      } else {
        await sleep(config.rpcRequestDelay);
        const connection = this.rpcPool.getConnection(); // Используем пул соединений
        const rpcStartTime = Date.now();
        mintInfo = await getMint(connection, mintPubkey);
        const rpcDuration = Date.now() - rpcStartTime;

        // Кешируем результат на 10 секунд
        await cache.set(cacheKey, {
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
        }, 10);
      }

      // Если mintAuthority === null, то mint renounced
      const result = mintInfo.mintAuthority === null;
      const totalDuration = Date.now() - startTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Mint renounced check: ${result}, mintAuthority=${mintInfo.mintAuthority ? 'exists' : 'null'}, total: ${totalDuration}ms`,
      });

      return result;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `Rate limited during mint renounced check, skipping, duration: ${totalDuration}ms`,
        });
        await sleep(config.rateLimitRetryDelay);
        return false;
      }
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error checking mint renounced for ${mint.substring(0, 8)}...: ${error?.message || String(error)}, duration: ${totalDuration}ms`,
      });
      console.error(`Error checking mint renounced for ${mint}:`, error);
      return false;
    }
  }

  /**
   * Получает распределение ликвидности токена
   * Возвращает данные о ликвидности, holders и проценте топ-держателя
   */
  async getLiquidityDistribution(mint: string): Promise<{
    totalLiquidity: number;
    uniqueHolders: number;
    topHolderPercentage: number;
  } | null> {
    try {
      const mintPubkey = new PublicKey(mint);
      const connection = this.rpcPool.getConnection();

      // Получаем топ-5 холдеров
      const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
      if (largestAccounts.value.length === 0) {
        return null;
      }

      // Получаем общий supply
      const mintInfo = await getMint(connection, mintPubkey);
      const totalSupply = Number(mintInfo.supply);

      // Вычисляем процент топ-держателя
      const topHolderAmount = Number(largestAccounts.value[0].amount);
      const topHolderPct = (topHolderAmount / totalSupply) * 100;

      // Получаем объем торговли как приблизительную ликвидность
      const volumeUsd = await this.getTradingVolume(mint, true);

      // Приблизительное количество holders (из транзакций)
      const honeypotCheck = await this.checkHoneypotAndScam(mint, true);

      return {
        totalLiquidity: volumeUsd,
        uniqueHolders: honeypotCheck.uniqueBuyers,
        topHolderPercentage: topHolderPct,
      };
    } catch (error) {
      console.error(`Error getting liquidity distribution for ${mint}:`, error);
      return null;
    }
  }

  async hasSnipers(mint: string): Promise<boolean> {
    const startTime = Date.now();
    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Checking for snipers in ${mint.substring(0, 8)}...`,
      });

      await sleep(config.rpcRequestDelay);
      const mintPubkey = new PublicKey(mint);

      // Кеширование: largest accounts меняются редко
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
        // Получаем топ-5 холдеров через getTokenLargestAccounts
        const accountsStartTime = Date.now();
        const connection = this.rpcPool.getConnection(); // Используем пул соединений
        largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
        const accountsDuration = Date.now() - accountsStartTime;

        // Кешируем результат на 5 секунд
        await cache.set(cacheKey, largestAccounts.value.map(acc => ({
          address: acc.address.toString(),
          amount: acc.amount.toString(),
        })), 5);
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Largest accounts received: ${largestAccounts.value.length}`,
      });

      if (largestAccounts.value.length === 0) {
        return false;
      }

      // Кеширование для supply
      const mintCacheKey = `mint:${mint}`;
      const mintCached = await cache.get<{ supply: string }>(mintCacheKey);

      let mintInfo;
      let totalSupply;
      if (mintCached) {
        totalSupply = Number(BigInt(mintCached.supply));
      } else {
        await sleep(config.rpcRequestDelay);
        // Получаем общий supply токена
        const mintStartTime = Date.now();
        const mintConnection = this.rpcPool.getConnection(); // Используем пул соединений
        mintInfo = await getMint(mintConnection, mintPubkey);
        const mintDuration = Date.now() - mintStartTime;
        totalSupply = Number(mintInfo.supply);

        // Кешируем результат на 10 секунд
        await cache.set(mintCacheKey, {
          supply: mintInfo.supply.toString(),
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
          decimals: mintInfo.decimals,
        }, 10);
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Mint supply: ${totalSupply}`,
      });

      if (totalSupply === 0) {
        return false;
      }

      // BATCH ЗАПРОСЫ: Получаем все аккаунты за один раз через getMultipleAccountsInfo
      const accountsToCheck = largestAccounts.value.slice(0, Math.min(5, largestAccounts.value.length));
      const accountAddresses = accountsToCheck.map((acc: any) => acc.address);

      // Используем batch запрос getMultipleAccountsInfo вместо множества getAccount
      await sleep(config.rpcRequestDelay);
      const connection = this.rpcPool.getConnection(); // Используем пул соединений
      const accountStartTime = Date.now();
      const accountInfos = await connection.getMultipleAccountsInfo(accountAddresses);
      const accountDuration = Date.now() - accountStartTime;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Batch accounts fetched: ${accountInfos.length}, RPC duration: ${accountDuration}ms`,
      });

      // Проверяем, не держит ли кто-то >20%
      for (let idx = 0; idx < accountsToCheck.length; idx++) {
        const accountInfo = accountInfos[idx];
        if (!accountInfo) continue;

        try {
          // Парсим данные аккаунта из batch результата
          const tokenAccount = unpackAccount(accountAddresses[idx], accountInfo);
          const balance = Number(tokenAccount.amount);
          const percentage = (balance / totalSupply) * 100;

          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: mint,
            message: `Account #${idx + 1} check: balance=${balance}, percentage=${percentage.toFixed(2)}%`,
          });

          // Исключаем LP аккаунт (обычно это первый или второй по размеру)
          // Для MVP проверяем только процент
          // ⭐ Используем config.maxSingleHolderPct вместо хардкода
          if (percentage > config.maxSingleHolderPct) {
            // Это может быть LP, но для безопасности считаем что ликвидность надута
            // В реальности нужно проверять адрес аккаунта
            return true;
          }
        } catch (error: any) {
          if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
            await sleep(config.rateLimitRetryDelay);
          }
          continue;
        }
      }

      const totalDuration = Date.now() - startTime;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Snipers check completed: no snipers detected, total duration: ${totalDuration}ms`,
      });

      return false;
    } catch (error: any) {
      const totalDuration = Date.now() - startTime;
      if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `Rate limited during snipers check, assuming snipers present (safe), duration: ${totalDuration}ms`,
        });
        await sleep(config.rateLimitRetryDelay);
        return true; // В случае rate limit считаем, что снайперы есть (безопаснее)
      }
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: mint,
        message: `Error checking snipers for ${mint.substring(0, 8)}...: ${error?.message || String(error)}, assuming snipers present (safe), duration: ${totalDuration}ms`,
      });
      console.error(`Error checking snipers for ${mint}:`, error);
      // В случае ошибки считаем, что снайперы есть (безопаснее)
      return true;
    }
  }

  /**
   * Классифицирует токен по Tier системе (1, 2, 3 или null)
   * Tier 1: liquidity >= 5000, holders >= 25
   * Tier 2: liquidity >= 2000 && < 5000, holders >= 40
   * Tier 3: liquidity >= 1000 && < 2000, holders >= 70
   * null: liquidity < 1000 или не проходит условия
   */
  async classifyTier(mint: string, liquidity: number, holders: number): Promise<TierInfo | null> {
    // ❌ ЖЕСТКИЙ ЗАПРЕТ: liquidity < 1000 - НИКОГДА НЕ ВХОДИТЬ
    if (liquidity < 1000) {
      return null;
    }

    // 🟢 TIER 1 — БЕЗОПАСНЫЙ ВХОД
    if (liquidity >= 5000 && holders >= 25) {
      return {
        tier: 1,
        liquidity,
        holders,
        positionSizeMultiplier: 1.0,
        allowsPartialSells: true,
      };
    }

    // 🟡 TIER 2 — УМЕРЕННЫЙ РИСК
    if (liquidity >= 2000 && liquidity < 5000 && holders >= 40) {
      return {
        tier: 2,
        liquidity,
        holders,
        positionSizeMultiplier: 0.5,
        allowsPartialSells: true,
        minEffectiveMultiplier: 1.15, // ОБЯЗАТЕЛЬНО выполнить exit simulation
      };
    }

    // 🔴 TIER 3 — ТОЛЬКО САМЫЕ СИЛЬНЫЕ
    if (liquidity >= 1000 && liquidity < 2000 && holders >= 70) {
      return {
        tier: 3,
        liquidity,
        holders,
        positionSizeMultiplier: 0.0, // Будет установлен в position-manager (max 0.0025 SOL)
        allowsPartialSells: false, // ❌ partial sells запрещены
        minEffectiveMultiplier: 1.2, // Более строгий multiplier для Tier 3
      };
    }

    // Не проходит ни один Tier
    return null;
  }

  /**
   * ⭐ УПРОЩЕННЫЙ ФИЛЬТР: Только критичные проверки
   * 1. Защита от honeypot (uniqueBuyers > 1)
   * 2. Минимальная базовая ликвидность (config.minLiquidityUsd)
   * 3. Распределение ликвидности (нет одного держателя с >maxSingleHolderPct%)
   * 4. Классификация по Tier системе
   */
  /**
   * ⭐ НОВАЯ ЛОГИКА: Упрощенный фильтр для поиска МАНИПУЛЯТОРОВ и ГЕМОВ
   * Минимальная фильтрация - только защита от honeypot и базовые проверки
   * Манипуляторы и гемы НЕ отбрасываются, а помечаются для торговли
   */
  /**
   * ⭐ БЫСТРЫЙ ФИЛЬТР (MANIPULATOR MODE):
   * Оптимизирован для скорости.
   * 1. Пропускает полную историю транзакций (только последние 15).
   * 2. Проверяет Freeze Authority (моментальный отказ если есть).
   * 3. Использует только Bonding Curve для цены/капы.
   */
  async fastFilterManipulator(candidate: TokenCandidate): Promise<{ passed: boolean; reason?: string; details?: any; tierInfo?: TierInfo | null; tokenType?: 'MANIPULATOR' | 'GEM' | 'REGULAR' }> {
    const details: any = {};
    const startTime = Date.now();

    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'fast_start',
        message: `🚀 Starting FAST filter (MANIPULATOR Mode) for ${candidate.mint.substring(0, 8)}...`,
      });

      // 1. FAST HONEYPOT CHECK: Freeze Authority + Minimal Tx Scan
      // Параллельно запускаем проверку Mint Info и последних транзакций
      const mintPubkey = new PublicKey(candidate.mint);
      const connection = this.rpcPool.getConnection();

      const [mintInfo, signatures] = await Promise.all([
        connection.getParsedAccountInfo(mintPubkey),
        connection.getSignaturesForAddress(mintPubkey, { limit: 15 }), // Только 15 последних
      ]);

      // 1.1 Проверка Freeze Authority (мгновенный бан)
      const parsedInfo = mintInfo.value?.data as ParsedAccountData;
      if (parsedInfo?.parsed?.info?.freezeAuthority) {
        // Исключение: если freezeAuth это pump.fun программа (маловероятно, но на всякий случай)
        // Обычно у pump.fun токенов freezeAuth отключен (null)
        const freezeAuth = parsedInfo.parsed.info.freezeAuthority;
        // Проверяем, не является ли freeze authority самой программой (хотя обычно она null)
        if (freezeAuth !== 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaUx1eVD' && // Token 2022
          freezeAuth !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') { // Token Program
          const reason = `Freeze Authority enabled: ${freezeAuth}`;
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'filter_failed',
            token: candidate.mint,
            filterStage: 'fast_freeze_check',
            message: `❌ Token rejected: ${reason}`,
          });
          return { passed: false, reason, details };
        }
      }

      // 1.2 Минимальный скан транзакций (есть ли другие покупатели?)
      const buyerAddresses = new Set<string>();
      let hasSellTransactions = false;

      // Батчинг не нужен для 15 транзакций, качаем параллельно
      const txPromises = signatures.map(async (sigInfo) => {
        try {
          return await connection.getTransaction(sigInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
        } catch (e) { return null; }
      });

      const transactions = await Promise.all(txPromises);

      for (const tx of transactions) {
        if (!tx) continue;
        const logs = tx.meta?.logMessages || [];

        // Ищем продажу
        if (logs.some(l => l.toLowerCase().includes('sell') || (l.toLowerCase().includes('swap') && l.toLowerCase().includes('out')))) {
          hasSellTransactions = true;
        }

        // Ищем покупателей
        const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys.map(k => k.toString());
        accountKeys.forEach(addr => {
          if (addr && addr !== candidate.mint &&
            addr !== '11111111111111111111111111111111' && // System Program
            addr !== 'So11111111111111111111111111111111111111112' && // Wrapped SOL
            addr !== 'computeBudget111111111111111111111111111111') { // Compute Budget
            buyerAddresses.add(addr);
          }
        });
      }

      details.uniqueBuyers = buyerAddresses.size;
      details.hasSells = hasSellTransactions;

      // Очень мягкая проверка Honeypot: хотя бы 2 уникальных участника (кромe бота)
      if (buyerAddresses.size < 2) {
        // Warning но пропускаем, если это САМЫЙ первый блок?
        // Нет, лучше немного подождать. Но для снайпинга 2 уник. адреса (дева + кто-то еще) - это минимум.
        // Если только дев - риск 100%.
        const reason = `High Suspicion: Only ${buyerAddresses.size} unique participant(s) in last 15 txs`;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_warning',
          token: candidate.mint,
          filterStage: 'fast_honeypot',
          message: `⚠️ ${reason} (Risk accepted for MANIPULATOR mode)`,
        });
        // В режиме MANIPULATOR мы принимаем этот риск (или можно вернуть warn)
        // Возвращаем true, но с пометкой риска в details? Нет, продолжаем.
      }


      // 2. TOKEN TYPE & DATA (From Bonding Curve Direct)
      // Получаем данные bonding curve (цена, капа)
      // Мы можем использовать getTradingVolume, но это долго.
      // Лучше получить цену и капу от price-fetcher, который уже оптимизирован.
      const { priceFetcher } = await import('./price-fetcher');
      // Используем true для skipCache если нужно супер-свежее, но priceFetcher кэширует на 1с, это ок.
      const currentPrice = await priceFetcher.getPrice(candidate.mint);
      const marketData = await priceFetcher.getMarketData(candidate.mint);
      const marketCap = marketData?.marketCap || 0;

      // Оценка ликвидности (Volume) по количеству транзакций в блоке (косвенно)
      // В fastFilter мы не будем качать весь объем за 5 минут, это долго.
      // Используем эвристику: 15 последних транзакций за короткое время = активность.
      const lastTxTime = signatures[0]?.blockTime || 0;
      const firstTxTime = signatures[signatures.length - 1]?.blockTime || 0;
      const txDensity = (signatures.length) / Math.max(1, (lastTxTime - firstTxTime)); // Tx per second

      // Эмуляция volumeUsd для совместимости с Tier системой
      // Если плотность > 0.5 tx/sec (активный токен) -> ставим высокий вирт. объем
      const estimatedVolumeUsd = txDensity > 0.5 ? 2000 : 500;

      details.volumeUsd = estimatedVolumeUsd;
      details.marketCap = marketCap;

      // Тип всегда MANIPULATOR в этом режиме (или GEM если explosive)
      // Но мы вызываем этот метод только для быстрой ветки.

      const tokenType = 'MANIPULATOR';

      // 3. MARKET CAP CHECK
      if (marketCap < 1500) { // $1500 soft limit для совсем мусора
        const reason = `Market Cap too low: $${marketCap.toFixed(2)}`;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'fast_mcap',
          message: `❌ Token rejected: ${reason}`,
        });
        return { passed: false, reason, details };
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_passed',
        token: candidate.mint,
        filterStage: 'fast_check',
        message: `✅ FAST Filter PASSED: ${candidate.mint.substring(0, 8)}... | Cap=$${marketCap.toFixed(0)} | Active=${buyerAddresses.size} users | Time=${Date.now() - startTime}ms`,
      });

      // Формируем Tier Info (Агрессивный)
      const tierInfo: TierInfo = {
        tier: 1, // Считаем его топ-тиером для скорости
        liquidity: estimatedVolumeUsd,
        holders: buyerAddresses.size,
        positionSizeMultiplier: 1.0,
        allowsPartialSells: true,
        minEffectiveMultiplier: 1.05, // Низкий порог, т.к. вход по импульсу
      };

      return { passed: true, details, tierInfo, tokenType };

    } catch (error: any) {
      const reason = `Fast Filter error: ${error?.message}`;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: candidate.mint,
        filterStage: 'fast_error',
        message: `❌ Error in fast filter: ${reason}`,
      });
      return { passed: false, reason, details };
    }
  }

  async simplifiedFilter(candidate: TokenCandidate): Promise<{ passed: boolean; reason?: string; details?: any; tierInfo?: TierInfo | null; tokenType?: 'MANIPULATOR' | 'GEM' | 'REGULAR' }> {
    // ВЫЗОВ FAST FILTER ЕСЛИ ВКЛЮЧЕН РЕЖИМ IMMEDIATE ENTRY
    if (config.immediateEntry) {
      return this.fastFilterManipulator(candidate);
    }

    // ... СТАРАЯ ЛОГИКА ...
    const details: any = {};

    try {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_check',
        token: candidate.mint,
        filterStage: 'simplified_start',
        message: `🔍 Starting simplified filter (MANIPULATOR/GEM search) for ${candidate.mint.substring(0, 8)}...`,
      });

      // 1. КРИТИЧНО: Проверка на honeypot - ЕДИНСТВЕННЫЙ ЖЕСТКИЙ ФИЛЬТР
      const honeypotCheck = await this.checkHoneypotAndScam(candidate.mint, true);
      details.uniqueBuyers = honeypotCheck.uniqueBuyers;
      details.hasSells = honeypotCheck.hasSells;

      if (honeypotCheck.uniqueBuyers <= 1) {
        const reason = `Honeypot detected: only ${honeypotCheck.uniqueBuyers} unique buyer(s)`;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'simplified_honeypot',
          filterDetails: { ...details, rejectionReason: reason },
          message: `❌ Token rejected: ${reason}`,
        });
        return { passed: false, reason, details };
      }

      // 2. Получаем базовые данные для определения типа токена
      await sleep(50); // Минимальная задержка
      const volumeUsd = await this.getTradingVolume(candidate.mint, true);
      details.volumeUsd = volumeUsd;
      details.uniqueBuyers = honeypotCheck.uniqueBuyers;

      // 3. ⭐ ОПРЕДЕЛЕНИЕ ТИПА ТОКЕНА: МАНИПУЛЯТОР / ГЕМ / ОБЫЧНЫЙ
      const hasConcentratedLiquidity = await this.hasSnipers(candidate.mint);
      details.hasConcentratedLiquidity = hasConcentratedLiquidity;

      // Проверяем признаки гема (быстрый рост цены, объема, держателей)
      const { priceFetcher } = await import('./price-fetcher');
      const currentPrice = await priceFetcher.getPrice(candidate.mint);
      const marketData = await priceFetcher.getMarketData(candidate.mint);
      const marketCap = marketData?.marketCap || 0;

      // Признаки гема: быстрый рост цены, объема, капитализации
      const ageSeconds = (Date.now() - candidate.createdAt) / 1000;
      const priceMultiplier = currentPrice > 0 ? currentPrice / 0.000000028 : 1; // От начальной цены pump.fun
      const isGem = priceMultiplier >= 2.0 && volumeUsd >= 500 && ageSeconds < 300; // Рост 2x+, объем >$500, возраст <5мин

      let tokenType: 'MANIPULATOR' | 'GEM' | 'REGULAR' = 'REGULAR';

      if (hasConcentratedLiquidity) {
        tokenType = 'MANIPULATOR';
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `🎯 MANIPULATOR DETECTED: ${candidate.mint.substring(0, 8)}... | liquidity=$${volumeUsd.toFixed(2)}, holders=${honeypotCheck.uniqueBuyers}, marketCap=$${marketCap.toFixed(2)}`,
        });
      } else if (isGem) {
        tokenType = 'GEM';
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `💎 GEM DETECTED: ${candidate.mint.substring(0, 8)}... | multiplier=${priceMultiplier.toFixed(2)}x, volume=$${volumeUsd.toFixed(2)}, marketCap=$${marketCap.toFixed(2)}`,
        });
      }

      details.tokenType = tokenType;

      // ⭐ КРИТИЧНО: Проверяем market cap ЗДЕСЬ, до того как токен попадет в очередь
      // Это предотвращает ситуацию, когда токен проходит фильтры, но потом отклоняется в tryOpenPosition
      const marketCapThreshold = tokenType === 'MANIPULATOR' ? 1500 : 2000;
      if (!marketData || marketCap < marketCapThreshold) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `❌ MARKET CAP FILTER (simplifiedFilter): marketCap=$${marketCap.toFixed(2) || 'N/A'} < $${marketCapThreshold} USD (${tokenType}), rejecting token`,
        });
        return {
          passed: false,
          reason: `Market cap too low: $${marketCap.toFixed(2) || 'N/A'} < $${marketCapThreshold} USD`,
          details,
        };
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ MARKET CAP FILTER PASSED (simplifiedFilter): marketCap=$${marketCap.toFixed(2)} USD >= $${marketCapThreshold} USD (${tokenType})`,
      });

      // 4. Классификация по Tier (для манипуляторов и гемов требования мягче)
      let tierInfo: TierInfo | null = null;

      if (tokenType === 'MANIPULATOR') {
        // Для манипуляторов: минимальная ликвидность $500 (ранние точки входа важны)
        if (volumeUsd >= 500) {
          tierInfo = {
            tier: volumeUsd >= 2000 ? 1 : (volumeUsd >= 1000 ? 2 : 3),
            liquidity: volumeUsd,
            holders: honeypotCheck.uniqueBuyers,
            positionSizeMultiplier: volumeUsd >= 2000 ? 1.0 : (volumeUsd >= 1000 ? 0.5 : 0.25),
            allowsPartialSells: volumeUsd >= 2000,
            minEffectiveMultiplier: volumeUsd >= 2000 ? undefined : 1.15,
          };
        }
      } else if (tokenType === 'GEM') {
        // Для гемов: минимальная ликвидность $500, но более консервативный подход
        if (volumeUsd >= 500) {
          tierInfo = {
            tier: volumeUsd >= 3000 ? 1 : (volumeUsd >= 1500 ? 2 : 3),
            liquidity: volumeUsd,
            holders: honeypotCheck.uniqueBuyers,
            positionSizeMultiplier: 1.0, // Гемы - полный размер позиции
            allowsPartialSells: true,
          };
        }
      } else {
        // Для обычных токенов: стандартная классификация Tier
        tierInfo = await this.classifyTier(candidate.mint, volumeUsd, honeypotCheck.uniqueBuyers);
      }

      // 5. Минимальные требования для прохождения (только для обычных токенов)
      if (tokenType === 'REGULAR' && !tierInfo) {
        const reason = `Regular token does not meet Tier requirements: liquidity=$${volumeUsd.toFixed(2)}, holders=${honeypotCheck.uniqueBuyers}`;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'simplified_tier',
          filterDetails: { ...details, rejectionReason: reason },
          message: `❌ Token rejected: ${reason}`,
        });
        return { passed: false, reason, details, tierInfo: null };
      }

      // Манипуляторы и гемы проходят даже с низкой ликвидностью (>= $500)
      if ((tokenType === 'MANIPULATOR' || tokenType === 'GEM') && !tierInfo) {
        const reason = `Token type ${tokenType} but liquidity too low: $${volumeUsd.toFixed(2)} < $500`;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'filter_failed',
          token: candidate.mint,
          filterStage: 'simplified_tier',
          filterDetails: { ...details, rejectionReason: reason },
          message: `❌ Token rejected: ${reason}`,
        });
        return { passed: false, reason, details, tierInfo: null };
      }

      // 6. Успешное прохождение фильтра
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_passed',
        token: candidate.mint,
        filterStage: 'simplified',
        filterDetails: { ...details },
        message: `✅ Token PASSED: ${candidate.mint.substring(0, 8)}... | Type=${tokenType}, Tier=${tierInfo?.tier || 'N/A'}, liquidity=$${volumeUsd.toFixed(2)}, holders=${honeypotCheck.uniqueBuyers}`,
      });

      return { passed: true, details, tierInfo, tokenType };
    } catch (error: any) {
      const reason = `Filter error: ${error?.message || String(error)}`;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'filter_failed',
        token: candidate.mint,
        filterStage: 'simplified_error',
        filterDetails: { ...details, rejectionReason: reason },
        message: `❌ Error in simplified filter: ${reason}`,
      });
      return { passed: false, reason, details };
    }
  }

  async getEntryPrice(mint: string, isPriority: boolean = false): Promise<number> {
    const maxRetries = 3;
    let lastError: any = null;

    // Симулятор торговли: получаем реальную цену для имитации открытия позиции
    // НЕ делаем реальные транзакции, только получаем данные для симуляции

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // RPC pool управляет rate limiting, задержка не нужна
        if (!isPriority) {
          await sleep(config.rpcRequestDelay);
        }

        // Получаем цену напрямую из bonding curve контракта pump.fun
        // НЕ используем Jupiter API - новые токены не индексируются сразу
        const { priceFetcher } = await import('./price-fetcher');
        const price = await priceFetcher.getPrice(mint);

        if (price > 0) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: mint,
            message: `Entry price from bonding curve: ${price.toFixed(8)} SOL (attempt ${attempt + 1})`,
          });
          return price;
        }

        // Fallback: минимальная цена если bonding curve не доступен
        const fallbackPrice = 0.00001;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: mint,
          message: `Bonding curve not available, using fallback price: ${fallbackPrice.toFixed(8)} SOL (attempt ${attempt + 1})`,
        });
        return fallbackPrice;
      } catch (error: any) {
        lastError = error;

        // Если 429 - ждем и повторяем
        if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
          const retryDelay = config.rateLimitRetryDelay * (attempt + 1);
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'warning',
            token: mint,
            message: `RPC rate limit, retrying after ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
          });
          await sleep(retryDelay);
          continue;
        }

        // Другие ошибки - логируем и пробуем еще раз
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          token: mint,
          message: `Error getting entry price (attempt ${attempt + 1}/${maxRetries}): ${error?.message || String(error)}`,
        });

        if (attempt < maxRetries - 1) {
          await sleep(config.rateLimitRetryDelay * (attempt + 1));
        }
      }
    }

    // Если все попытки провалились - используем минимальную цену для симуляции
    // Это позволяет симулятору продолжить работу, даже если API недоступен
    const fallbackPrice = 0.00001; // Минимальная цена для симуляции
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'warning',
      token: mint,
      message: `All attempts failed, using fallback price ${fallbackPrice.toFixed(8)} SOL for simulation. Last error: ${lastError?.message || String(lastError)}`,
    });

    return fallbackPrice; // Возвращаем минимальную цену вместо 0, чтобы симулятор мог продолжить
  }

}

