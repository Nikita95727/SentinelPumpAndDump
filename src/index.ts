import { getConnection } from './utils';
import { TokenScanner } from './scanner';
import { PositionManager } from './position-manager';
import { logger } from './logger';
import { tradeLogger } from './trade-logger';
import { getCurrentTimestamp, sleep, calculateDrawdown } from './utils';
import { config } from './config';
import { TokenCandidate } from './types';
import { createTradingAdapter } from './trading/adapter-factory';
import { ITradingAdapter } from './trading/trading-adapter.interface';
import { RealTradingAdapter } from './trading/real-trading-adapter';
import { GemTracker } from './gem-tracker';
import { TokenFilters } from './filters';
import { ConcentratedLiquidityTracker } from './concentrated-liquidity-tracker';

class PumpFunSniper {
  private scanner: TokenScanner | null = null;
  private positionManager: PositionManager | null = null;
  private connection: Awaited<ReturnType<typeof getConnection>> | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private lastBalanceLogTime: number = 0;
  private adapter?: ITradingAdapter;
  private initialDeposit: number = 0; // Сохраняем реальный начальный баланс
  private gemTracker: GemTracker | null = null; // ⭐ Система выявления самородков
  private filters: TokenFilters | null = null; // Для honeypot check
  private concentratedLiquidityTracker: ConcentratedLiquidityTracker | null = null; // ⭐ Трекер токенов с концентрированной ликвидностью

