import { TokenCandidate, TokenMetrics, TokenType, ClassifiedToken } from './types';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

/**
 * TokenClassifier — классификация токенов по типам
 * 
 * Правила классификации (СТРОГО):
 * 
 * MANIPULATOR:
 * - обнаружен concentrated liquidity / манипуляторский паттерн
 * - liquidityUSD >= 500
 * - marketCap >= 1000 (если доступна)
 * 
 * GEM:
 * - multiplier >= 2.0
 * - liquidityUSD >= 1500
 * 
 * MID:
 * - multiplier >= 1.12
 * - liquidityUSD >= 1000
 * 
 * TRASH:
 * - всё остальное (НЕ торгуется)
 */
export class TokenClassifier {
  /**
   * Классифицирует токен на основе метрик
   * ANTI-HONEYPOT уже пройден до вызова этого метода
   */
  classify(candidate: TokenCandidate, metrics: TokenMetrics): ClassifiedToken {
    let type: TokenType = 'TRASH';

    // MANIPULATOR: concentrated liquidity + достаточная ликвидность
    if (
      metrics.hasConcentratedLiquidity &&
      metrics.liquidityUSD >= 500 &&
      metrics.marketCapUSD >= 1000
    ) {
      type = 'MANIPULATOR';
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🎯 CLASSIFIED: MANIPULATOR | ${candidate.mint.substring(0, 8)}... | liquidity=$${metrics.liquidityUSD.toFixed(2)}, marketCap=$${metrics.marketCapUSD.toFixed(2)}, multiplier=${metrics.multiplier.toFixed(2)}x`,
      });
    }
    // GEM: высокий multiplier + высокая ликвидность
    else if (
      metrics.multiplier >= 2.0 &&
      metrics.liquidityUSD >= 1500
    ) {
      type = 'GEM';
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `💎 CLASSIFIED: GEM | ${candidate.mint.substring(0, 8)}... | multiplier=${metrics.multiplier.toFixed(2)}x, liquidity=$${metrics.liquidityUSD.toFixed(2)}, marketCap=$${metrics.marketCapUSD.toFixed(2)}`,
      });
    }
    // MID: средний multiplier + средняя ликвидность
    else if (
      metrics.multiplier >= 1.12 &&
      metrics.liquidityUSD >= 1000
    ) {
      type = 'MID';
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `📊 CLASSIFIED: MID | ${candidate.mint.substring(0, 8)}... | multiplier=${metrics.multiplier.toFixed(2)}x, liquidity=$${metrics.liquidityUSD.toFixed(2)}, marketCap=$${metrics.marketCapUSD.toFixed(2)}`,
      });
    }
    // TRASH: не соответствует критериям
    else {
      type = 'TRASH';
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        token: candidate.mint,
        message: `🗑️ CLASSIFIED: TRASH | ${candidate.mint.substring(0, 8)}... | multiplier=${metrics.multiplier.toFixed(2)}x, liquidity=$${metrics.liquidityUSD.toFixed(2)}, marketCap=$${metrics.marketCapUSD.toFixed(2)} | NOT TRADING`,
      });
    }

    return {
      candidate,
      type,
      metrics,
      classifiedAt: Date.now(),
    };
  }

  /**
   * Проверяет, торгуется ли токен данного типа
   */
  isTradeable(type: TokenType): boolean {
    return type !== 'TRASH';
  }
}

