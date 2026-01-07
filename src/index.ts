import { getConnection } from './utils';
import { TokenScanner } from './scanner';
import { PositionManagerNew } from './position-manager-new';
import { logger } from './logger';
import { tradeLogger } from './trade-logger';
import { getCurrentTimestamp, sleep, calculateDrawdown } from './utils';
import { config } from './config';
import { TokenCandidate } from './types';
import { createTradingAdapter } from './trading/adapter-factory';
import { ITradingAdapter } from './trading/trading-adapter.interface';
import { RealTradingAdapter } from './trading/real-trading-adapter';
import { telegramNotifier } from './telegram-notifier';
import { AntiHoneypotFilter } from './anti-honeypot-filter';
import { MetricsCollector } from './metrics-collector';
import { TokenClassifier } from './token-classifier';
import { StrategyRouter } from './strategy-router';

/**
 * NEW PIPELINE:
 * 
 * Scanner
 *  → AntiHoneypotFilter (REJECT if honeypot)
 *  → MetricsCollector (collect metrics)
 *  → TokenClassifier (classify: MANIPULATOR/GEM/MID/TRASH)
 *  → StrategyRouter (route to strategy)
 *  → PositionManager (orchestrate: slots, balance, readiness, buy, monitor)
 *  → ExecutionAdapter (paper | real, Jito)
 */
class PumpFunSniper {
  private scanner: TokenScanner | null = null;
  private positionManager: PositionManagerNew | null = null;
  private connection: Awaited<ReturnType<typeof getConnection>> | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private lastBalanceLogTime: number = 0;
  private adapter?: ITradingAdapter;
  private initialDeposit: number = 0;

  // NEW PIPELINE MODULES
  private antiHoneypotFilter: AntiHoneypotFilter | null = null;
  private metricsCollector: MetricsCollector | null = null;
  private tokenClassifier: TokenClassifier | null = null;
  private strategyRouter: StrategyRouter | null = null;

  async start(): Promise<void> {
    console.log('🚀 Starting Pump.fun Sniper Bot (REFACTORED PIPELINE)...');

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

        initialDeposit = await realAdapter.getBalance();
        this.initialDeposit = initialDeposit;
        console.log(`✅ Real wallet balance: ${initialDeposit.toFixed(6)} SOL ($${(initialDeposit * config.solUsdRate).toFixed(2)})`);

        const health = await realAdapter.healthCheck();
        if (!health.healthy) {
          console.warn(`⚠️ Wallet health warning: ${health.error}`);
        }
      } else {
        console.log('📄 Paper Trading Mode (Simulation)');
        console.log(`Initial Deposit: ${config.initialDeposit} SOL ($${(config.initialDeposit * config.solUsdRate).toFixed(2)})`);
        initialDeposit = config.initialDeposit;
        this.initialDeposit = initialDeposit;
      }

      // ====================================
      // ИНИЦИАЛИЗАЦИЯ NEW PIPELINE MODULES
      // ====================================
      
      console.log('\n🔧 Initializing pipeline modules...');
      
      // 1. AntiHoneypotFilter
      this.antiHoneypotFilter = new AntiHoneypotFilter(this.connection);
      console.log('✅ AntiHoneypotFilter initialized');

      // 2. MetricsCollector
      this.metricsCollector = new MetricsCollector(this.connection);
      console.log('✅ MetricsCollector initialized');

      // 3. TokenClassifier
      this.tokenClassifier = new TokenClassifier();
      console.log('✅ TokenClassifier initialized');

      // 4. StrategyRouter
      this.strategyRouter = new StrategyRouter();
      console.log('✅ StrategyRouter initialized');

      // 5. PositionManager (оркестратор)
      this.positionManager = new PositionManagerNew(
        this.connection,
        initialDeposit,
        this.adapter
      );
      console.log('✅ PositionManager initialized (orchestrator)');

      console.log('✅ All pipeline modules initialized\n');

