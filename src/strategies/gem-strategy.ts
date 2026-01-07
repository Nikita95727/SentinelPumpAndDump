import { Strategy } from './strategy.interface';
import { TokenType, StrategyContext, EntryParams, MonitorDecision, ExitPlan, Position } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { getCurrentTimestamp } from '../utils';

/**
 * GEM Strategy
 * 
 * Характеристики:
 * - Вход при multiplier >= 2.0x
 * - Liquidity >= 1500–3000 USD
 * - Позиция ДОЛГОСРОЧНОГО сопровождения
 * - НЕТ жёсткого timeout
 * - Сопровождение до потери структуры роста
 * - Trailing stop (адаптивный):
 *   - 2x–3x → 20%
 *   - 3x–5x → 25%
 *   - 5x–10x → 30%
 *   - 10x+ → 35–40%
 * - Выход ТОЛЬКО по:
 *   - структурному дампу
 *   - потере импульса
 *   - слому тренда
 *   - критическим условиям
 */
export class GemStrategy implements Strategy {
  type: TokenType = 'GEM';

  shouldEnter(ctx: StrategyContext): { enter: boolean; reason: string } {
    // GEM входит если multiplier >= 2.0 и liquidity >= 1500
    if (ctx.metrics.multiplier >= 2.0 && ctx.metrics.liquidityUSD >= 1500) {
      return {
        enter: true,
        reason: `GEM entry: ${ctx.metrics.multiplier.toFixed(2)}x, liquidity=$${ctx.metrics.liquidityUSD.toFixed(2)}`,
      };
    }

    return {
      enter: false,
      reason: `GEM not ready: multiplier=${ctx.metrics.multiplier.toFixed(2)}x < 2.0 or liquidity=$${ctx.metrics.liquidityUSD.toFixed(2)} < $1500`,
    };
  }

  entryParams(ctx: StrategyContext, availableBalance: number): EntryParams {
    // GEM: средний размер позиции
    const positionSize = Math.min(0.015, availableBalance * 0.15); // 15% баланса, макс 0.015 SOL
    const minSize = 0.005;

    return {
      positionSize: Math.max(positionSize, minSize),
      stopLossPct: undefined, // НЕТ жесткого stop-loss, используем структурный
      takeProfitMultiplier: undefined, // НЕТ жесткого take-profit
      timeoutSeconds: undefined, // НЕТ timeout для GEM
      trailingStopPct: 20, // начальный trailing stop 20%
    };
  }

