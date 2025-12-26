import * as fs from 'fs/promises';
import * as path from 'path';
import { TradeLog, DailyStats } from './types';
import { config } from './config';
import { getCurrentDateUTC, getCurrentTimestamp } from './utils';

class Logger {
  private currentDate: string;
  private logFileHandle: fs.FileHandle | null = null;
  private statsFileHandle: fs.FileHandle | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private dailyStats: DailyStats | null = null;

  constructor() {
    this.currentDate = getCurrentDateUTC();
    this.initializeStats();
  }

  private async initializeStats(): Promise<void> {
    try {
      await fs.mkdir(config.logDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create log directory:', error);
    }

    this.dailyStats = {
      date: this.currentDate,
      initialDeposit: config.initialDeposit,
      finalDeposit: config.initialDeposit,
      peakDeposit: config.initialDeposit,
      totalBatches: 0,
      winBatches: 0,
      avgBatchProfitPct: 0,
      totalTrades: 0,
      hitsAbove3x: 0,
      maxDrawdownPct: 0,
      totalProfitSol: 0,
      totalProfitUsd: 0,
    };

    // Запускаем периодическое сохранение статистики каждые 30 минут
    this.statsInterval = setInterval(() => {
      this.saveStats().catch(err => console.error('Failed to save stats:', err));
    }, 30 * 60 * 1000);
  }

  private async ensureLogFile(): Promise<void> {
    const today = getCurrentDateUTC();
    
    if (today !== this.currentDate) {
      // Дата сменилась, закрываем старый файл и открываем новый
      if (this.logFileHandle) {
        try {
          await this.logFileHandle.close();
        } catch (error) {
          console.error('Error closing log file:', error);
        }
        this.logFileHandle = null;
      }
      this.currentDate = today;
      await this.saveStats(); // Сохраняем финальную статистику за предыдущий день
      this.initializeStats(); // Инициализируем новую статистику
    }

    if (!this.logFileHandle) {
      const logFilePath = path.join(config.logDir, `trades-${this.currentDate}.jsonl`);
      try {
        this.logFileHandle = await fs.open(logFilePath, 'a');
      } catch (error) {
        console.error('Failed to open log file:', error);
        throw error;
      }
    }
  }

  async log(logEntry: TradeLog): Promise<void> {
    try {
      await this.ensureLogFile();
      
      if (!this.logFileHandle) {
        throw new Error('Log file handle is null');
      }

      const jsonLine = JSON.stringify(logEntry) + '\n';
      await this.logFileHandle.appendFile(jsonLine);

      // Дублируем в консоль для удобства
      this.logToConsole(logEntry);
    } catch (error) {
      console.error('Failed to write log:', error);
    }
  }

  private logToConsole(logEntry: TradeLog): void {
    const timestamp = logEntry.timestamp || getCurrentTimestamp();
    const time = new Date(timestamp).toLocaleTimeString();

    switch (logEntry.type) {
      case 'buy':
        console.log(`[${time}] BUY | Batch #${logEntry.batchId} | Token: ${logEntry.token?.substring(0, 8)}... | Invested: ${logEntry.investedSol?.toFixed(6)} SOL | Entry: $${logEntry.entryPrice?.toFixed(8)}`);
        break;
      case 'sell':
        console.log(`[${time}] SELL | Batch #${logEntry.batchId} | Token: ${logEntry.token?.substring(0, 8)}... | Exit: $${logEntry.exitPrice?.toFixed(8)} | ${logEntry.multiplier?.toFixed(2)}x | Profit: ${logEntry.profitSol?.toFixed(6)} SOL | Reason: ${logEntry.reason}`);
        break;
      case 'batch_start':
        console.log(`[${time}] BATCH START | Batch #${logEntry.batchId} | Deposit: ${logEntry.depositBefore?.toFixed(6)} SOL`);
        break;
      case 'batch_complete':
        console.log(`[${time}] BATCH COMPLETE | Batch #${logEntry.batchId} | Net Profit: ${logEntry.netProfitPct?.toFixed(2)}% | Deposit: ${logEntry.depositBefore?.toFixed(6)} → ${logEntry.depositAfter?.toFixed(6)} SOL`);
        break;
      case 'error':
        console.error(`[${time}] ERROR | ${logEntry.message}`);
        break;
      case 'warning':
        console.warn(`[${time}] WARNING | ${logEntry.message}`);
        break;
      case 'info':
        console.log(`[${time}] INFO | ${logEntry.message}`);
        break;
      default:
        console.log(`[${time}] ${JSON.stringify(logEntry)}`);
    }
  }

  updateStats(update: Partial<DailyStats>): void {
    if (!this.dailyStats) return;
    
    Object.assign(this.dailyStats, update);
    
    // Пересчитываем средний профит батчей
    if (this.dailyStats.totalBatches > 0) {
      // Это упрощенный расчет, реальный будет из логов
      // В реальной реализации можно хранить массив профитов батчей
    }
  }

  async saveStats(): Promise<void> {
    if (!this.dailyStats) return;

    try {
      const statsFilePath = path.join(config.logDir, `stats-daily-${this.dailyStats.date}.json`);
      await fs.writeFile(statsFilePath, JSON.stringify(this.dailyStats, null, 2));
    } catch (error) {
      console.error('Failed to save stats:', error);
    }
  }

  async close(): Promise<void> {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.logFileHandle) {
      await this.logFileHandle.close();
      this.logFileHandle = null;
    }

    await this.saveStats();
  }

  getDailyStats(): DailyStats | null {
    return this.dailyStats;
  }
}

export const logger = new Logger();

