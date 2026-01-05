import WebSocket from 'ws';
import { Connection } from '@solana/web3.js';
import { config, PUMP_FUN_PROGRAM_ID } from './config';
import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';
import { getRpcPool } from './rpc-pool';
import { earlyActivityTracker } from './early-activity-tracker';

/**
 * TokenScanner — сканер новых токенов через PumpPortal WebSocket API
 * 
 * Подключается к wss://pumpportal.fun/api/data для получения:
 * - Событий создания новых токенов (txType: "create")
 * - Событий покупок/продаж на бондинг-кривой (txType: "buy"/"sell")
 * 
 * Это нативное решение для Pump.fun, не требующее Helius или других RPC провайдеров
 * для обнаружения токенов.
 */
export class TokenScanner {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private rpcPool = getRpcPool();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private baseReconnectDelay = 2000; // Минимальная задержка 2 сек
  private maxReconnectDelay = 60000; // Максимальная задержка 60 сек
  private isShuttingDown = false;
  private onNewTokenCallback: (candidate: TokenCandidate) => void;
  private tokenQueue: TokenCandidate[] = [];
  private isProcessingQueue = false;
  private processingTokens = new Set<string>();
  private processedMints = new Map<string, number>();
  private readonly DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа TTL
  private readonly QUEUE_CLEANUP_INTERVAL_MS = 60_000;
  private readonly MAX_QUEUE_AGE_MS = 5 * 60 * 1000;

  constructor(onNewToken: (candidate: TokenCandidate) => void) {
    this.onNewTokenCallback = onNewToken;
    this.connection = new Connection(config.primaryRpcHttpUrl, {
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
   */
  private resetQueue(): void {
    const queueSize = this.tokenQueue.length;
    const processingSize = this.processingTokens.size;
    const processedMintsSize = this.processedMints.size;

    this.isProcessingQueue = false;
    this.tokenQueue = [];
    this.processingTokens.clear();
    this.processedMints.clear();

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `🔄 Queue HARD RESET: cleared ${queueSize} queued tokens, ${processingSize} processing tokens, ${processedMintsSize} processed mints. All deduplication caches cleared.`,
    });
  }

  async start(): Promise<void> {
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: 'Token scanner starting...',
    });

