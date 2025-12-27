import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, PUMP_FUN_PROGRAM_ID } from './config';
import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';
import { getRpcPool } from './rpc-pool';
import { earlyActivityTracker } from './early-activity-tracker';

export class TokenScanner {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private rpcPool = getRpcPool();
  private subscriptionId: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private isShuttingDown = false;
  private onNewTokenCallback: (candidate: TokenCandidate) => void;
  private notificationQueue: any[] = []; // Основная очередь (10-30 сек)
  private queue1: TokenCandidate[] = []; // Очередь 1: 0-5 сек (самый ранний вход)
  private queue2: TokenCandidate[] = []; // Очередь 2: 5-15 сек (ранний вход)
  private isProcessingQueue = false;
  private isProcessingQueue1 = false;
  private isProcessingQueue2 = false;
  private notificationSkipCounter = 0; // Пропускаем часть уведомлений
  private processingTokens = new Set<string>(); // Токены, которые уже обрабатываются в очередях
  // ISSUE #2: Lightweight TTL deduplication for getTransaction calls
  private processedSignatures = new Map<string, number>(); // signature -> timestamp
  private processedMints = new Map<string, number>(); // mint -> timestamp
  private readonly DEDUP_TTL_MS = 60000; // 60 seconds TTL

  constructor(onNewToken: (candidate: TokenCandidate) => void) {
    this.onNewTokenCallback = onNewToken;
    this.connection = new Connection(config.heliusHttpUrl, {
      commitment: 'confirmed',
    });
  }

  /**
   * Удаляет токен из отслеживания обработки
   * Вызывается из симулятора после завершения обработки токена
   */
  removeFromProcessing(mint: string): void {
    this.processingTokens.delete(mint);
  }

