import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, PUMP_FUN_PROGRAM_ID } from './config';
import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';
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
  private tokenQueue: TokenCandidate[] = []; // Единая очередь токенов
  private isProcessingQueue = false;
  private processingTokens = new Set<string>(); // Токены, которые уже обрабатываются
  // Deduplication для getTransaction calls
  private processedSignatures = new Map<string, number>(); // signature -> timestamp
  private processedMints = new Map<string, number>(); // mint -> timestamp
  private readonly DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // ⭐ 24 часа TTL (было 60 секунд) - предотвращает повторную покупку старых токенов
  private readonly QUEUE_CLEANUP_INTERVAL_MS = 60_000; // Очистка очереди каждую минуту
  private readonly MAX_QUEUE_AGE_MS = 5 * 60 * 1000; // Максимальный возраст токена в очереди: 5 минут

  constructor(onNewToken: (candidate: TokenCandidate) => void) {
    this.onNewTokenCallback = onNewToken;
    this.connection = new Connection(config.heliusHttpUrl, {
      commitment: 'confirmed',
    });
  }

  /**
   * Удаляет токен из отслеживания обработки
   */
  removeFromProcessing(mint: string): void {
    this.processingTokens.delete(mint);
  }

  /**
   * Жесткий сброс очереди при перезапуске
   * Очищает все структуры данных в памяти для предотвращения дубликатов
   */
  private resetQueue(): void {
    const queueSize = this.tokenQueue.length;
    const processingSize = this.processingTokens.size;
    const processedMintsSize = this.processedMints.size;
    const processedSignaturesSize = this.processedSignatures.size;

    // Останавливаем обработку очереди
    this.isProcessingQueue = false;

    // Очищаем очередь токенов
    this.tokenQueue = [];

    // Очищаем Set обрабатываемых токенов
    this.processingTokens.clear();

    // Очищаем Map обработанных токенов (дедупликация)
    this.processedMints.clear();

    // Очищаем Map обработанных сигнатур (дедупликация)
    this.processedSignatures.clear();

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔄 Queue hard reset: cleared ${queueSize} queued tokens, ${processingSize} processing tokens, ${processedMintsSize} processed mints, ${processedSignaturesSize} processed signatures`,
    });
  }

  async start(): Promise<void> {
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: 'Token scanner starting...',
    });

    // ⭐ ЖЕСТКИЙ СБРОС ОЧЕРЕДИ ПРИ ПЕРЕЗАПУСКЕ
    this.resetQueue();

    await this.connect();
    // Запускаем обработку единой очереди
    this.processTokenQueue();
    // Запускаем периодическую очистку очереди от старых токенов
    this.startQueueCleanup();
  }

  /**
   * Периодическая очистка очереди от старых токенов
   * Предотвращает засорение очереди токенами, которые висят там слишком долго
   */
  private startQueueCleanup(): void {
    setInterval(() => {
      if (this.isShuttingDown) return;
      
      const now = Date.now();
      const initialLength = this.tokenQueue.length;
      
      // Удаляем токены старше MAX_QUEUE_AGE_MS
      this.tokenQueue = this.tokenQueue.filter(candidate => {
        const age = now - candidate.createdAt;
        if (age > this.MAX_QUEUE_AGE_MS) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `Removing stale token from queue: ${candidate.mint.substring(0, 8)}... (age: ${(age / 1000).toFixed(1)}s)`,
          });
          return false; // Удаляем токен
        }
        return true; // Оставляем токен
      });
      
      const removed = initialLength - this.tokenQueue.length;
      if (removed > 0) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `Queue cleanup: removed ${removed} stale tokens, remaining: ${this.tokenQueue.length}`,
        });
      }
    }, this.QUEUE_CLEANUP_INTERVAL_MS);
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      let wsUrl = config.heliusWsUrl;
      if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) {
        wsUrl = wsUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      }
      if (wsUrl.startsWith('https://')) {
        wsUrl = wsUrl.replace('https://', 'wss://');
      }
      
      console.log(`Connecting to WebSocket: ${wsUrl.substring(0, 60)}...`);
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://helius.dev',
        },
      });

      this.ws.on('open', () => {
        const networkMode = config.testnetMode ? 'Testnet' : 'Mainnet';
        console.log(`WebSocket connected to Pump.fun ${networkMode}`);
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `WebSocket connected to Pump.fun ${networkMode} (attempt ${this.reconnectAttempts + 1})`,
        });
        this.reconnectAttempts = 0;
        this.subscribe();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
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
        
        // Check for early activity (buy/swap transactions)
        const hasBuySwapActivity = logs.some((log: string) => {
          const lowerLog = log.toLowerCase();
          return (
            lowerLog.includes('swap') ||
            lowerLog.includes('buy') ||
            lowerLog.includes('instruction: buy') ||
            lowerLog.includes('instruction: swap')
          );
        });
        
        if (hasBuySwapActivity) {
          for (const log of logs) {
            const mintMatches = log.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
            if (mintMatches) {
              for (const potentialMint of mintMatches) {
                if (potentialMint === '11111111111111111111111111111111' ||
                    potentialMint === 'So11111111111111111111111111111111111111112') {
                  continue;
                }
                earlyActivityTracker.recordActivity(potentialMint);
              }
            }
          }
        }
        
        // Проверяем наличие событий создания токена
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
          return; // Не создание токена - пропускаем
        }
        
        // Обрабатываем уведомление и добавляем в единую очередь
        void this.processLogNotification(notification);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  /**
   * Обработка единой очереди токенов
   */
  private async processTokenQueue(): Promise<void> {
    if (this.isProcessingQueue || this.tokenQueue.length === 0) {
      // Если очередь пуста, проверяем снова через 100ms
      if (!this.isShuttingDown) {
        setTimeout(() => this.processTokenQueue(), 100);
      }
      return;
    }

    this.isProcessingQueue = true;
    const maxConcurrent = 8; // Параллельная обработка до 8 токенов
    const processingPromises: Array<{ promise: Promise<void>; index: number }> = [];
    let promiseIndex = 0;

    while (this.tokenQueue.length > 0 && !this.isShuttingDown) {
      while (processingPromises.length < maxConcurrent && this.tokenQueue.length > 0) {
        const candidate = this.tokenQueue.shift();
        if (!candidate) continue;

        // Проверяем, не обрабатывается ли уже этот токен
        if (this.processingTokens.has(candidate.mint)) {
          continue;
        }

        this.processingTokens.add(candidate.mint);

        const currentIndex = promiseIndex++;
        const promise = (async () => {
          try {
            await this.onNewTokenCallback(candidate);
          } catch (error) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'error',
              token: candidate.mint,
              message: `Error processing token: ${error instanceof Error ? error.message : String(error)}`,
            });
          } finally {
            this.processingTokens.delete(candidate.mint);
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

      // Небольшая задержка для избежания перегрузки
      if (this.tokenQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    // Ждем завершения всех оставшихся обработчиков
    await Promise.all(processingPromises.map(p => p.promise));

    this.isProcessingQueue = false;

    // Продолжаем обработку очереди
    if (!this.isShuttingDown) {
      setTimeout(() => this.processTokenQueue(), 100);
    }
  }

  private async processLogNotification(notification: any): Promise<void> {
    const processStartTime = Date.now();
    try {
      const signature = notification.result.value.signature;
      const logs = notification.result.value.logs || [];

      // Deduplication
      const now = Date.now();
      const lastProcessed = this.processedSignatures.get(signature);
      if (lastProcessed && (now - lastProcessed) < this.DEDUP_TTL_MS) {
        return; // Skip - already processed recently
      }

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
        return;
      }

      const rpcStartTime = Date.now();
      try {
        const connection = this.rpcPool.getConnection();
        const tx = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) {
          return;
        }

        const mintAddress = this.extractMintFromTransaction(tx);
        
        if (mintAddress) {
          // Deduplication по mint
          const lastMintProcessed = this.processedMints.get(mintAddress);
          if (lastMintProcessed && (now - lastMintProcessed) < this.DEDUP_TTL_MS) {
            return;
          }

          // Mark as processed
          this.processedSignatures.set(signature, now);
          this.processedMints.set(mintAddress, now);

          // Cleanup old entries periodically
          if (this.processedSignatures.size > 1000) {
            this.cleanupDedupCache();
          }

          // Start early activity observation
          earlyActivityTracker.startObservation(mintAddress);
          
          // Используем время транзакции как время создания токена
          const txTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
          
          const candidate: TokenCandidate = {
            mint: mintAddress,
            createdAt: txTime,
            signature: signature,
          };

          // ⭐ ПРОВЕРКА: Не добавляем токен в очередь, если он уже там есть
          const alreadyInQueue = this.tokenQueue.some(t => t.mint === mintAddress);
          if (alreadyInQueue) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: mintAddress,
              message: `Token ${mintAddress.substring(0, 8)}... already in queue, skipping duplicate`,
            });
            return;
          }

          // ⭐ ПРОВЕРКА: Не добавляем токен, если он уже обрабатывается
          if (this.processingTokens.has(mintAddress)) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'info',
              token: mintAddress,
              message: `Token ${mintAddress.substring(0, 8)}... already being processed, skipping duplicate`,
            });
            return;
          }

          // ✅ УБРАНА ЛОГИКА ПО ВОЗРАСТУ: Добавляем токен в единую очередь без фильтрации по возрасту
          this.tokenQueue.push(candidate);
          
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: mintAddress,
            message: `Token ${mintAddress.substring(0, 8)}... added to queue (queue size: ${this.tokenQueue.length})`,
          });
          
          // Запускаем обработку очереди если она еще не запущена
          if (!this.isProcessingQueue) {
            this.processTokenQueue();
          }
        }
      } catch (error: any) {
        if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
          return;
        }
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
      if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `Rate limited at top level, skipping notification, processing time: ${totalDuration}ms`,
        });
        return;
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
   * Извлекает mint address из транзакции
   */
  private extractMintFromTransaction(tx: any): string | null {
    try {
      // Приоритет 1: postTokenBalances
      const tokenBalances = tx.meta?.postTokenBalances || [];
      for (const balance of tokenBalances) {
        if (balance.mint) {
          return balance.mint;
        }
      }

      // Приоритет 2: preTokenBalances
      const preTokenBalances = tx.meta?.preTokenBalances || [];
      for (const balance of preTokenBalances) {
        if (balance.mint) {
          return balance.mint;
        }
      }

      // Приоритет 3: instruction accounts
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
              if (potentialMint && 
                  potentialMint !== '11111111111111111111111111111111' &&
                  potentialMint !== 'So11111111111111111111111111111111111111112') {
                return potentialMint;
              }
            }
          }
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Очистка старых записей deduplication cache
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