    this.resetQueue();
    await this.connect();
    this.processTokenQueue();
    this.startQueueCleanup();
  }

  /**
   * Периодическая очистка очереди от старых токенов
   */
  private startQueueCleanup(): void {
    setInterval(() => {
      if (this.isShuttingDown) return;

      const now = Date.now();
      const initialLength = this.tokenQueue.length;

      this.tokenQueue = this.tokenQueue.filter(candidate => {
        const age = now - candidate.createdAt;
        if (age > this.MAX_QUEUE_AGE_MS) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `Removing stale token from queue: ${candidate.mint.substring(0, 8)}... (age: ${(age / 1000).toFixed(1)}s)`,
          });
          return false;
        }
        return true;
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

  /**
   * Подключение к PumpPortal WebSocket
   */
  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      const wsUrl = config.pumpPortalWsUrl || 'wss://pumpportal.fun/api/data';

      console.log(`Connecting to PumpPortal WebSocket: ${wsUrl}`);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `🔄 Connecting to PumpPortal: ${wsUrl}`,
      });

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('WebSocket connected to PumpPortal');
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: 'WebSocket connected to PumpPortal',
        });
        this.reconnectAttempts = 0;
        this.subscribe();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        console.error('PumpPortal WebSocket error:', error);
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `PumpPortal error: ${error.message}`,
        });
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log('PumpPortal WebSocket closed');
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'warning',
          message: `PumpPortal closed: code=${code}, reason=${reason.toString()}`,
        });
        if (!this.isShuttingDown && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.calculateReconnectDelay();
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            message: `🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
          });
          setTimeout(() => this.connect(), delay);
        }
      });

    } catch (error) {
      console.error('Failed to connect to PumpPortal:', error);
      if (!this.isShuttingDown && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.calculateReconnectDelay();
        setTimeout(() => this.connect(), delay);
      }
    }
  }

  /**
   * Расчет задержки с использованием экспоненциального отката и jitter
   */
  private calculateReconnectDelay(): number {
    let delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    const jitter = delay * 0.2;
    const randomJitter = (Math.random() * 2 - 1) * jitter;
    return Math.floor(delay + randomJitter);
  }

  /**
   * Подписка на события PumpPortal
   */
  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      // Подписываемся на новые токены
      this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));

      // Подписываемся на все сделки (для early activity tracking)
      this.ws.send(JSON.stringify({ method: 'subscribeAllTransactions' }));

      console.log('Subscribed to PumpPortal: new tokens + transactions');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: 'Subscribed to PumpPortal: subscribeNewToken, subscribeAllTransactions',
      });
    } catch (error) {
      console.error('Failed to subscribe to PumpPortal:', error);
    }
  }

  /**
   * Обработка сообщений от PumpPortal
   * 
   * Форматы сообщений:
   * - Создание токена: { txType: "create", mint: "...", signature: "...", traderPublicKey: "..." }
   * - Покупка: { txType: "buy", mint: "...", solAmount: 0.1, traderPublicKey: "..." }
   * - Продажа: { txType: "sell", mint: "...", solAmount: 0.1, traderPublicKey: "..." }
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());

      // Событие создания нового токена
      if (message.txType === 'create') {
        const mint = message.mint;
        const now = Date.now();

        // Дедупликация по mint
        if (this.processedMints.has(mint)) return;
        this.processedMints.set(mint, now);

        // Начинаем отслеживание ранней активности
        earlyActivityTracker.startObservation(mint);

        const candidate: TokenCandidate = {
          mint,
          createdAt: now,
          signature: message.signature || '',
        };

        // Проверяем дубликаты в очереди
        const alreadyInQueue = this.tokenQueue.some(t => t.mint === mint);
        if (alreadyInQueue) return;

        if (this.processingTokens.has(mint)) return;

        this.tokenQueue.push(candidate);

        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: mint,
          message: `📄 NEW TOKEN (PumpPortal): ${mint.substring(0, 12)}... | Creator: ${message.traderPublicKey?.substring(0, 8) || 'unknown'}... | Queue: ${this.tokenQueue.length}`,
        });

        if (!this.isProcessingQueue) {
          void this.processTokenQueue();
        }
      }
      // Событие покупки/продажи (для early activity)
      else if (message.txType === 'buy' || message.txType === 'sell') {
        if (message.mint) {
          // Записываем активность (покупка/продажа) для трекера
          earlyActivityTracker.recordActivity(
            message.mint,
            message.traderPublicKey,
            message.solAmount,
            message.txType
          );
        }
      }
    } catch (error) {
      // Игнорируем ошибки парсинга (могут быть системные сообщения)
    }
  }

  /**
   * Обработка единой очереди токенов
   */
  private async processTokenQueue(): Promise<void> {
    if (this.isProcessingQueue || this.tokenQueue.length === 0) {
      if (!this.isShuttingDown) {
        setTimeout(() => this.processTokenQueue(), 100);
      }
      return;
    }

    this.isProcessingQueue = true;
    const maxConcurrent = 8;
    const processingPromises: Array<{ promise: Promise<void>; index: number }> = [];
    let promiseIndex = 0;

    while (this.tokenQueue.length > 0 && !this.isShuttingDown) {
      while (processingPromises.length < maxConcurrent && this.tokenQueue.length > 0) {
        const candidate = this.tokenQueue.shift();
        if (!candidate) continue;

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

      if (processingPromises.length >= maxConcurrent && processingPromises.length > 0) {
        await Promise.race(processingPromises.map(p => p.promise));
      }

      if (this.tokenQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    await Promise.all(processingPromises.map(p => p.promise));
    this.isProcessingQueue = false;

    if (!this.isShuttingDown) {
      setTimeout(() => this.processTokenQueue(), 100);
    }
  }

  /**
   * Очистка старых записей deduplication cache
   */
  private cleanupDedupCache(): void {
    const now = Date.now();
    const cutoff = now - this.DEDUP_TTL_MS;

    for (const [key, timestamp] of this.processedMints.entries()) {
      if (timestamp < cutoff) {
        this.processedMints.delete(key);
      }
    }
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