  async start(): Promise<void> {
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: 'Token scanner starting...',
    });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      // Убеждаемся, что URL начинается с wss://
      let wsUrl = config.heliusWsUrl;
      if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) {
        wsUrl = wsUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      }
      if (wsUrl.startsWith('https://')) {
        wsUrl = wsUrl.replace('https://', 'wss://');
      }
      
      console.log(`Connecting to WebSocket: ${wsUrl.substring(0, 60)}...`);
      
      // Добавляем заголовки для WebSocket подключения
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://helius.dev',
        },
      });

      this.ws.on('open', () => {
        console.log('WebSocket connected to Helius');
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `WebSocket connected to Helius (attempt ${this.reconnectAttempts + 1})`,
        });
        this.reconnectAttempts = 0;
        this.subscribe();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        console.error('Error details:', {
          message: error.message,
          stack: error.stack,
          name: error.name,
        });
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `WebSocket error: ${error.message}`,
        });
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log('WebSocket closed');
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          message: `WebSocket closed: code=${code}, reason=${reason.toString()}, reconnectAttempts=${this.reconnectAttempts}`,
        });
        if (!this.isShuttingDown && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            message: `WebSocket reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
          });
          setTimeout(() => this.connect(), this.reconnectDelay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            message: `WebSocket max reconnection attempts (${this.maxReconnectAttempts}) reached`,
          });
        }
      });

    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to connect WebSocket: ${error instanceof Error ? error.message : String(error)}`,
      });
      
      if (!this.isShuttingDown && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    }
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const programId = new PublicKey(PUMP_FUN_PROGRAM_ID);
      
      // Подписка на логи программы pump.fun
      // Helius использует стандартный Solana WebSocket RPC формат
      const subscribeMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          {
            mentions: [programId.toBase58()],
          },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
          },
        ],
      };

      this.ws.send(JSON.stringify(subscribeMessage));
      console.log('Subscribed to pump.fun program logs');
    } catch (error) {
      console.error('Failed to subscribe:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to subscribe to logs: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Обработка ответа на подписку
      if (message.id === 1 && message.result) {
        this.subscriptionId = message.result;
        console.log(`Subscription confirmed, ID: ${this.subscriptionId}`);
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `WebSocket subscription confirmed, ID: ${this.subscriptionId}`,
        });
        return;
      }

      // Обработка уведомлений о логах
      if (message.method === 'logsNotification' && message.params) {
        const notification = message.params;
        const logs = notification.result?.value?.logs || [];
        
        // Check for early activity (buy/swap transactions) for tokens we're observing
        // This uses ONLY WebSocket data, no RPC calls
        const hasBuySwapActivity = logs.some((log: string) => {
          const lowerLog = log.toLowerCase();
          return (
            lowerLog.includes('swap') ||
            lowerLog.includes('buy') ||
            lowerLog.includes('instruction: buy') ||
            lowerLog.includes('instruction: swap')
          );
        });
        
        // If this looks like a buy/swap, try to extract mint and record activity
        if (hasBuySwapActivity) {
          // Try to extract mint from logs (cheap, no RPC)
          // Look for mint patterns in logs - pump.fun tokens are base58 strings
          for (const log of logs) {
            // Simple pattern: mint addresses are base58 strings of specific length
            // Match potential mint addresses (32-44 chars, base58)
            const mintMatches = log.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
            if (mintMatches) {
              for (const potentialMint of mintMatches) {
                // Skip system accounts
                if (potentialMint === '11111111111111111111111111111111' ||
                    potentialMint === 'So11111111111111111111111111111111111111112') {
                  continue;
                }
                // Record activity for any mint we're observing
                earlyActivityTracker.recordActivity(potentialMint);
              }
            }
          }
        }
        
        // СТРОГАЯ ФИЛЬТРАЦИЯ: проверяем наличие событий создания токена ДО добавления в очередь
        // Откидываем все остальные уведомления сразу
        // Более точная проверка на создание токена
        // Ищем специфичные паттерны создания токена в pump.fun
        const hasTokenCreation = logs.some((log: string) => {
          const lowerLog = log.toLowerCase();
          // Проверяем на специфичные паттерны создания токена
          return (
            lowerLog.includes('instruction: initialize') ||
            lowerLog.includes('instruction:create') ||
            (lowerLog.includes('initialize') && lowerLog.includes('token')) ||
            (lowerLog.includes('create') && (lowerLog.includes('token') || lowerLog.includes('mint'))) ||
            (lowerLog.includes('mint') && lowerLog.includes('authority'))
          );
        });
        
        // Если НЕ создание токена - откидываем сразу, не добавляя в очередь
        if (!hasTokenCreation) {
          return; // Просто откидываем, не логируем
        }
        
      // ЭКСПЕРИМЕНТ: Обрабатываем ТОЛЬКО queue1
      // Обрабатываем уведомление сразу (queue1 обрабатывается в processLogNotification)
      // Не добавляем в notificationQueue и не обрабатываем queue2/queue3
      void this.processLogNotification(notification, true); // isPriority = true для queue1
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  private async processQueue(): Promise<void> {
    // QUEUE3 ОТКЛЮЧЕНА: Неэффективна и занимает машинное время
    // Освобождаем ресурсы для queue1 и queue2
    // Статистика: queue3 показала 0% успешности, средний multiplier 0.37x
    return;
    
    // ЗАКОММЕНТИРОВАНО: Вся обработка queue3 отключена
    /*
    if (this.isProcessingQueue || this.notificationQueue.length === 0) {
      return;
    }

    // Проверяем приоритетные очереди - если они не пусты, отдаем им приоритет
    if (this.queue1.length > 0 || this.queue2.length > 0) {
      // Приоритетные очереди имеют приоритет - не обрабатываем queue3 пока они не пусты
      return;
    }

    this.isProcessingQueue = true;
    const queueStartTime = Date.now();
    const initialQueueSize = this.notificationQueue.length;

    // Логируем только если очередь большая или при старте
    if (initialQueueSize > 100 || initialQueueSize % 1000 === 0) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Processing queue3, size: ${initialQueueSize}`,
      });
    }

    // Параллельная обработка: до 7 уведомлений одновременно (увеличено для скорости)
    const maxConcurrent = 7;
    const processingPromises: Array<{ promise: Promise<void>; index: number }> = [];
    let processedCount = 0;
    let promiseIndex = 0;

    while (this.notificationQueue.length > 0 && !this.isShuttingDown) {
      // ПРИОРИТЕТНАЯ ПРОВЕРКА: Прерываем обработку queue3 если появились приоритетные токены
      if (this.queue1.length > 0 || this.queue2.length > 0) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `Interrupting queue3 processing: priority queues have ${this.queue1.length} (queue1) + ${this.queue2.length} (queue2) tokens`,
        });
        // Прерываем обработку queue3 для обработки приоритетных очередей
        break;
      }

      // Запускаем до maxConcurrent параллельных обработчиков
      while (processingPromises.length < maxConcurrent && this.notificationQueue.length > 0) {
        const notification = this.notificationQueue.shift();
        if (notification) {
          const currentIndex = promiseIndex++;
          // Обычная очередь - не приоритетная
          const promise = this.processLogNotification(notification, false)
            .then(() => {
              processedCount++;
              // Удаляем завершенный промис из массива
              const idx = processingPromises.findIndex(p => p.index === currentIndex);
              if (idx >= 0) {
                processingPromises.splice(idx, 1);
              }
            })
            .catch((error) => {
              logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'error',
                message: `Error processing notification: ${error?.message || String(error)}`,
              });
              // Удаляем завершенный промис из массива
              const idx = processingPromises.findIndex(p => p.index === currentIndex);
              if (idx >= 0) {
                processingPromises.splice(idx, 1);
              }
            });
          processingPromises.push({ promise, index: currentIndex });
        }
      }

      // Ждем завершения хотя бы одного обработчика перед запуском следующего
      if (processingPromises.length >= maxConcurrent && processingPromises.length > 0) {
        await Promise.race(processingPromises.map(p => p.promise));
      }

      // ISSUE #1: Removed artificial delay - RPC pool manages rate limiting
    }

    // Ждем завершения всех оставшихся обработчиков
    await Promise.all(processingPromises.map(p => p.promise));

    const totalDuration = Date.now() - queueStartTime;
    this.isProcessingQueue = false;

    // Логируем только если обработано много или при завершении большой очереди
    if (processedCount > 0 && (processedCount > 10 || totalDuration > 1000)) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Queue3 processed: ${processedCount} notifications in ${totalDuration}ms, avg ${(totalDuration / processedCount).toFixed(0)}ms, remaining: ${this.notificationQueue.length}`,
      });
    }
    */
  }

  private async processLogNotification(notification: any, isPriority: boolean = false): Promise<void> {
    const processStartTime = Date.now();
    const notificationTime = Date.now(); // Время получения уведомления для точного расчета возраста
    try {
      const signature = notification.result.value.signature;
      const logs = notification.result.value.logs || [];

      // ISSUE #2: Check if signature was already processed recently (deduplication)
      const now = Date.now();
      const lastProcessed = this.processedSignatures.get(signature);
      if (lastProcessed && (now - lastProcessed) < this.DEDUP_TTL_MS) {
        return; // Skip - already processed recently
      }

      // Уже проверили наличие событий создания токена до добавления в очередь
      // Но проверяем еще раз для надежности (более строгая проверка)
      const hasTokenCreation = logs.some((log: string) => {
        const lowerLog = log.toLowerCase();
        return (
          lowerLog.includes('instruction: initialize') ||
          lowerLog.includes('instruction:create') ||
          (lowerLog.includes('initialize') && lowerLog.includes('token')) ||
          (lowerLog.includes('create') && (lowerLog.includes('token') || lowerLog.includes('mint'))) ||
          (lowerLog.includes('mint') && lowerLog.includes('authority'))
        );
      });

      if (!hasTokenCreation) {
        // Не создание токена - пропускаем
        return;
      }

      // ISSUE #1: REMOVED artificial delays from hot-path
      // RPC pool already manages rate limiting, no need for additional sleeps
      // For priority queues, we want immediate processing
      
      const rpcStartTime = Date.now();
      try {
        const connection = this.rpcPool.getConnection(); // Используем пул соединений
        const tx = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
          // Транзакция не найдена - не логируем для скорости
          return;
        }

        // Ищем mint адрес в инструкциях
        const mintAddress = this.extractMintFromTransaction(tx);
        
        if (mintAddress) {
          // ISSUE #2: Check if mint was already processed recently (deduplication)
          const lastMintProcessed = this.processedMints.get(mintAddress);
          if (lastMintProcessed && (now - lastMintProcessed) < this.DEDUP_TTL_MS) {
            return; // Skip - mint already processed recently
          }

          // Mark as processed
          this.processedSignatures.set(signature, now);
          this.processedMints.set(mintAddress, now);

          // Cleanup old entries periodically (every 1000 entries to avoid memory leak)
          if (this.processedSignatures.size > 1000) {
            this.cleanupDedupCache();
          }

          // Start early activity observation for this token
          earlyActivityTracker.startObservation(mintAddress);
          
          // Используем время транзакции как время создания токена (более точно)
          // Но для приоритетных очередей используем время уведомления минус задержка обработки
          const txTime = tx.blockTime ? tx.blockTime * 1000 : notificationTime;
          // Для более точного расчета возраста используем время уведомления минус небольшая задержка
          const estimatedCreationTime = isPriority 
            ? notificationTime - 1000 // Для приоритетных: уведомление приходит почти сразу после создания
            : txTime;
          
          const candidate: TokenCandidate = {
            mint: mintAddress,
            createdAt: estimatedCreationTime,
            signature: signature,
          };

          const age = (Date.now() - candidate.createdAt) / 1000;

          // ISSUE #4: Simplified routing - only queue1 is used, process directly
          const isQueue1 = age >= config.queue1MinDelaySeconds && age <= config.queue1MaxDelaySeconds;

          if (isQueue1) {
            // Очередь 1: 0-5 сек (самый ранний вход) - рискованные токены
            candidate.isRisky = true; // Помечаем как рискованный
            this.queue1.push(candidate);
            // ISSUE #5: Reduced logging in hot-path - only log errors, not every token
            // Приоритетная обработка - запускаем немедленно
            this.processQueue1();
          } else {
            // Токен вне queue1 - пропускаем (эксперимент: обрабатываем только queue1)
            return;
          }
        }
        // Mint не найден - не логируем для скорости
      } catch (error: any) {
        // Если получили 429 - просто пропускаем это уведомление, не обрабатываем
        if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
          // Не логируем rate limit для скорости
          return;
        }
        // Для других ошибок логируем только важные
        if (!error?.message?.includes('not found')) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'error',
            message: `Error getting transaction ${signature.substring(0, 8)}...: ${error?.message || String(error)}`,
          });
        }
      }
    } catch (error: any) {
      const totalDuration = Date.now() - processStartTime;
      // Если получили 429 на верхнем уровне - тоже просто пропускаем
      if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `Rate limited at top level, skipping notification, processing time: ${totalDuration}ms`,
        });
        return; // Просто пропускаем, не обрабатываем
      }
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error processing log notification: ${error?.message || String(error)}, processing time: ${totalDuration}ms`,
      });
      console.error('Error processing log notification:', error);
    }
  }

  /**
   * ISSUE #3: Make mint extraction deterministic
   * Prefer postTokenBalances when available, fallback to instruction accounts only if needed
   */
  private extractMintFromTransaction(tx: any): string | null {
    try {
      // ISSUE #3: Prefer postTokenBalances (most reliable for new tokens)
      const tokenBalances = tx.meta?.postTokenBalances || [];
      for (const balance of tokenBalances) {
        if (balance.mint) {
          return balance.mint; // Return first mint from postTokenBalances (deterministic)
        }
      }

      // Fallback: preTokenBalances
      const preTokenBalances = tx.meta?.preTokenBalances || [];
      for (const balance of preTokenBalances) {
        if (balance.mint) {
          return balance.mint; // Return first mint from preTokenBalances
        }
      }

      // Fallback: Analyze pump.fun instructions (only if post/preTokenBalances failed)
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const accountKeysArray = accountKeys.map((acc: any) => 
        typeof acc === 'string' ? acc : acc.pubkey
      );

      const instructions = tx.transaction?.message?.instructions || [];
      for (const instruction of instructions) {
        const programId = typeof instruction.programId === 'string' 
          ? instruction.programId 
          : instruction.programId?.toString();
        
        if (programId === PUMP_FUN_PROGRAM_ID) {
          const accounts = instruction.accounts || [];
          for (const accountIndex of accounts) {
            if (typeof accountIndex === 'number' && accountKeysArray[accountIndex]) {
              const potentialMint = accountKeysArray[accountIndex];
              // Проверяем, что это не системные аккаунты
              if (potentialMint && 
                  potentialMint !== '11111111111111111111111111111111' &&
                  potentialMint !== 'So11111111111111111111111111111111111111112') {
                return potentialMint; // Return first valid mint from instructions
              }
            }
          }
        }
      }

      return null;
    } catch (error) {
      // ISSUE #5: Only log errors, not in hot-path
      return null;
    }
  }

  /**
   * ISSUE #2: Cleanup old deduplication cache entries
   */
  private cleanupDedupCache(): void {
    const now = Date.now();
    const cutoff = now - this.DEDUP_TTL_MS;
    
    for (const [key, timestamp] of this.processedSignatures.entries()) {
      if (timestamp < cutoff) {
        this.processedSignatures.delete(key);
      }
    }
    
    for (const [key, timestamp] of this.processedMints.entries()) {
      if (timestamp < cutoff) {
        this.processedMints.delete(key);
      }
    }
  }

  private async processQueue1(): Promise<void> {
    // Обрабатываем очередь 1 (0-5 сек) параллельно другим
    if (this.isProcessingQueue1 || this.queue1.length === 0) {
      return;
    }

    this.isProcessingQueue1 = true;

    // Параллельная обработка до 8 токенов одновременно (увеличено для скорости для приоритетной очереди)
    const maxConcurrent = 8;
    const processingPromises: Array<{ promise: Promise<void>; index: number }> = [];
    let promiseIndex = 0;

    while (this.queue1.length > 0 && !this.isShuttingDown) {
      // Запускаем до maxConcurrent параллельных обработчиков
      while (processingPromises.length < maxConcurrent && this.queue1.length > 0) {
        const candidate = this.queue1.shift();
        if (!candidate) continue;

        const age = (Date.now() - candidate.createdAt) / 1000;
        
        // Проверяем, что токен все еще в диапазоне 0-5 секунд
        if (age < config.queue1MinDelaySeconds || age > config.queue1MaxDelaySeconds) {
          // Токен вышел из диапазона - убираем из обработки
          this.processingTokens.delete(candidate.mint);
          continue;
        }

        // Обрабатываем токен параллельно
        const currentIndex = promiseIndex++;
        const promise = (async () => {
          try {
            await this.onNewTokenCallback(candidate);
          } catch (error) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'error',
              token: candidate.mint,
              message: `Error processing queue1 token: ${error instanceof Error ? error.message : String(error)}`,
            });
          } finally {
            // Убираем из обработки после завершения
            this.processingTokens.delete(candidate.mint);
            // Удаляем завершенный промис из массива
            const idx = processingPromises.findIndex(p => p.index === currentIndex);
            if (idx >= 0) {
              processingPromises.splice(idx, 1);
            }
          }
        })();
        
        processingPromises.push({ promise, index: currentIndex });
      }

      // Ждем завершения хотя бы одного обработчика
      if (processingPromises.length >= maxConcurrent && processingPromises.length > 0) {
        await Promise.race(processingPromises.map(p => p.promise));
      }

      // ISSUE #1: Removed artificial delay - no sleep needed
    }

    // Ждем завершения всех оставшихся обработчиков
    await Promise.all(processingPromises.map(p => p.promise));

    this.isProcessingQueue1 = false;
  }

  private async processQueue2(): Promise<void> {
    // Обрабатываем очередь 2 (5-15 сек) параллельно другим
    if (this.isProcessingQueue2 || this.queue2.length === 0) {
      return;
    }

    this.isProcessingQueue2 = true;

    // Параллельная обработка до 8 токенов одновременно (увеличено для скорости для приоритетной очереди)
    const maxConcurrent = 8;
    const processingPromises: Array<{ promise: Promise<void>; index: number }> = [];
    let promiseIndex = 0;

    while (this.queue2.length > 0 && !this.isShuttingDown) {
      // Запускаем до maxConcurrent параллельных обработчиков
      while (processingPromises.length < maxConcurrent && this.queue2.length > 0) {
        const candidate = this.queue2.shift();
        if (!candidate) continue;

        const age = (Date.now() - candidate.createdAt) / 1000;
        
        // Проверяем, что токен все еще в диапазоне 5-15 секунд
        if (age < config.queue2MinDelaySeconds || age > config.queue2MaxDelaySeconds) {
          // Токен вышел из диапазона - убираем из обработки
          this.processingTokens.delete(candidate.mint);
          continue;
        }

        // Обрабатываем токен параллельно
        const currentIndex = promiseIndex++;
        const promise = (async () => {
          try {
            await this.onNewTokenCallback(candidate);
          } catch (error) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'error',
              token: candidate.mint,
              message: `Error processing queue2 token: ${error instanceof Error ? error.message : String(error)}`,
            });
          } finally {
            // Убираем из обработки после завершения
            this.processingTokens.delete(candidate.mint);
            // Удаляем завершенный промис из массива
            const idx = processingPromises.findIndex(p => p.index === currentIndex);
            if (idx >= 0) {
              processingPromises.splice(idx, 1);
            }
          }
        })();
        
        processingPromises.push({ promise, index: currentIndex });
      }

      // Ждем завершения хотя бы одного обработчика
      if (processingPromises.length >= maxConcurrent && processingPromises.length > 0) {
        await Promise.race(processingPromises.map(p => p.promise));
      }

      // ISSUE #1: Removed artificial delay - no sleep needed
    }

    // Ждем завершения всех оставшихся обработчиков
    await Promise.all(processingPromises.map(p => p.promise));

    this.isProcessingQueue2 = false;
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.subscriptionId !== null && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const unsubscribeMessage = {
          jsonrpc: '2.0',
          id: 2,
          method: 'logsUnsubscribe',
          params: [this.subscriptionId],
        };
        this.ws.send(JSON.stringify(unsubscribeMessage));
      } catch (error) {
        console.error('Error unsubscribing:', error);
      }
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