  async start(): Promise<void> {
    console.log('🚀 Starting Pump.fun Sniper Bot (Optimized)...');
    
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

      let initialDeposit = config.initialDeposit;

      // Создаем торговый адаптер (real или paper)
      this.adapter = createTradingAdapter(this.connection, config.initialDeposit);

      if (config.tradingMode === 'real') {
        console.log('\n🔴 ===============================================');
        console.log('🔴 REAL TRADING MODE ENABLED');
        console.log('🔴 ===============================================\n');

        if (!config.walletMnemonic) {
          throw new Error('❌ WALLET_MNEMONIC not set in .env, but TRADING_MODE=real');
        }

        const realAdapter = this.adapter as RealTradingAdapter;
        const success = await realAdapter.initialize(config.walletMnemonic);

        if (!success) {
          throw new Error('❌ Failed to initialize real trading wallet');
        }

        // Получаем реальный баланс из кошелька
        initialDeposit = await realAdapter.getBalance();
        this.initialDeposit = initialDeposit; // Сохраняем для финальной статистики
        console.log(`✅ Real wallet balance: ${initialDeposit.toFixed(6)} SOL ($${(initialDeposit * config.solUsdRate).toFixed(2)})`);

        // Health check
        const health = await realAdapter.healthCheck();
        if (!health.healthy) {
          console.warn(`⚠️ Wallet health warning: ${health.error}`);
        }
      } else {
        console.log('📄 Paper Trading Mode (Simulation)');
        console.log(`Initial Deposit: ${config.initialDeposit} SOL ($${(config.initialDeposit * config.solUsdRate).toFixed(2)})`);
        initialDeposit = config.initialDeposit;
        this.initialDeposit = initialDeposit; // Сохраняем для финальной статистики
      }

      // Инициализируем PositionManager с адаптером
      this.positionManager = new PositionManager(
        this.connection,
        initialDeposit,
        this.adapter
      );
      console.log(`✅ Position Manager initialized with ${initialDeposit.toFixed(6)} SOL`);
      
      // ⭐ Восстанавливаем мониторинг загруженных активных позиций
      const loadedPositions = this.positionManager.getLoadedActivePositions();
      if (loadedPositions.length > 0) {
        console.log(`🔄 Restoring monitoring for ${loadedPositions.length} active positions...`);
        for (const position of loadedPositions) {
          // Создаем TokenCandidate из загруженной позиции
          const candidate: TokenCandidate = {
            mint: position.token,
            signature: (position as any).buySignature || '',
            timestamp: position.entryTime,
          };
          
          // Возобновляем мониторинг позиции
          this.positionManager.tryOpenPosition(candidate).catch(err => {
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'error',
              token: position.token,
              message: `❌ Failed to restore monitoring for position ${position.token.substring(0, 8)}...: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        }
        console.log(`✅ Monitoring restored for ${loadedPositions.length} positions`);
      }
      
      // ⭐ КРИТИЧНО: Очищаем pendingTierInfo в PositionManager
      // Это предотвращает использование старых данных о Tier между запусками
      this.positionManager.clearPendingTierInfo();

      // ⭐ Инициализируем фильтры для honeypot check
      this.filters = new TokenFilters(this.connection);
      this.concentratedLiquidityTracker = new ConcentratedLiquidityTracker(this.connection, this.filters);
      
      // ⭐ Инициализируем Gem Tracker (система выявления самородков)
      this.gemTracker = new GemTracker(this.connection, this.filters);
      this.gemTracker.setOnGemDetected(async (candidate: TokenCandidate, observation) => {
        // Когда самородок обнаружен - открываем позицию
        if (this.positionManager && !this.isShuttingDown) {
          logger.log({
            timestamp: getCurrentTimestamp(),
            type: 'info',
            token: candidate.mint,
            message: `💎 GEM TRIGGER: Opening position for detected gem ${candidate.mint.substring(0, 8)}... | multiplier=${(observation.currentPrice / observation.initialPrice).toFixed(3)}x, gemScore=${observation.gemScore.toFixed(3)}`,
          });
          await this.positionManager.tryOpenPosition(candidate);
        }
      });
      console.log('✅ Gem Tracker initialized (GEM DETECTION STRATEGY enabled)');

      // ⭐ КРИТИЧНО: Очищаем все кеши и структуры данных перед запуском
      // Это предотвращает повторную обработку токенов между запусками
      this.clearAllCaches();

      // Инициализируем сканер
      this.scanner = new TokenScanner(async (candidate: TokenCandidate) => {
        await this.handleNewToken(candidate);
      });

      await this.scanner.start();
      console.log('✅ Token scanner started (all caches cleared)');

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
            // Используем синхронную версию для периодической статистики (не блокируем)
            const deposit = this.positionManager.getCurrentDepositSync();
            console.log(`   Deposit: ${deposit.toFixed(6)} SOL`);
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

  /**
   * ⭐ КРИТИЧНО: Очищает все кеши и структуры данных перед запуском
   * Вызывается ПЕРЕД каждым запуском для предотвращения повторной обработки токенов
   * Это гарантирует, что бот не будет входить в одни и те же токены несколько раз
   */
  private clearAllCaches(): void {
    try {
      // Очищаем earlyActivityTracker (singleton) - наблюдения за ранней активностью
      const { earlyActivityTracker } = require('./early-activity-tracker');
      if (earlyActivityTracker && earlyActivityTracker.clearAll) {
        const observationsSize = earlyActivityTracker.clearAll();
        console.log(`   • EarlyActivityTracker: cleared ${observationsSize} observations`);
      }
      
      // Очищаем cache (singleton) - кеш фильтров и RPC запросов
      const { cache } = require('./cache');
      if (cache) {
        cache.clear().catch(() => {}); // Неблокирующая очистка
        console.log('   • Cache: cleared (memory + Redis if available)');
      }
      
      // Очищаем priceFetcher кеш (singleton) - кеш цен токенов
      const { priceFetcher } = require('./price-fetcher');
      if (priceFetcher && priceFetcher.clearCache) {
        priceFetcher.clearCache();
        console.log('   • PriceFetcher: cleared price cache');
      }
      
      console.log('✅ All caches and data structures cleared before startup');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: '🔄 All caches and data structures cleared before startup (earlyActivityTracker, cache, priceFetcher)',
      });
    } catch (error) {
      console.warn('⚠️ Warning: Error clearing some caches:', error instanceof Error ? error.message : String(error));
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: `Warning: Error clearing some caches: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleNewToken(candidate: TokenCandidate): Promise<void> {
    if (!this.positionManager || !this.gemTracker || !this.filters || this.isShuttingDown) return;

    // Проверяем баланс перед обработкой токена
    // Если баланса нет, не обрабатываем токен (не засоряем очередь)
    if (!this.positionManager.hasEnoughBalanceForTrading()) {
      // Логируем периодически для диагностики
      const now = Date.now();
      if (!this.lastBalanceLogTime || (now - this.lastBalanceLogTime) > 60000) { // Раз в минуту
        // Получаем детальную информацию о балансе для диагностики (используем синхронную версию)
        const deposit = this.positionManager.getCurrentDepositSync();
        const required = 0.004692; // Минимальный требуемый резерв
        console.log(`[${new Date().toLocaleTimeString()}] INFO | Insufficient balance for trading. Current deposit: ${deposit.toFixed(6)} SOL, Required: ${required.toFixed(6)} SOL, Has enough: ${deposit >= required}`);
        this.lastBalanceLogTime = now;
      }
      return;
    }

    try {
      // ⭐ НОВАЯ ЛОГИКА: Упрощенная фильтрация для поиска МАНИПУЛЯТОРОВ и ГЕМОВ
      // Фильтр ищет манипуляторов и гемов, а не отбрасывает их
      const filterResult = await this.filters.simplifiedFilter(candidate);
      
      if (!filterResult.passed) {
        // Токен не прошел фильтр (только honeypot или слишком низкая ликвидность)
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `❌ Token rejected: ${filterResult.reason || 'Unknown reason'}`,
        });
        return;
      }

      // ⭐ Токен прошел фильтр - определяем тип и отправляем в очередь для торговли
      const tokenType = filterResult.tokenType || 'REGULAR';
      candidate.tokenType = tokenType; // Сохраняем тип токена в candidate

      // Логируем тип токена
      const typeEmoji = tokenType === 'MANIPULATOR' ? '🎯' : (tokenType === 'GEM' ? '💎' : '📊');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `${typeEmoji} Token PASSED: Type=${tokenType}, Tier=${filterResult.tierInfo?.tier || 'N/A'}, liquidity=$${filterResult.details?.volumeUsd?.toFixed(2) || 'N/A'}, sending to position manager for entry`,
      });

      // ⭐ Отправляем в очередь для торговли (манипуляторы, гемы и обычные токены)
      if (this.positionManager && !this.isShuttingDown) {
        // ⭐ КРИТИЧНО: Сохраняем tierInfo в pendingTierInfo перед вызовом tryOpenPosition
        // Это необходимо, так как tierInfo используется в openPositionWithReadinessCheck
        if (filterResult.tierInfo) {
          this.positionManager.setPendingTierInfo(candidate.mint, filterResult.tierInfo);
        }
        await this.positionManager.tryOpenPosition(candidate);
      }
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

      // Останавливаем трекер концентрированной ликвидности
      if (this.concentratedLiquidityTracker) {
        this.concentratedLiquidityTracker.stop();
        console.log('✅ Concentrated liquidity tracker stopped');
      }

      // Сохраняем финальную статистику
      await logger.saveStats();
      const stats = logger.getDailyStats();
      if (stats && this.positionManager) {
        // В реальной торговле получаем баланс из кошелька, в симуляции - из PositionManager
        let finalDeposit: number;
        let peakDeposit: number;
        
        if (this.adapter && this.adapter.getMode() === 'real') {
          // 🔴 РЕАЛЬНАЯ ТОРГОВЛЯ: Используем реальный баланс кошелька
          const realAdapter = this.adapter as RealTradingAdapter;
          finalDeposit = await realAdapter.getBalance();
          peakDeposit = this.positionManager.getPeakDeposit(); // Peak из PositionManager (может быть выше реального)
          
          console.log('\n=== Final Statistics (REAL TRADING) ===');
          console.log(`Date: ${stats.date}`);
          console.log(`Initial Deposit (Real Wallet): ${this.initialDeposit.toFixed(6)} SOL`);
          console.log(`Final Deposit (Real Wallet): ${finalDeposit.toFixed(6)} SOL`);
          console.log(`Peak Deposit (Tracked): ${peakDeposit.toFixed(6)} SOL`);
        } else {
          // 📄 СИМУЛЯЦИЯ: Используем баланс из PositionManager
          finalDeposit = await this.positionManager.getCurrentDeposit();
          peakDeposit = this.positionManager.getPeakDeposit();
          
          console.log('\n=== Final Statistics (SIMULATION) ===');
          console.log(`Date: ${stats.date}`);
          console.log(`Initial Deposit: ${this.initialDeposit.toFixed(6)} SOL`);
          console.log(`Final Deposit: ${finalDeposit.toFixed(6)} SOL`);
          console.log(`Peak Deposit: ${peakDeposit.toFixed(6)} SOL`);
        }
        
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

