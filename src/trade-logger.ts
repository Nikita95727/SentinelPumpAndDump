import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from './config';
import { getCurrentDateUTC, getCurrentTimestamp } from './utils';

/**
 * Trade event types
 */
export type TradeEventType = 'TRADE_OPEN' | 'TRADE_CLOSE' | 'BATCH_START' | 'BATCH_END';

/**
 * Trade event structure (flat, no nesting)
 */
export interface TradeEvent {
  timestamp: string;
  event: TradeEventType;
  tradeId?: string;
  batchId?: number;
  token?: string;
  investedSol?: number;
  entryPrice?: number;
  exitPrice?: number;
  multiplier?: number;
  profitSol?: number;
  reason?: string;
  depositBefore?: number;
  depositAfter?: number;
  netProfitPct?: number;
}

/**
 * In-memory log buffer - synchronous, zero-cost
 */
class LogBuffer {
  private buffer: TradeEvent[] = [];
  private maxBufferSize: number;

  constructor(maxBufferSize: number = 1000) {
    this.maxBufferSize = maxBufferSize;
  }

  /**
   * Add event to buffer - synchronous, no await, no I/O
   */
  push(event: TradeEvent): void {
    if (this.buffer.length >= this.maxBufferSize) {
      // Drop oldest events if buffer is full (prevent memory leak)
      this.buffer.shift();
    }
    this.buffer.push(event);
  }

  /**
   * Drain buffer and return events
   */
  drain(): TradeEvent[] {
    const events = this.buffer;
    this.buffer = [];
    return events;
  }

  /**
   * Get current buffer size
   */
  size(): number {
    return this.buffer.length;
  }
}

/**
 * Async log flusher - writes to disk on interval
 */
class LogFlusher {
  private buffer: LogBuffer;
  private flushInterval: NodeJS.Timeout | null = null;
  private currentDate: string;
  private logFileHandle: fs.FileHandle | null = null;
  private enabled: boolean;

  constructor(buffer: LogBuffer, enabled: boolean = true) {
    this.buffer = buffer;
    this.enabled = enabled;
    this.currentDate = getCurrentDateUTC();
    
    if (this.enabled) {
      this.start();
    }
  }

  private async start(): Promise<void> {
    // Ensure log directory exists
    try {
      await fs.mkdir(config.logDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create log directory:', error);
      return;
    }

    // Start flush interval (500-1000ms)
    const flushIntervalMs = 750;
    this.flushInterval = setInterval(() => {
      void this.flush(); // Fire and forget
    }, flushIntervalMs);
  }

  private async ensureLogFile(): Promise<void> {
    const today = getCurrentDateUTC();
    
    if (today !== this.currentDate) {
      // Date changed, close old file
      if (this.logFileHandle) {
        try {
          await this.logFileHandle.close();
        } catch (error) {
          // Ignore errors on close
        }
        this.logFileHandle = null;
      }
      this.currentDate = today;
    }

    if (!this.logFileHandle) {
      const logFilePath = path.join(config.logDir, `trades-${this.currentDate}.jsonl`);
      try {
        this.logFileHandle = await fs.open(logFilePath, 'a');
      } catch (error) {
        console.error('Failed to open log file:', error);
        // Continue without file handle (events will be lost, but bot continues)
      }
    }
  }

  /**
   * Flush buffer to disk - async, non-blocking
   */
  private async flush(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const events = this.buffer.drain();
    if (events.length === 0) {
      return;
    }

    try {
      await this.ensureLogFile();
      
      if (!this.logFileHandle) {
        return; // Can't write, but don't block
      }

      // Serialize all events to JSONL
      const lines: string[] = [];
      for (const event of events) {
        try {
          const line = JSON.stringify(event) + '\n';
          lines.push(line);
        } catch (error) {
          // Skip invalid events
          continue;
        }
      }

      if (lines.length > 0) {
        await this.logFileHandle.appendFile(lines.join(''));
      }
    } catch (error) {
      // Log error but don't block trading
      console.error('Failed to flush trade logs:', error);
    }
  }

  /**
   * Force flush and close
   */
  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush
    await this.flush();

    if (this.logFileHandle) {
      try {
        await this.logFileHandle.close();
      } catch (error) {
        // Ignore
      }
      this.logFileHandle = null;
    }
  }
}

