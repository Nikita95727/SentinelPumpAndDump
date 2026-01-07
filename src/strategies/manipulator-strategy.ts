import { Strategy } from './strategy.interface';
import { TokenType, StrategyContext, EntryParams, MonitorDecision, ExitPlan, Position } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { getCurrentTimestamp } from '../utils';

/**
 * MANIPULATOR Strategy
 * 
 * Характеристики:
 * - Вход МОМЕНТАЛЬНО после классификации + readiness
 * - Малый размер позиции: 0.005–0.01 SOL
 * - Жесткий stop-loss: -10%
 * - Короткий timeout: 60s
 * - Выход по ослаблению импульса (2 тика подряд)
 * - SELL: Jito first, 1 fallback
 */
export class ManipulatorStrategy implements Strategy {
  type: TokenType = 'MANIPULATOR';

  shouldEnter(ctx: StrategyContext): { enter: boolean; reason: string } {
    // MANIPULATOR входит МОМЕНТАЛЬНО если прошёл классификацию
    // Никаких дополнительных проверок
    return {
      enter: true,
      reason: 'MANIPULATOR detected, immediate entry',
    };
  }

  entryParams(ctx: StrategyContext, availableBalance: number): EntryParams {
    // Малый размер позиции для манипуляторов
    const positionSize = Math.min(0.01, availableBalance * 0.1); // 10% баланса, макс 0.01 SOL
    const minSize = 0.005;

    return {
      positionSize: Math.max(positionSize, minSize),
      stopLossPct: 10, // -10%
      takeProfitMultiplier: undefined, // нет жесткого take-profit
      timeoutSeconds: 60, // 60 секунд
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

    // 1. Timeout (60s)
    if (age > 60_000) {
      return {
        action: 'exit',
        reason: `MANIPULATOR timeout (${(age / 1000).toFixed(0)}s)`,
        exitNow: true,
      };
    }

    // 2. Stop-loss (-10%)
    if (multiplier < 0.90) {
      return {
        action: 'exit',
        reason: `MANIPULATOR stop-loss (${((multiplier - 1) * 100).toFixed(1)}%)`,
        exitNow: true,
      };
    }

    // 3. Импульс: проверяем ослабление
    if (!position.impulse) {
      // Инициализируем impulse
      position.impulse = {
        velocity: 0,
        acceleration: 0,
        consecutiveDrops: 0,
      };
    }

    // Вычисляем velocity (скорость изменения цены)
    if (!position.priceHistory) {
      position.priceHistory = [];
    }

    position.priceHistory.push({ price: currentPrice, timestamp: now });

    // Оставляем только последние 3 цены
    if (position.priceHistory.length > 3) {
      position.priceHistory.shift();
    }

    if (position.priceHistory.length >= 2) {
      const prev = position.priceHistory[position.priceHistory.length - 2];
      const curr = position.priceHistory[position.priceHistory.length - 1];
      const timeDiff = (curr.timestamp - prev.timestamp) / 1000; // seconds
      const priceDiff = curr.price - prev.price;

      if (timeDiff > 0) {
        const velocity = priceDiff / timeDiff;
        position.impulse.velocity = velocity;

        // Если импульс отрицательный (цена падает)
        if (velocity < 0) {
          position.impulse.consecutiveDrops++;

          // Выход если 2 падения подряд
          if (position.impulse.consecutiveDrops >= 2) {
            return {
              action: 'exit',
              reason: `MANIPULATOR impulse weakening (${position.impulse.consecutiveDrops} drops)`,
              exitNow: true,
            };
          }
        } else {
          // Импульс положительный, сбрасываем счетчик
          position.impulse.consecutiveDrops = 0;
        }
      }
    }

    return { action: 'hold', reason: 'MANIPULATOR monitoring' };
  }

  exitPlan(position: Position, ctx: StrategyContext, reason: string): ExitPlan {
    // MANIPULATOR: Jito first, высокий приоритет
    return {
      exitType: reason.includes('stop-loss') ? 'stop_loss' : 
                reason.includes('timeout') ? 'timeout' : 'momentum_loss',
      jitoTip: config.jitoTipAmount, // используем стандартный tip
      slippage: 0.25, // 25% slippage для быстрого выхода
      urgent: true, // всегда срочный выход для манипуляторов
    };
  }
}

