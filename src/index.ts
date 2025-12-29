/**
 * CEX Scalper - Bybit Spot Trading Bot
 * Машинный скальпер для высоколиквидных пар на Bybit Spot
 */

import { BybitClient } from './bybit-client';
import { MarketScanner, TradingPair } from './market-scanner';
import { PairWatcher, MomentumSignal } from './pair-watcher';
import { CEXPositionManager } from './cex-position-manager';
import { logger } from './logger';
import { getCurrentTimestamp, sleep, calculateDrawdown } from './utils';
import { config } from './config';

class CEXScalper {
  private bybitClient: BybitClient | null = null;
  private marketScanner: MarketScanner | null = null;
  private pairWatchers: Map<string, PairWatcher> = new Map();
  private positionManager: CEXPositionManager | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private initialDeposit: number = 0;

  async start(): Promise<void> {
    console.log('🚀 Starting CEX Scalper (Bybit Spot)...');
    console.log(`📊 Strategy: High liquidity pairs → Momentum detection → Scalp 0.5-2% → Exit on fade`);

    try {
      // Инициализируем Bybit клиент
      this.bybitClient = new BybitClient();
      console.log('✅ Bybit client initialized');

      // Получаем начальный баланс
      if (config.realTradingEnabled) {
        this.initialDeposit = await this.bybitClient.getBalance('USDT');
        console.log(`✅ Real trading enabled, balance: ${this.initialDeposit.toFixed(2)} USDT`);
      } else {
        this.initialDeposit = config.initialDeposit;
        console.log(`📄 Paper trading mode, initial deposit: ${this.initialDeposit.toFixed(2)} USD`);
      }

      // Инициализируем Position Manager
      this.positionManager = new CEXPositionManager(this.bybitClient, this.initialDeposit);
      this.positionManager.startMonitoring();
      console.log('✅ Position Manager initialized');

      // Инициализируем Market Scanner
      this.marketScanner = new MarketScanner(this.bybitClient);
      this.marketScanner.setOnPairsDetected(async (pairs: TradingPair[]) => {
        await this.handlePairsDetected(pairs);
      });
      await this.marketScanner.start(5); // Сканирование каждые 5 минут
      console.log('✅ Market Scanner started');

      // Периодическая статистика (каждые 60 секунд)
      this.statsInterval = setInterval(() => {
        if (this.positionManager && !this.isShuttingDown) {
          const stats = this.positionManager.getStats();
          const deposit = this.positionManager.getCurrentDepositSync();
          const peak = this.positionManager.getPeakDeposit();
          const riskState = this.positionManager.getRiskManager().getRiskState();
          
          console.log('\n📊 === TRADING STATS ===');
          console.log(`   Active Positions: ${stats.activePositions}/${config.maxOpenPositions}`);
          console.log(`   Watched Pairs: ${this.pairWatchers.size}`);
          console.log(`   Deposit: ${deposit.toFixed(2)} USD (${((deposit - this.initialDeposit) / this.initialDeposit * 100).toFixed(2)}%)`);
          console.log(`   Peak: ${peak.toFixed(2)} USD`);
          console.log(`   Risk: CanTrade=${riskState.canTrade}, DailyTrades=${riskState.dailyTradesCount}, ConsecutiveLosses=${riskState.consecutiveLosses}, Drawdown=${riskState.currentDrawdown.toFixed(2)}%`);
          if (stats.positions.length > 0) {
            console.log(`   Positions:`);
            stats.positions.forEach(p => {
              console.log(`     ${p.symbol}: ${p.multiplier}x (${p.age})`);
            });
          }
          console.log('');
        }
      }, 60000);

      console.log('✅ CEX Scalper is running...');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: 'CEX Scalper started',
      });

      // Обработка сигналов для graceful shutdown
      this.setupGracefulShutdown();
    } catch (error) {
      console.error('❌ Failed to start bot:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to start bot: ${error instanceof Error ? error.message : String(error)}`,
      });
      process.exit(1);
    }
  }

  /**
   * Обрабатывает найденные пары от Market Scanner
   */
  private async handlePairsDetected(pairs: TradingPair[]): Promise<void> {
    if (!this.positionManager || this.isShuttingDown) return;

    // Останавливаем watchers для пар, которых больше нет в топе
    const currentSymbols = new Set(pairs.map(p => p.symbol));
    for (const [symbol, watcher] of this.pairWatchers.entries()) {
      if (!currentSymbols.has(symbol)) {
        watcher.stop();
        this.pairWatchers.delete(symbol);
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          symbol,
          message: `👁️ Stopped watching ${symbol} (removed from top pairs)`,
        });
      }
    }

    // Запускаем watchers для новых пар
    for (const pair of pairs) {
      if (!this.pairWatchers.has(pair.symbol)) {
        const watcher = new PairWatcher(pair.symbol, this.bybitClient!);
        watcher.setOnMomentumDetected(async (symbol: string, signal: MomentumSignal) => {
          if (this.positionManager && !this.isShuttingDown) {
            await this.positionManager.openPosition(symbol, signal);
          }
        });
        await watcher.start();
        this.pairWatchers.set(pair.symbol, watcher);
        
      logger.log({
        timestamp: getCurrentTimestamp(),
          type: 'info',
          symbol: pair.symbol,
          message: `👁️ Started watching ${pair.symbol} | score=${pair.score.toFixed(3)}, volume=${(pair.volume24h / 1000000).toFixed(1)}M, spread=${pair.spread.toFixed(3)}%`,
      });
      }
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

      // Останавливаем сканер
      if (this.marketScanner) {
        this.marketScanner.stop();
        console.log('✅ Market Scanner stopped');
      }

      // Останавливаем watchers
      for (const [symbol, watcher] of this.pairWatchers.entries()) {
        watcher.stop();
      }
      console.log(`✅ Stopped ${this.pairWatchers.size} pair watchers`);

      // Останавливаем статистику
      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }

      // Останавливаем мониторинг позиций
      if (this.positionManager) {
        this.positionManager.stopMonitoring();
        
        // Закрываем все позиции
        console.log('Closing all positions...');
        await this.positionManager.closeAllPositions();
        console.log('✅ All positions closed');
      }

      // Сохраняем финальную статистику
      await logger.saveStats();
      
      if (this.positionManager) {
        const finalDeposit = this.positionManager.getCurrentDepositSync();
        const peakDeposit = this.positionManager.getPeakDeposit();
        
        console.log('\n=== Final Statistics ===');
        console.log(`Initial Deposit: ${this.initialDeposit.toFixed(2)} USD`);
        console.log(`Final Deposit: ${finalDeposit.toFixed(2)} USD`);
        console.log(`Peak Deposit: ${peakDeposit.toFixed(2)} USD`);
        console.log(`Total Return: ${((finalDeposit - this.initialDeposit) / this.initialDeposit * 100).toFixed(2)}%`);
        console.log(`Max Drawdown: ${calculateDrawdown(finalDeposit, peakDeposit).toFixed(2)}%`);
      }

      // Закрываем loggers
      await logger.close();
      console.log('✅ Graceful shutdown complete');

      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

// Запуск приложения
const app = new CEXScalper();
app.start().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
