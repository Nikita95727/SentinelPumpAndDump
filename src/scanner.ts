import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, PUMP_FUN_PROGRAM_ID } from './config';
import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';
import { getRpcPool } from './rpc-pool';

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

  private async handleMessage(data: WebSocket.Data): Promise<void> {
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
        
        // СТРОГАЯ ФИЛЬТРАЦИЯ: проверяем наличие событий создания токена ДО добавления в очередь
        // Откидываем все остальные уведомления сразу
        const logs = notification.result?.value?.logs || [];
        
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
        
      // Добавляем в очередь ТОЛЬКО уведомления о создании токенов
      // Для приоритетной обработки (queue1, queue2) обрабатываем сразу без задержки
      // Для обычной очереди добавляем с задержкой
      this.notificationQueue.push(notification);
      
      // ПРИОРИТЕТНАЯ ОБРАБОТКА: Сначала проверяем приоритетные очереди
      // Если они не пусты - обрабатываем их, иначе обрабатываем queue3
      if (this.queue1.length > 0 || this.queue2.length > 0) {
        // Приоритетные очереди имеют приоритет - не запускаем queue3
        // Обработка queue1/queue2 запускается автоматически из processLogNotification
      } else {
        // Запускаем обработку queue3 только если приоритетные очереди пусты
        this.processQueue();
      }
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  private async processQueue(): Promise<void> {
    // ПРИОРИТЕТНАЯ ОБРАБОТКА: Сначала обрабатываем queue1 и queue2, только потом queue3
    // Если есть токены в приоритетных очередях - прерываем обработку queue3
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

      // Небольшая задержка для предотвращения перегрузки (только если очередь большая)
      if (this.notificationQueue.length > 100) {
        await sleep(50); // Задержка только при большой очереди
      }
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
  }

  private async processLogNotification(notification: any, isPriority: boolean = false): Promise<void> {
    const processStartTime = Date.now();
    const notificationTime = Date.now(); // Время получения уведомления для точного расчета возраста
    try {
      const signature = notification.result.value.signature;
      const logs = notification.result.value.logs || [];

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

      // Для приоритетных очередей (queue1, queue2) - минимальная задержка или без задержки
      // Для обычной очереди - стандартная задержка
      if (!isPriority) {
        await sleep(config.rpcRequestDelay);
      } else {
        // Для приоритетных - минимальная задержка (50ms вместо 250ms)
        await sleep(50);
      }
      
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

          const totalDuration = Date.now() - processStartTime;
          const age = (Date.now() - candidate.createdAt) / 1000;

          // Определяем в какую очередь отправить токен (три очереди)
          const isQueue1 = age >= config.queue1MinDelaySeconds && age <= config.queue1MaxDelaySeconds;
          const isQueue2 = age >= config.queue2MinDelaySeconds && age <= config.queue2MaxDelaySeconds;
          const isQueue3 = age >= config.minDelaySeconds && age <= config.maxDelaySeconds;

          if (isQueue1) {
            // Очередь 1: 0-5 сек (самый ранний вход) - рискованные токены
            candidate.isRisky = true; // Помечаем как рискованный
            this.queue1.push(candidate);
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'token_received',
              token: mintAddress,
              message: `New token detected (queue 1, 0-5s, RISKY): ${mintAddress.substring(0, 8)}..., age: ${age.toFixed(1)}s, processing time: ${totalDuration}ms`,
            });
            // Приоритетная обработка - запускаем немедленно
            this.processQueue1();
          } else if (isQueue2) {
            // Очередь 2: 5-15 сек (ранний вход) - рискованные токены
            candidate.isRisky = true; // Помечаем как рискованный
            this.queue2.push(candidate);
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'token_received',
              token: mintAddress,
              message: `New token detected (queue 2, 5-15s, RISKY): ${mintAddress.substring(0, 8)}..., age: ${age.toFixed(1)}s, processing time: ${totalDuration}ms`,
            });
            // Приоритетная обработка - запускаем немедленно
            this.processQueue2();
          } else if (isQueue3) {
            // Очередь 3: 10-30 сек (стандартный вход)
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'token_received',
              token: mintAddress,
              message: `New token detected (queue 3, 10-30s): ${mintAddress.substring(0, 8)}..., age: ${age.toFixed(1)}s, processing time: ${totalDuration}ms`,
            });
            this.onNewTokenCallback(candidate);
          } else {
            // Токен вне диапазонов - логируем но не обрабатываем
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: mintAddress,
              message: `Token age ${age.toFixed(1)}s outside all queues (0-5s, 5-15s, or 10-30s), skipping`,
            });
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

  private extractMintFromTransaction(tx: any): string | null {
    try {
      // Способ 1: Ищем mint в postTokenBalances
      const tokenBalances = tx.meta?.postTokenBalances || [];
      const mintSet = new Set<string>();
      
      for (const balance of tokenBalances) {
        if (balance.mint) {
          mintSet.add(balance.mint);
        }
      }

      // Способ 2: Ищем в preTokenBalances (для новых токенов может быть пусто)
      const preTokenBalances = tx.meta?.preTokenBalances || [];
      for (const balance of preTokenBalances) {
        if (balance.mint) {
          mintSet.add(balance.mint);
        }
      }

      // Способ 3: Ищем новые аккаунты, которые могут быть mint
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const accountKeysArray = accountKeys.map((acc: any) => 
        typeof acc === 'string' ? acc : acc.pubkey
      );

      // Способ 4: Анализируем инструкции pump.fun
      const instructions = tx.transaction?.message?.instructions || [];
      for (const instruction of instructions) {
        const programId = typeof instruction.programId === 'string' 
          ? instruction.programId 
          : instruction.programId?.toString();
        
        if (programId === PUMP_FUN_PROGRAM_ID) {
          // В pump.fun инструкция создания токена обычно содержит mint в accounts
          const accounts = instruction.accounts || [];
          for (const accountIndex of accounts) {
            if (typeof accountIndex === 'number' && accountKeysArray[accountIndex]) {
              const potentialMint = accountKeysArray[accountIndex];
              // Проверяем, что это не системные аккаунты
              if (potentialMint && 
                  potentialMint !== '11111111111111111111111111111111' &&
                  potentialMint !== 'So11111111111111111111111111111111111111112') {
                mintSet.add(potentialMint);
              }
            }
          }
        }
      }

      // Возвращаем первый найденный mint (обычно в pump.fun создается один токен за транзакцию)
      if (mintSet.size > 0) {
        return Array.from(mintSet)[0];
      }

      return null;
    } catch (error) {
      console.error('Error extracting mint from transaction:', error);
      return null;
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

      // Небольшая задержка только если очередь очень большая
      if (this.queue1.length > 50) {
        await sleep(10);
      }
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

      // Небольшая задержка только если очередь очень большая
      if (this.queue2.length > 50) {
        await sleep(10);
      }
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