  monitorTick(position: Position, ctx: StrategyContext): MonitorDecision {
    const now = Date.now();
    const age = now - position.entryTime;
    const currentPrice = ctx.currentPrice || 0;

    if (!currentPrice || currentPrice <= 0) {
      // Если нет цены больше 30 секунд - критическое условие
      const timeSinceLastPrice = now - position.lastRealPriceUpdate;
      if (timeSinceLastPrice > 30_000) {
        return {
          action: 'exit',
          reason: `GEM no price data (${(timeSinceLastPrice / 1000).toFixed(0)}s)`,
          exitNow: true,
        };
      }
      return { action: 'hold', reason: 'Waiting for price data' };
    }

    const multiplier = currentPrice / position.entryPrice;

    // Обновляем peak price
    if (currentPrice > position.peakPrice) {
      position.peakPrice = currentPrice;
    }

    // 1. Адаптивный trailing stop
    let trailingStopPct = 20; // default
    if (multiplier >= 10) {
      trailingStopPct = 40;
    } else if (multiplier >= 5) {
      trailingStopPct = 30;
    } else if (multiplier >= 3) {
      trailingStopPct = 25;
    } else if (multiplier >= 2) {
      trailingStopPct = 20;
    }

    const trailingStopPrice = position.peakPrice * (1 - trailingStopPct / 100);
    if (currentPrice < trailingStopPrice) {
      return {
        action: 'exit',
        reason: `GEM trailing stop (${trailingStopPct}% from peak ${position.peakPrice.toFixed(8)})`,
        exitNow: true,
      };
    }

    // 2. Инициализация структуры и импульса
    if (!position.structure) {
      position.structure = {
        higherHighs: [currentPrice],
        higherLows: [currentPrice],
        lastHigh: currentPrice,
        lastLow: currentPrice,
      };
    }

    if (!position.impulse) {
      position.impulse = {
        velocity: 0,
        acceleration: 0,
        consecutiveDrops: 0,
      };
    }

    if (!position.priceHistory) {
      position.priceHistory = [];
    }

    position.priceHistory.push({ price: currentPrice, timestamp: now });

    // Оставляем только последние 5 цен для GEM (больше данных для анализа)
    if (position.priceHistory.length > 5) {
      position.priceHistory.shift();
    }

    // 3. Проверка импульса (velocity + acceleration)
    if (position.priceHistory.length >= 3) {
      const p1 = position.priceHistory[position.priceHistory.length - 3];
      const p2 = position.priceHistory[position.priceHistory.length - 2];
      const p3 = position.priceHistory[position.priceHistory.length - 1];

      const t1 = (p2.timestamp - p1.timestamp) / 1000; // seconds
      const t2 = (p3.timestamp - p2.timestamp) / 1000; // seconds

      if (t1 > 0 && t2 > 0) {
        const v1 = (p2.price - p1.price) / t1;
        const v2 = (p3.price - p2.price) / t2;

        position.impulse.velocity = v2;
        position.impulse.acceleration = (v2 - v1) / t2;

        // Если импульс отрицательный (цена падает)
        if (v2 < 0) {
          position.impulse.consecutiveDrops++;

          // Потеря импульса: 3 падения подряд с ускорением вниз
          if (position.impulse.consecutiveDrops >= 3 && position.impulse.acceleration < 0) {
            return {
              action: 'exit',
              reason: `GEM momentum loss (${position.impulse.consecutiveDrops} drops, accel=${position.impulse.acceleration.toFixed(8)})`,
              exitNow: true,
            };
          }
        } else {
          // Импульс положительный, сбрасываем счетчик
          position.impulse.consecutiveDrops = 0;
        }
      }
    }

    // 4. Проверка структуры (higher highs / higher lows)
    // Обновляем структуру каждые 5 секунд
    const lastStructureUpdate = position.priceHistory.length > 0 
      ? position.priceHistory[position.priceHistory.length - 1].timestamp 
      : now;

    if (now - lastStructureUpdate > 5_000) {
      // Новый хай
      if (currentPrice > position.structure.lastHigh) {
        position.structure.higherHighs.push(currentPrice);
        position.structure.lastHigh = currentPrice;
      }

      // Новый лоу
      if (currentPrice < position.structure.lastLow) {
        position.structure.higherLows.push(currentPrice);
        position.structure.lastLow = currentPrice;
      }

      // Проверка слома структуры: если новый лоу ниже предыдущего лоу
      if (position.structure.higherLows.length >= 2) {
        const prevLow = position.structure.higherLows[position.structure.higherLows.length - 2];
        const currLow = position.structure.higherLows[position.structure.higherLows.length - 1];

        if (currLow < prevLow) {
          return {
            action: 'exit',
            reason: `GEM structure break (lower low: ${currLow.toFixed(8)} < ${prevLow.toFixed(8)})`,
            exitNow: true,
          };
        }
      }
    }

    // 5. Критическое падение от пика (failsafe)
    const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice;
    if (dropFromPeak > 0.50) { // 50% от пика
      return {
        action: 'exit',
        reason: `GEM critical drop from peak (${(dropFromPeak * 100).toFixed(1)}%)`,
        exitNow: true,
      };
    }

    return { action: 'hold', reason: 'GEM holding strong structure' };
  }

  exitPlan(position: Position, ctx: StrategyContext, reason: string): ExitPlan {
    // GEM: умеренный jito tip, средний slippage
    const isUrgent = reason.includes('critical') || reason.includes('momentum loss');

    return {
      exitType: reason.includes('trailing stop') ? 'take_profit' : 
                reason.includes('structure break') ? 'structure_break' :
                reason.includes('momentum loss') ? 'momentum_loss' : 'panic',
      jitoTip: isUrgent ? config.jitoTipAmount * 1.5 : config.jitoTipAmount,
      slippage: isUrgent ? 0.30 : 0.20, // 20-30% slippage
      urgent: isUrgent,
    };
  }
}

