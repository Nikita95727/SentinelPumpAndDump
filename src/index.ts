import { getConnection } from './utils';
import { TokenScanner } from './scanner';
import { TradingSimulator } from './simulator';
import { logger } from './logger';
import { getCurrentTimestamp, sleep, calculateDrawdown } from './utils';
import { config } from './config';

class PumpFunSniper {
  private scanner: TokenScanner | null = null;
  private simulator: TradingSimulator | null = null;
  private connection: Awaited<ReturnType<typeof getConnection>> | null = null;
  private positionCheckInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    console.log('Starting Pump.fun Sniper Simulator...');
    console.log(`Initial Deposit: ${config.initialDeposit} SOL ($${config.initialDeposit * config.solUsdRate})`);
    console.log(`Helius WS URL: ${config.heliusWsUrl.substring(0, 50)}...`);

    try {
      // Инициализируем соединение
      this.connection = await getConnection();
      console.log('Connected to Solana RPC');

      // Инициализируем симулятор
      this.simulator = new TradingSimulator(this.connection);
      
      // Восстанавливаем баланс из сохраненной статистики
      await this.simulator.restoreDeposit();
      
      await this.simulator.startNewBatch();
      console.log('Trading simulator initialized');

      // Инициализируем сканер
      this.scanner = new TokenScanner(async (candidate) => {
        await this.handleNewToken(candidate);
      });
      
      // Передаем ссылку на scanner в simulator для удаления из processingTokens
      if (this.simulator && this.scanner) {
        (this.simulator as any).scanner = this.scanner;
      }

      await this.scanner.start();
      console.log('Token scanner started');

      // Запускаем периодическую проверку позиций
      this.positionCheckInterval = setInterval(async () => {
        if (this.simulator && !this.isShuttingDown) {
          const checkStartTime = Date.now();
          await this.simulator.checkAndClosePositions();
          const checkDuration = Date.now() - checkStartTime;
          
          if (checkDuration > 1000) {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'warning',
              message: `Position check took ${checkDuration}ms (slow, >1000ms)`,
            });
          }
        }
      }, 5000); // Проверяем каждые 5 секунд
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Position check interval started: every 5 seconds`,
      });

      // Запускаем мониторинг статистики
      this.startStatsMonitoring();

      console.log('Pump.fun Sniper Simulator is running...');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: 'Sniper simulator started',
      });

      // Обработка сигналов для graceful shutdown
      this.setupGracefulShutdown();
    } catch (error) {
      console.error('Failed to start sniper:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to start sniper: ${error instanceof Error ? error.message : String(error)}`,
      });
      process.exit(1);
    }
  }

  private async handleNewToken(candidate: any): Promise<void> {
    if (!this.simulator || this.isShuttingDown) return;

    try {
      const added = await this.simulator.addCandidate(candidate);
      if (added) {
        console.log(`Added candidate to batch: ${candidate.mint.substring(0, 8)}...`);
      }
    } catch (error) {
      console.error('Error handling new token:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error handling new token ${candidate.mint}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private startStatsMonitoring(): void {
    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      message: `Stats monitoring started: every 10 minutes`,
    });

    setInterval(async () => {
      if (!this.simulator || this.isShuttingDown) return;

      const statsStartTime = Date.now();
      const currentDeposit = this.simulator.getCurrentDeposit();
      const peakDeposit = this.simulator.getPeakDeposit();
      const openPositions = this.simulator.getOpenPositionsCount();
      const drawdown = calculateDrawdown(currentDeposit, peakDeposit);

      // Логируем статистику каждые 10 минут
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Periodic stats: Deposit=${currentDeposit.toFixed(6)} SOL, Peak=${peakDeposit.toFixed(6)} SOL, Drawdown=${drawdown.toFixed(2)}%, Open Positions=${openPositions}, Profit=${((currentDeposit - config.initialDeposit) / config.initialDeposit * 100).toFixed(2)}%`,
      });

      // Обновляем статистику в logger
      const stats = logger.getDailyStats();
      if (stats) {
        const oldDeposit = stats.finalDeposit;
        stats.finalDeposit = currentDeposit;
        if (currentDeposit > stats.peakDeposit) {
          stats.peakDeposit = currentDeposit;
        }
        const maxDrawdown = calculateDrawdown(currentDeposit, stats.peakDeposit);
        if (maxDrawdown > stats.maxDrawdownPct) {
          stats.maxDrawdownPct = maxDrawdown;
        }

        const statsDuration = Date.now() - statsStartTime;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: `Stats updated: deposit change ${oldDeposit.toFixed(6)} → ${currentDeposit.toFixed(6)} SOL, maxDrawdown=${stats.maxDrawdownPct.toFixed(2)}%, duration: ${statsDuration}ms`,
        });
      }
    }, 10 * 60 * 1000); // Каждые 10 минут
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log(`\nReceived ${signal}. Starting graceful shutdown...`);

      // Останавливаем сканер
      if (this.scanner) {
        await this.scanner.stop();
        console.log('Scanner stopped');
      }

      // Останавливаем проверку позиций
      if (this.positionCheckInterval) {
        clearInterval(this.positionCheckInterval);
        this.positionCheckInterval = null;
      }

      // Закрываем все позиции
      if (this.simulator) {
        console.log('Closing all open positions...');
        await this.simulator.closeAllPositions();
        console.log('All positions closed');
      }

      // Сохраняем финальную статистику
      await logger.saveStats();
      const stats = logger.getDailyStats();
      if (stats) {
        console.log('\n=== Final Statistics ===');
        console.log(`Date: ${stats.date}`);
        console.log(`Initial Deposit: ${stats.initialDeposit.toFixed(6)} SOL`);
        console.log(`Final Deposit: ${stats.finalDeposit.toFixed(6)} SOL`);
        console.log(`Peak Deposit: ${stats.peakDeposit.toFixed(6)} SOL`);
        console.log(`Total Batches: ${stats.totalBatches}`);
        console.log(`Win Batches: ${stats.winBatches}`);
        console.log(`Max Drawdown: ${stats.maxDrawdownPct.toFixed(2)}%`);
        console.log(`Total Trades: ${stats.totalTrades}`);
        console.log(`Hits Above 3x: ${stats.hitsAbove3x}`);
      }

      // Закрываем logger
      await logger.close();
      console.log('Graceful shutdown complete');

      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// Запуск приложения
const app = new PumpFunSniper();
app.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

