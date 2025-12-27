import { getConnection } from './utils';
import { TokenScanner } from './scanner';
import { PositionManager } from './position-manager';
import { logger } from './logger';
import { tradeLogger } from './trade-logger';
import { getCurrentTimestamp, sleep, calculateDrawdown } from './utils';
import { config } from './config';
import { TokenCandidate } from './types';
import { RealTradingAdapter } from './real-trading-adapter';

class PumpFunSniper {
  private scanner: TokenScanner | null = null;
  private positionManager: PositionManager | null = null;
  private connection: Awaited<ReturnType<typeof getConnection>> | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private lastBalanceLogTime: number = 0;
  private realTradingAdapter?: RealTradingAdapter;

  async start(): Promise<void> {
    console.log('🚀 Starting Pump.fun Sniper Bot (Optimized)...');
    console.log(`Helius WS URL: ${config.heliusWsUrl.substring(0, 50)}...`);

    try {
      // Инициализируем соединение
      this.connection = await getConnection();
      console.log('✅ Connected to Solana RPC');

      let initialDeposit = config.initialDeposit;

      // 🔴 REAL TRADING MODE
      if (config.realTradingEnabled) {
        console.log('\n🔴 ===============================================');
        console.log('🔴 REAL TRADING MODE ENABLED');
        console.log('🔴 ===============================================\n');

        if (!config.walletMnemonic) {
          throw new Error('❌ WALLET_MNEMONIC not set in .env, but REAL_TRADING_ENABLED=true');
        }

        this.realTradingAdapter = new RealTradingAdapter(this.connection);
        const success = await this.realTradingAdapter.initialize(config.walletMnemonic);

        if (!success) {
          throw new Error('❌ Failed to initialize real trading wallet');
        }

        // Получаем реальный баланс из кошелька
        initialDeposit = await this.realTradingAdapter.getBalance();
        console.log(`✅ Real wallet balance: ${initialDeposit.toFixed(6)} SOL ($${(initialDeposit * config.solUsdRate).toFixed(2)})`);

        // Health check
        const health = await this.realTradingAdapter.healthCheck();
        if (!health.healthy) {
          console.warn(`⚠️ Wallet health warning: ${health.error}`);
        }
      } else {
        console.log('📄 Paper Trading Mode (Simulation)');
        console.log(`Initial Deposit: ${config.initialDeposit} SOL ($${(config.initialDeposit * config.solUsdRate).toFixed(2)})`);
        initialDeposit = config.initialDeposit;
      }

      // Инициализируем PositionManager с optional real trading adapter
      this.positionManager = new PositionManager(
        this.connection,
        initialDeposit,
        this.realTradingAdapter
      );
      console.log(`✅ Position Manager initialized with ${initialDeposit.toFixed(6)} SOL`);

      // Инициализируем сканер
      this.scanner = new TokenScanner(async (candidate: TokenCandidate) => {
        await this.handleNewToken(candidate);
      });

      await this.scanner.start();
      console.log('✅ Token scanner started');

      // Периодическая статистика (каждые 10 секунд)
      this.statsInterval = setInterval(() => {
        if (this.positionManager && !this.isShuttingDown) {
          const stats = this.positionManager.getStats();
          if (stats.activePositions > 0) {
            console.log('\n📊 === ACTIVE POSITIONS ===');
            stats.positions.forEach(p => {
              console.log(`   ${p.token}: ${p.multiplier} (${p.age})`);
            });
            console.log(`   Available slots: ${stats.availableSlots}/${config.maxOpenPositions}`);
            console.log(`   Deposit: ${this.positionManager.getCurrentDeposit().toFixed(6)} SOL`);
            console.log(`   Peak: ${this.positionManager.getPeakDeposit().toFixed(6)} SOL\n`);
          }
        }
      }, 10_000);

      console.log('✅ Pump.fun Sniper Bot is running...');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: 'Sniper bot started (optimized version)',
      });

      // Обработка сигналов для graceful shutdown
      this.setupGracefulShutdown();
    } catch (error) {
      console.error('❌ Failed to start sniper:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to start sniper: ${error instanceof Error ? error.message : String(error)}`,
      });
      process.exit(1);
    }
  }

  private async handleNewToken(candidate: TokenCandidate): Promise<void> {
    if (!this.positionManager || this.isShuttingDown) return;

    // Проверяем баланс перед обработкой токена
    // Если баланса нет, не обрабатываем токен (не засоряем очередь)
    if (!this.positionManager.hasEnoughBalanceForTrading()) {
      // Логируем периодически для диагностики
      const now = Date.now();
      if (!this.lastBalanceLogTime || (now - this.lastBalanceLogTime) > 60000) { // Раз в минуту
        // Получаем детальную информацию о балансе для диагностики
        const deposit = this.positionManager.getCurrentDeposit();
        const required = 0.004692; // Минимальный требуемый резерв
        console.log(`[${new Date().toLocaleTimeString()}] INFO | Insufficient balance for trading. Current deposit: ${deposit.toFixed(6)} SOL, Required: ${required.toFixed(6)} SOL, Has enough: ${deposit >= required}`);
        this.lastBalanceLogTime = now;
      }
      return;
    }

    try {
      // Пытаемся открыть позицию (НЕ ждем батч!)
      await this.positionManager.tryOpenPosition(candidate);
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

      // Ждем закрытия всех позиций
      if (this.positionManager) {
        let stats = this.positionManager.getStats();
        while (stats.activePositions > 0) {
          console.log(`⏳ Waiting for ${stats.activePositions} positions to close...`);
          await sleep(2000);
          stats = this.positionManager.getStats();
        }
        
        console.log('Closing all remaining positions...');
        await this.positionManager.closeAllPositions();
        console.log('✅ All positions closed');
      }

      // Сохраняем финальную статистику
      await logger.saveStats();
      const stats = logger.getDailyStats();
      if (stats && this.positionManager) {
        const finalDeposit = this.positionManager.getCurrentDeposit();
        const peakDeposit = this.positionManager.getPeakDeposit();
        
        console.log('\n=== Final Statistics ===');
        console.log(`Date: ${stats.date}`);
        console.log(`Initial Deposit: ${config.initialDeposit.toFixed(6)} SOL`);
        console.log(`Final Deposit: ${finalDeposit.toFixed(6)} SOL`);
        console.log(`Peak Deposit: ${peakDeposit.toFixed(6)} SOL`);
        console.log(`Total Trades: ${stats.totalTrades}`);
        console.log(`Hits Above 3x: ${stats.hitsAbove3x}`);
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
const app = new PumpFunSniper();
app.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