/**
 * Batch tracker - logical batches (every N trades)
 */
class BatchTracker {
  private currentBatchId: number = 1;
  private tradesInCurrentBatch: number = 0;
  public readonly batchSize: number;

  constructor(batchSize: number = 10) {
    this.batchSize = batchSize;
  }

  /**
   * Get current batch ID and increment trade count
   */
  getBatchId(): number {
    this.tradesInCurrentBatch++;
    if (this.tradesInCurrentBatch > this.batchSize) {
      this.currentBatchId++;
      this.tradesInCurrentBatch = 1;
    }
    return this.currentBatchId;
  }

  /**
   * Get current batch ID without incrementing
   */
  getCurrentBatchId(): number {
    return this.currentBatchId;
  }
}

/**
 * Non-blocking trade logger
 */
class TradeLogger {
  private buffer: LogBuffer;
  private flusher: LogFlusher;
  private batchTracker: BatchTracker;
  private enabled: boolean;
  private tradeCounter: number = 0;

  constructor(enabled: boolean = true, batchSize: number = 10) {
    this.enabled = enabled;
    this.buffer = new LogBuffer(1000);
    this.flusher = new LogFlusher(this.buffer, enabled);
    this.batchTracker = new BatchTracker(batchSize);
  }

  /**
   * Log trade open - synchronous, zero-cost
   */
  logTradeOpen(params: {
    tradeId: string;
    token: string;
    investedSol: number;
    entryPrice: number;
  }): void {
    if (!this.enabled) {
      return;
    }

    this.tradeCounter++;
    const batchId = this.batchTracker.getBatchId();
    
    // Check if this is the first trade in a new batch
    const isBatchStart = this.tradeCounter % this.batchTracker.batchSize === 1;

    if (isBatchStart) {
      this.buffer.push({
        timestamp: getCurrentTimestamp(),
        event: 'BATCH_START',
        batchId,
      });
    }

    this.buffer.push({
      timestamp: getCurrentTimestamp(),
      event: 'TRADE_OPEN',
      tradeId: params.tradeId,
      batchId,
      token: params.token,
      investedSol: params.investedSol,
      entryPrice: params.entryPrice,
    });
  }

  /**
   * Log trade close - synchronous, zero-cost
   */
  logTradeClose(params: {
    tradeId: string;
    token: string;
    exitPrice: number;
    multiplier: number;
    profitSol: number;
    reason: string;
  }): void {
    if (!this.enabled) {
      return;
    }

    const batchId = this.batchTracker.getCurrentBatchId();
    
    this.buffer.push({
      timestamp: getCurrentTimestamp(),
      event: 'TRADE_CLOSE',
      tradeId: params.tradeId,
      batchId,
      token: params.token,
      exitPrice: params.exitPrice,
      multiplier: params.multiplier,
      profitSol: params.profitSol,
      reason: params.reason,
    });

      // Check if batch is complete (every N trades)
      const tradesInBatch = this.tradeCounter % this.batchTracker.batchSize;
    if (tradesInBatch === 0) {
      this.buffer.push({
        timestamp: getCurrentTimestamp(),
        event: 'BATCH_END',
        batchId,
      });
    }
  }

  /**
   * Close logger and flush remaining events
   */
  async close(): Promise<void> {
    await this.flusher.close();
  }
}

// Global instance
const ENABLE_TRADE_LOGGING = process.env.ENABLE_TRADE_LOGGING !== 'false';
const BATCH_SIZE = parseInt(process.env.TRADE_BATCH_SIZE || '10', 10);

export const tradeLogger = new TradeLogger(ENABLE_TRADE_LOGGING, BATCH_SIZE);

