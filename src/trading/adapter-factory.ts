/**
 * Trading Adapter Factory
 * Создает нужный адаптер в зависимости от конфига
 */

import { Connection } from '@solana/web3.js';
import { ITradingAdapter } from './trading-adapter.interface';
import { RealTradingAdapter } from './real-trading-adapter';
import { PaperTradingAdapter } from './paper-trading-adapter';
import { config } from '../config';

export function createTradingAdapter(connection: Connection, initialBalance: number): ITradingAdapter {
  if (config.tradingMode === 'real') {
    return new RealTradingAdapter(connection);
  } else {
    return new PaperTradingAdapter(connection, initialBalance);
  }
}

