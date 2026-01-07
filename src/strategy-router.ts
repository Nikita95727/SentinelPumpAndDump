import { Strategy } from './strategies/strategy.interface';
import { ManipulatorStrategy } from './strategies/manipulator-strategy';
import { GemStrategy } from './strategies/gem-strategy';
import { MidStrategy } from './strategies/mid-strategy';
import { TokenType, ClassifiedToken } from './types';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

/**
 * StrategyRouter — роутер стратегий
 * 
 * Задача: вернуть правильную стратегию для данного типа токена
 * 
 * TRASH токены НЕ торгуются, для них нет стратегии
 */
export class StrategyRouter {
  private strategies: Map<TokenType, Strategy>;

  constructor() {
    this.strategies = new Map();
    
    // Регистрируем стратегии
    this.strategies.set('MANIPULATOR', new ManipulatorStrategy());
    this.strategies.set('GEM', new GemStrategy());
    this.strategies.set('MID', new MidStrategy());
    // TRASH не имеет стратегии
  }

  /**
   * Получает стратегию для токена
   * Возвращает null если токен не торгуется (TRASH)
   */
  getStrategy(classifiedToken: ClassifiedToken): Strategy | null {
    if (classifiedToken.type === 'TRASH') {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: classifiedToken.candidate.mint,
        message: `🗑️ TRASH token - no strategy, NOT TRADING`,
      });
      return null;
    }

    const strategy = this.strategies.get(classifiedToken.type);
    
    if (!strategy) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        token: classifiedToken.candidate.mint,
        message: `❌ No strategy found for type ${classifiedToken.type}`,
      });
      return null;
    }

    logger.log({
      timestamp: getCurrentTimestamp(),
      type: 'info',
      token: classifiedToken.candidate.mint,
      message: `✅ Strategy selected: ${strategy.type} for ${classifiedToken.candidate.mint.substring(0, 8)}...`,
    });

    return strategy;
  }

  /**
   * Получает стратегию по типу токена напрямую
   */
  getStrategyByType(type: TokenType): Strategy | null {
    if (type === 'TRASH') {
      return null;
    }
    return this.strategies.get(type) || null;
  }
}

