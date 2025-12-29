/**
 * Gem Simulator Index - Запуск симулятора стратегии выявления самородков
 * 
 * Используется для тестирования гипотезы на реальных данных
 * Детальное неблокирующее логирование для анализа закономерностей
 */

import { getConnection } from './utils';
import { TokenScanner } from './scanner';
import { logger } from './logger';
import { tradeLogger } from './trade-logger';
import { getCurrentTimestamp, sleep, calculateDrawdown } from './utils';
import { config } from './config';
import { TokenCandidate } from './types';
import { GemSimulator } from './gem-simulator';

class GemSimulatorApp {
  private scanner: TokenScanner | null = null;
  private gemSimulator: GemSimulator | null = null;
  private connection: Awaited<ReturnType<typeof getConnection>> | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private initialDeposit: number = 0;

  async start(): Promise<void> {
    console.log('💎 Starting Gem Simulator (GEM DETECTION STRATEGY)...');
    
    // Показываем информацию о режиме сети
    const { getNetworkInfo } = await import('./config');
    const networkInfo = getNetworkInfo();
    console.log(`\n🌐 Network Mode: ${networkInfo.mode.toUpperCase()}`);
    console.log(`   Program ID: ${networkInfo.programId}`);
    console.log(`   WS URL: ${networkInfo.wsUrl.substring(0, 60)}...`);
    console.log(`   HTTP URL: ${networkInfo.httpUrl.substring(0, 60)}...\n`);

    try {
      // Инициализируем соединение
      this.connection = await getConnection();
      console.log('✅ Connected to Solana RPC');

      // Инициализируем Gem Simulator
      this.gemSimulator = new GemSimulator(this.connection);
      this.initialDeposit = config.initialDeposit;
      
      console.log(`✅ Gem Simulator initialized with ${this.initialDeposit.toFixed(6)} SOL`);
      console.log('📊 Strategy: Monitor tokens → Detect gems → Enter only confirmed gems → Exit on momentum reversal');

      // Запускаем симулятор
      await this.gemSimulator.start();

      // Инициализируем сканер
      this.scanner = new TokenScanner(async (candidate: TokenCandidate) => {
        await this.handleNewToken(candidate);
      });

      await this.scanner.start();
      console.log('✅ Token scanner started');

      // Периодическая статистика (каждые 60 секунд)
      this.statsInterval = setInterval(() => {
        if (this.gemSimulator && !this.isShuttingDown) {
          const deposit = this.gemSimulator.getCurrentDeposit();
          const peak = this.gemSimulator.getPeakDeposit();
          const stats = this.gemSimulator.getStats();
          
          console.log('\n📊 === GEM SIMULATOR STATS ===');
          console.log(`   Monitored: ${stats.totalMonitored}`);
          console.log(`   Gems Detected: ${stats.gemsDetected} (${stats.totalMonitored > 0 ? (stats.gemsDetected / stats.totalMonitored * 100).toFixed(1) : 0}%)`);
          console.log(`   Positions Opened: ${stats.positionsOpened}`);
          console.log(`   Positions Closed: ${stats.positionsClosed}`);
          console.log(`   Profitable: ${stats.profitableTrades}, Losing: ${stats.losingTrades}`);
          console.log(`   Win Rate: ${stats.positionsClosed > 0 ? (stats.profitableTrades / stats.positionsClosed * 100).toFixed(1) : 0}%`);
          console.log(`   Avg Entry Multiplier: ${stats.avgEntryMultiplier.toFixed(3)}x`);
          console.log(`   Avg Exit Multiplier: ${stats.avgExitMultiplier.toFixed(3)}x`);
          console.log(`   Total Profit: ${stats.totalProfitSol.toFixed(6)} SOL`);
          console.log(`   Deposit: ${deposit.toFixed(6)} SOL (${((deposit - this.initialDeposit) / this.initialDeposit * 100).toFixed(2)}%)`);
          console.log(`   Peak: ${peak.toFixed(6)} SOL\n`);
        }
      }, 60000);

      console.log('✅ Gem Simulator is running...');
      console.log('📝 All events are logged to files for analysis');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: 'Gem Simulator started (GEM DETECTION STRATEGY)',
      });

      // Обработка сигналов для graceful shutdown
      this.setupGracefulShutdown();
    } catch (error) {
      console.error('❌ Failed to start gem simulator:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to start gem simulator: ${error instanceof Error ? error.message : String(error)}`,
      });
      process.exit(1);
    }
  }

  private async handleNewToken(candidate: TokenCandidate): Promise<void> {
    if (!this.gemSimulator || this.isShuttingDown) return;

    try {
      // Добавляем токен для мониторинга (gem-simulator сам проверит honeypot)
      await this.gemSimulator.addTokenForMonitoring(candidate);
    } catch (error) {
      console.error(`[${new Date().toLocaleTimeString()}] ERROR | Error handling new token ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error handling new token ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

      // Останавливаем сканер
      if (this.scanner) {
        await this.scanner.stop();
        console.log('✅ Scanner stopped');
      }

      // Останавливаем статистику
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }

      // Останавливаем симулятор (закроет все позиции)
      if (this.gemSimulator) {
        await this.gemSimulator.stop();
        console.log('✅ Gem Simulator stopped');
      }

      // Сохраняем финальную статистику
      await logger.saveStats();
      
      if (this.gemSimulator) {
        const finalDeposit = this.gemSimulator.getCurrentDeposit();
        const peakDeposit = this.gemSimulator.getPeakDeposit();
        const stats = this.gemSimulator.getStats();
        
        console.log('\n=== Final Statistics (GEM SIMULATOR) ===');
        console.log(`Initial Deposit: ${this.initialDeposit.toFixed(6)} SOL`);
        console.log(`Final Deposit: ${finalDeposit.toFixed(6)} SOL`);
        console.log(`Peak Deposit: ${peakDeposit.toFixed(6)} SOL`);
        console.log(`Total Monitored: ${stats.totalMonitored}`);
        console.log(`Gems Detected: ${stats.gemsDetected} (${stats.totalMonitored > 0 ? (stats.gemsDetected / stats.totalMonitored * 100).toFixed(1) : 0}%)`);
        console.log(`Positions Opened: ${stats.positionsOpened}`);
        console.log(`Positions Closed: ${stats.positionsClosed}`);
        console.log(`Profitable: ${stats.profitableTrades}, Losing: ${stats.losingTrades}`);
        console.log(`Win Rate: ${stats.positionsClosed > 0 ? (stats.profitableTrades / stats.positionsClosed * 100).toFixed(1) : 0}%`);
        console.log(`Avg Entry Multiplier: ${stats.avgEntryMultiplier.toFixed(3)}x`);
        console.log(`Avg Exit Multiplier: ${stats.avgExitMultiplier.toFixed(3)}x`);
        console.log(`Avg Hold Time: ${stats.avgHoldTime.toFixed(1)}s`);
        console.log(`Total Profit: ${stats.totalProfitSol.toFixed(6)} SOL`);
        console.log(`Max Drawdown: ${calculateDrawdown(finalDeposit, peakDeposit).toFixed(2)}%`);
      }

      // Закрываем loggers
      await logger.close();
      await tradeLogger.close();
      console.log('✅ Graceful shutdown complete');

      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// Запуск приложения
const app = new GemSimulatorApp();
app.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

