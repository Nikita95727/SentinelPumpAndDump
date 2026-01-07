import { Strategy } from './strategy.interface';
import { TokenType, StrategyContext, EntryParams, MonitorDecision, ExitPlan, Position } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { getCurrentTimestamp } from '../utils';

/**
 * MID Strategy
 * 
 * Характеристики:
 * - Вход при multiplier >= 1.12
 * - Liquidity >= 1000 USD
 * - Take-profit: 1.35x
 * - Stop-loss: -10%
 * - Timeout: 45s
 * - Цель: микроприбыль, высокая частота
 */
export class MidStrategy implements Strategy {
  type: TokenType = 'MID';

  shouldEnter(ctx: StrategyContext): { enter: boolean; reason: string } {
    // MID входит если multiplier >= 1.12 и liquidity >= 1000
    if (ctx.metrics.multiplier >= 1.12 && ctx.metrics.liquidityUSD >= 1000) {
      return {
        enter: true,
        reason: `MID entry: ${ctx.metrics.multiplier.toFixed(2)}x, liquidity=$${ctx.metrics.liquidityUSD.toFixed(2)}`,
      };
    }

    return {
      enter: false,
      reason: `MID not ready: multiplier=${ctx.metrics.multiplier.toFixed(2)}x < 1.12 or liquidity=$${ctx.metrics.liquidityUSD.toFixed(2)} < $1000`,
    };
  }

  entryParams(ctx: StrategyContext, availableBalance: number): EntryParams {
    // MID: стандартный размер позиции
    const positionSize = Math.min(0.01, availableBalance * 0.12); // 12% баланса, макс 0.01 SOL
    const minSize = 0.004;

    return {
      positionSize: Math.max(positionSize, minSize),
      stopLossPct: 10, // -10%
      takeProfitMultiplier: 1.35, // 1.35x
      timeoutSeconds: 45, // 45 секунд
      trailingStopPct: undefined, // не используем trailing stop
    };
  }

  monitorTick(position: Position, ctx: StrategyContext): MonitorDecision {
    const now = Date.now();
    const age = now - position.entryTime;
    const currentPrice = ctx.currentPrice || 0;

    if (!currentPrice || currentPrice <= 0) {
      return { action: 'hold', reason: 'Waiting for price data' };
    }

    const multiplier = currentPrice / position.entryPrice;

    // 1. Take-profit (1.35x)
    if (multiplier >= 1.35) {
      return {
        action: 'exit',
        reason: `MID take-profit (${multiplier.toFixed(2)}x)`,
        exitNow: true,
      };
    }

    // 2. Stop-loss (-10%)
    if (multiplier < 0.90) {
      return {
        action: 'exit',
        reason: `MID stop-loss (${((multiplier - 1) * 100).toFixed(1)}%)`,
        exitNow: true,
      };
    }

    // 3. Timeout (45s)
    if (age > 45_000) {
      return {
        action: 'exit',
        reason: `MID timeout (${(age / 1000).toFixed(0)}s)`,
        exitNow: true,
      };
    }

    return { action: 'hold', reason: 'MID monitoring' };
  }

  exitPlan(position: Position, ctx: StrategyContext, reason: string): ExitPlan {
    // MID: стандартный jito tip, средний slippage
    const isTakeProfit = reason.includes('take-profit');

    return {
      exitType: isTakeProfit ? 'take_profit' : 
                reason.includes('stop-loss') ? 'stop_loss' : 'timeout',
      jitoTip: config.jitoTipAmount,
      slippage: isTakeProfit ? 0.20 : 0.25, // 20-25% slippage
      urgent: !isTakeProfit, // stop-loss и timeout - срочные
    };
  }
}