      // Инициализируем сканер
      this.scanner = new TokenScanner(async (candidate: TokenCandidate) => {
        await this.handleNewToken(candidate);
      });

      await this.scanner.start();
      console.log('✅ Token scanner started');

      // Периодическая статистика
      this.statsInterval = setInterval(() => {
        if (this.positionManager && !this.isShuttingDown) {
          const stats = this.positionManager.getStats();
          if (stats.activePositions > 0) {
            console.log('\n📊 === ACTIVE POSITIONS ===');
            stats.positions.forEach(p => {
              console.log(`   ${p.token}: ${p.multiplier} (${p.age})`);
            });
            console.log(`   Available slots: ${stats.availableSlots}/${config.maxOpenPositions}`);
            const deposit = this.positionManager.getCurrentDepositSync();
            console.log(`   Deposit: ${deposit.toFixed(6)} SOL`);
            console.log(`   Peak: ${this.positionManager.getPeakDeposit().toFixed(6)} SOL\n`);
          }
        }
      }, 10_000);

      console.log('✅ Pump.fun Sniper Bot is running (REFACTORED PIPELINE)...');
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: 'Sniper bot started (refactored pipeline)',
      });

      this.setupGracefulShutdown();

      await telegramNotifier.notifyBotStarted(
        this.positionManager.getStats().activePositions > 0 ? await this.positionManager.getCurrentDeposit() : initialDeposit,
        config.tradingMode,
        config
      );

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
   * NEW PIPELINE: handleNewToken
   * 
   * Scanner → AntiHoneypotFilter → MetricsCollector → TokenClassifier → StrategyRouter → PositionManager
   */
  private async handleNewToken(candidate: TokenCandidate): Promise<void> {
    if (!this.positionManager || !this.antiHoneypotFilter || !this.metricsCollector || 
        !this.tokenClassifier || !this.strategyRouter || this.isShuttingDown) {
      return;
    }

    // Проверяем баланс
    if (!this.positionManager.hasEnoughBalanceForTrading()) {
      const now = Date.now();
      if (!this.lastBalanceLogTime || (now - this.lastBalanceLogTime) > 60000) {
        const deposit = this.positionManager.getCurrentDepositSync();
        const required = 0.004692;
        console.log(`[${new Date().toLocaleTimeString()}] INFO | Insufficient balance for trading. Current deposit: ${deposit.toFixed(6)} SOL, Required: ${required.toFixed(6)} SOL`);
        this.lastBalanceLogTime = now;
      }
      return;
    }

    try {
      // =====================================
      // STEP 1: ANTI-HONEYPOT FILTER (REJECT)
      // =====================================
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🔍 [PIPELINE STEP 1/5] ANTI-HONEYPOT CHECK: ${candidate.mint.substring(0, 8)}...`,
      });

      const honeypotResult = await this.antiHoneypotFilter.check(candidate);
      
      if (!honeypotResult.passed) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `❌ FILTER_REJECT: ${honeypotResult.reason}`,
        });

        // CANDIDATE_FLOW лог
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `📋 CANDIDATE_FLOW: ${candidate.mint.substring(0, 8)}... | REJECTED at ANTI-HONEYPOT | reason: ${honeypotResult.reason}`,
        });
        return;
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ [STEP 1/5] ANTI-HONEYPOT PASSED: ${honeypotResult.uniqueBuyers} unique buyers`,
      });

      // =====================================
      // STEP 2: METRICS COLLECTOR
      // =====================================
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `📊 [PIPELINE STEP 2/5] METRICS COLLECTION: ${candidate.mint.substring(0, 8)}...`,
      });

      const metrics = await this.metricsCollector.collectMetrics(candidate);
      
      if (!metrics) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `❌ FILTER_REJECT: Metrics collection failed`,
        });

        // CANDIDATE_FLOW лог
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `📋 CANDIDATE_FLOW: ${candidate.mint.substring(0, 8)}... | REJECTED at METRICS | reason: metrics collection failed`,
        });
        return;
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ [STEP 2/5] METRICS COLLECTED: price=${metrics.price.toFixed(10)}, multiplier=${metrics.multiplier.toFixed(2)}x, liquidity=$${metrics.liquidityUSD.toFixed(2)}, marketCap=$${metrics.marketCapUSD.toFixed(2)}`,
      });

      // =====================================
      // STEP 3: TOKEN CLASSIFIER
      // =====================================
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🏷️ [PIPELINE STEP 3/5] TOKEN CLASSIFICATION: ${candidate.mint.substring(0, 8)}...`,
      });

      const classified = this.tokenClassifier.classify(candidate, metrics);

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ [STEP 3/5] CLASSIFIED: ${classified.type} | multiplier=${metrics.multiplier.toFixed(2)}x, liquidity=$${metrics.liquidityUSD.toFixed(2)}, marketCap=$${metrics.marketCapUSD.toFixed(2)}`,
      });

      // =====================================
      // STEP 4: STRATEGY ROUTER
      // =====================================
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🎯 [PIPELINE STEP 4/5] STRATEGY ROUTING: ${candidate.mint.substring(0, 8)}... | type=${classified.type}`,
      });

      const strategy = this.strategyRouter.getStrategy(classified);

      if (!strategy) {
        // TRASH токен - не торгуем
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `🗑️ NOT TRADING: ${classified.type}`,
        });

        // CANDIDATE_FLOW лог
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          token: candidate.mint,
          message: `📋 CANDIDATE_FLOW: ${candidate.mint.substring(0, 8)}... | type=${classified.type} | NOT TRADING (TRASH)`,
        });
        return;
      }

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `✅ [STEP 4/5] STRATEGY SELECTED: ${strategy.type}`,
      });

      // =====================================
      // STEP 5: POSITION MANAGER (ORCHESTRATE)
      // =====================================
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🚀 [PIPELINE STEP 5/5] POSITION MANAGER: ${candidate.mint.substring(0, 8)}... | strategy=${classified.type}`,
      });

      // CANDIDATE_FLOW лог (полный путь)
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `📋 CANDIDATE_FLOW: ${candidate.mint.substring(0, 8)}... | ANTI-HONEYPOT ✅ → METRICS ✅ → CLASSIFIED: ${classified.type} → STRATEGY: ${strategy.type} → POSITION_MANAGER`,
      });

      // Передаем в PositionManager вместе со стратегией и классификацией
      await this.positionManager.tryOpenPosition(candidate, classified, strategy);

      // Notify Telegram
      telegramNotifier.notifyTokenDetected(
        candidate.mint,
        classified.type as 'GEM' | 'MANIPULATOR' | 'CANDIDATE',
        metrics.liquidityUSD
      ).catch(() => {});

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

      if (this.scanner) {
        await this.scanner.stop();
        console.log('✅ Scanner stopped');
      }

      if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
      }

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

      await logger.saveStats();
      const stats = logger.getDailyStats();
      if (stats && this.positionManager) {
        let finalDeposit: number;
        let peakDeposit: number;

        if (this.adapter && this.adapter.getMode() === 'real') {
          const realAdapter = this.adapter as RealTradingAdapter;
          finalDeposit = await realAdapter.getBalance();
          peakDeposit = this.positionManager.getPeakDeposit();

          console.log('\n=== Final Statistics (REAL TRADING) ===');
          console.log(`Date: ${stats.date}`);
          console.log(`Initial Deposit (Real Wallet): ${this.initialDeposit.toFixed(6)} SOL`);
          console.log(`Final Deposit (Real Wallet): ${finalDeposit.toFixed(6)} SOL`);
          console.log(`Peak Deposit (Tracked): ${peakDeposit.toFixed(6)} SOL`);
        } else {
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

