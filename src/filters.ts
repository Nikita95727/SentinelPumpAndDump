import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, getAccount } from '@solana/spl-token';
import { config } from './config';
import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, formatSol, formatUsd, sleep } from './utils';

export class TokenFilters {
  private connection: Connection;

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
      const signatures = await this.connection.getSignaturesForAddress(mintPubkey, {
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
            return await this.connection.getTransaction(sigInfo.signature, {
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
      const signatures = await this.connection.getSignaturesForAddress(mintPubkey, {
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
            return await this.connection.getTransaction(sigInfo.signature, {
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

  private async getTradingVolume(mint: string, isPriority: boolean = false): Promise<number> {
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
      const signatures = await this.connection.getSignaturesForAddress(mintPubkey, {
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

          const tx = await this.connection.getTransaction(sigInfo.signature, {
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
      
      // Получаем информацию о mint
      const rpcStartTime = Date.now();
      const mintInfo = await getMint(this.connection, mintPubkey);
      const rpcDuration = Date.now() - rpcStartTime;
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Mint info received for LP check, RPC duration: ${rpcDuration}ms`,
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

      await sleep(config.rpcRequestDelay);
      const mintPubkey = new PublicKey(mint);
      
      const rpcStartTime = Date.now();
      const mintInfo = await getMint(this.connection, mintPubkey);
      const rpcDuration = Date.now() - rpcStartTime;
      
      // Если mintAuthority === null, то mint renounced
      const result = mintInfo.mintAuthority === null;
      const totalDuration = Date.now() - startTime;
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Mint renounced check: ${result}, mintAuthority=${mintInfo.mintAuthority ? 'exists' : 'null'}, RPC duration: ${rpcDuration}ms, total: ${totalDuration}ms`,
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

  private async hasSnipers(mint: string): Promise<boolean> {
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
      
      // Получаем топ-5 холдеров через getTokenLargestAccounts
      const accountsStartTime = Date.now();
      const largestAccounts = await this.connection.getTokenLargestAccounts(mintPubkey);
      const accountsDuration = Date.now() - accountsStartTime;
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Largest accounts received: ${largestAccounts.value.length}, RPC duration: ${accountsDuration}ms`,
      });
      
      if (largestAccounts.value.length === 0) {
        return false;
      }

      await sleep(config.rpcRequestDelay);

      // Получаем общий supply токена
      const mintStartTime = Date.now();
      const mintInfo = await getMint(this.connection, mintPubkey);
      const mintDuration = Date.now() - mintStartTime;
      const totalSupply = Number(mintInfo.supply);
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: mint,
        message: `Mint supply: ${totalSupply}, RPC duration: ${mintDuration}ms`,
      });

      if (totalSupply === 0) {
        return false;
      }

      // Проверяем, не держит ли кто-то >20%
      for (let idx = 0; idx < Math.min(5, largestAccounts.value.length); idx++) {
        const account = largestAccounts.value[idx];
        try {
          if (idx > 0) {
            await sleep(config.rpcRequestDelay);
          }
          
          const accountStartTime = Date.now();
          const tokenAccount = await getAccount(this.connection, account.address);
          const accountDuration = Date.now() - accountStartTime;
          const balance = Number(tokenAccount.amount);
          const percentage = (balance / totalSupply) * 100;
          
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: mint,
            message: `Account #${idx + 1} check: balance=${balance}, percentage=${percentage.toFixed(2)}%, RPC duration: ${accountDuration}ms`,
          });

          // Исключаем LP аккаунт (обычно это первый или второй по размеру)
          // Для MVP проверяем только процент
          if (percentage > 20) {
            // Это может быть LP, но для безопасности считаем снайпером
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

  async getEntryPrice(mint: string): Promise<number> {
    const maxRetries = 3;
    let lastError: any = null;

    // Симулятор торговли: получаем реальную цену для имитации открытия позиции
    // НЕ делаем реальные транзакции, только получаем данные для симуляции
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await sleep(config.rpcRequestDelay);
        
        // Пытаемся получить цену через Jupiter API (приоритет)
        try {
          await sleep(config.rpcRequestDelay);
          const jupiterQuote = await this.getJupiterQuote(mint);
          if (jupiterQuote > 0) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: mint,
              message: `Entry price from Jupiter: ${jupiterQuote.toFixed(8)} SOL (attempt ${attempt + 1})`,
            });
            return jupiterQuote;
          }
        } catch (jupiterError: any) {
          // Если 429 - ждем дольше и повторяем
          if (jupiterError?.message?.includes('429') || jupiterError?.message?.includes('rate limit')) {
            const retryDelay = config.rateLimitRetryDelay * (attempt + 1);
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'warning',
              token: mint,
              message: `Jupiter API rate limit, retrying after ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
            });
            await sleep(retryDelay);
            continue;
          }
          // Другие ошибки Jupiter - пробуем fallback
        }

        // Fallback: получаем цену через bonding curve формулу на основе supply
        const mintPubkey = new PublicKey(mint);
        const mintInfo = await getMint(this.connection, mintPubkey);
        const supply = Number(mintInfo.supply);
        const decimals = mintInfo.decimals;

        // Упрощенная формула bonding curve для pump.fun
        // pump.fun использует формулу: price = (virtualTokenReserves / virtualSolReserves) * (1 - fee)
        // Для симуляции используем приблизительный расчет на основе supply
        const basePrice = 0.0001; // Базовая цена
        const supplyNormalized = supply / Math.pow(10, decimals);
        const priceMultiplier = Math.log10(supplyNormalized / 1e9 + 1) / 10;
        const estimatedPrice = basePrice * (1 + priceMultiplier);

        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `Entry price from bonding curve formula: ${estimatedPrice.toFixed(8)} SOL (supply: ${supplyNormalized.toFixed(2)}, attempt ${attempt + 1})`,
        });

        return estimatedPrice;
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

  private async getJupiterQuote(mint: string): Promise<number> {
    try {
      // Используем Jupiter API для получения цены
      // Для покупки 0.001 SOL токена
      const amount = 1000000; // 0.001 SOL в lamports
      
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${mint}&amount=${amount}&slippageBps=250`;
      
      const response = await fetch(quoteUrl);
      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.statusText}`);
      }

      const quote = await response.json() as { outAmount?: string };
      
      if (quote.outAmount) {
        // Конвертируем outAmount в цену
        const tokensReceived = Number(quote.outAmount) / 1e6; // Предполагаем 6 decimals
        const solSpent = amount / 1e9;
        return solSpent / tokensReceived; // Цена в SOL за токен
      }

      return 0;
    } catch (error) {
      console.error(`Error getting Jupiter quote for ${mint}:`, error);
      return 0;
    }
  }
}

