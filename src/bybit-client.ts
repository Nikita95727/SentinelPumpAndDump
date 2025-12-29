/**
 * Bybit API Client
 * Обеспечивает взаимодействие с Bybit API (REST + WebSocket)
 */

import * as ccxt from 'ccxt';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

export interface BybitTicker {
  symbol: string;
  lastPrice: number;
  volume24h: number;
  priceChange24h: number; // %
  volatility24h: number; // %
  high24h: number;
  low24h: number;
}

export interface BybitOrderBook {
  symbol: string;
  bids: Array<[number, number]>; // [price, quantity]
  asks: Array<[number, number]>;
  timestamp: number;
}

export class BybitClient {
  private exchange: ccxt.Exchange;
  private wsConnections: Map<string, any> = new Map();
  private tickerCache: Map<string, { ticker: BybitTicker; timestamp: number }> = new Map();
  private readonly TICKER_CACHE_TTL = 1000; // 1 секунда

  constructor() {
    this.exchange = new ccxt.bybit({
      apiKey: config.bybitApiKey,
      secret: config.bybitApiSecret,
      sandbox: config.bybitTestnet,
      enableRateLimit: true,
      options: {
        defaultType: 'spot', // Spot trading
      },
    });
  }

  /**
   * Получает список всех доступных спотовых пар
   */
  async getSpotMarkets(): Promise<string[]> {
    try {
      const markets = await this.exchange.loadMarkets();
      const spotMarkets = Object.keys(markets).filter(
        symbol => {
          const market = markets[symbol];
          return market && market.spot && market.active;
        }
      );
      return spotMarkets;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error loading Bybit markets: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }
  }

  /**
   * Получает тикер для символа
   */
  async getTicker(symbol: string): Promise<BybitTicker | null> {
    try {
      // Проверяем кэш
      const cached = this.tickerCache.get(symbol);
      if (cached && (Date.now() - cached.timestamp) < this.TICKER_CACHE_TTL) {
        return cached.ticker;
      }

      const ticker = await this.exchange.fetchTicker(symbol);
      
      if (!ticker) {
        return null;
      }
      
      // Рассчитываем волатильность за 24ч
      const volatility24h = ticker.high && ticker.low
        ? ((ticker.high - ticker.low) / ticker.low) * 100
        : 0;

      const bybitTicker: BybitTicker = {
        symbol,
        lastPrice: ticker.last || 0,
        volume24h: ticker.quoteVolume || 0, // Объем в базовой валюте (USD для USDT пар)
        priceChange24h: ticker.percentage || 0,
        volatility24h,
        high24h: ticker.high || 0,
        low24h: ticker.low || 0,
      };

      // Обновляем кэш
      this.tickerCache.set(symbol, {
        ticker: bybitTicker,
        timestamp: Date.now(),
      });

      return bybitTicker;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error fetching ticker for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
  }

  /**
   * Получает тикеры для нескольких символов батчем
   */
  async getTickersBatch(symbols: string[]): Promise<Map<string, BybitTicker>> {
    const result = new Map<string, BybitTicker>();
    
    // Bybit позволяет получать все тикеры одним запросом
    try {
      const tickers = await this.exchange.fetchTickers();
      
      for (const symbol of symbols) {
        const ticker = tickers[symbol];
        if (ticker) {
          const volatility24h = ticker.high && ticker.low
            ? ((ticker.high - ticker.low) / ticker.low) * 100
            : 0;

          result.set(symbol, {
            symbol,
            lastPrice: ticker.last || 0,
            volume24h: ticker.quoteVolume || 0,
            priceChange24h: ticker.percentage || 0,
            volatility24h,
            high24h: ticker.high || 0,
            low24h: ticker.low || 0,
          });
        }
      }
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error fetching tickers batch: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return result;
  }

  /**
   * Получает стакан заявок
   */
  async getOrderBook(symbol: string, limit: number = 20): Promise<BybitOrderBook | null> {
    try {
      const orderBook = await this.exchange.fetchOrderBook(symbol, limit);
      
      return {
        symbol,
        bids: orderBook.bids as Array<[number, number]>,
        asks: orderBook.asks as Array<[number, number]>,
        timestamp: orderBook.timestamp || Date.now(),
      };
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error fetching order book for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
  }

  /**
   * Размещает рыночный ордер на покупку
   */
  async marketBuy(symbol: string, amount: number): Promise<{ success: boolean; orderId?: string; filled?: number; averagePrice?: number; error?: string }> {
    try {
      const order = await this.exchange.createMarketBuyOrder(symbol, amount);
      
      // Получаем среднюю цену выполнения
      const ticker = await this.getTicker(symbol);
      const averagePrice = (order as any).average || (order as any).price || ticker?.lastPrice || 0;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Bybit MARKET BUY: ${symbol} | amount=${amount}, orderId=${order.id}, filled=${order.filled || 0}, avgPrice=${averagePrice}`,
      });

      return {
        success: true,
        orderId: order.id,
        filled: order.filled || 0,
        averagePrice,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Bybit MARKET BUY FAILED: ${symbol} | amount=${amount}, error=${errorMessage}`,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Размещает рыночный ордер на продажу
   */
  async marketSell(symbol: string, amount: number): Promise<{ success: boolean; orderId?: string; filled?: number; averagePrice?: number; error?: string }> {
    try {
      const order = await this.exchange.createMarketSellOrder(symbol, amount);
      
      // Получаем среднюю цену выполнения
      const ticker = await this.getTicker(symbol);
      const averagePrice = (order as any).average || (order as any).price || ticker?.lastPrice || 0;
      
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `✅ Bybit MARKET SELL: ${symbol} | amount=${amount}, orderId=${order.id}, filled=${order.filled || 0}, avgPrice=${averagePrice}`,
      });

      return {
        success: true,
        orderId: order.id,
        filled: order.filled || 0,
        averagePrice,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Bybit MARKET SELL FAILED: ${symbol} | amount=${amount}, error=${errorMessage}`,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Получает баланс аккаунта
   */
  async getBalance(currency: string = 'USDT'): Promise<number> {
    try {
      const balance = await this.exchange.fetchBalance();
      return balance[currency]?.free || 0;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error fetching balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 0;
    }
  }

  /**
   * Получает историю свечей для расчета волатильности
   */
  async getCandles(symbol: string, timeframe: string = '5m', limit: number = 288): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>> {
    try {
      const candles = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      return candles.map((candle: any) => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
      }));
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error fetching candles for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }
  }

  /**
   * Рассчитывает волатильность за период
   */
  async calculateVolatility(symbol: string, period: string = '24h'): Promise<number> {
    try {
      const timeframe = period === '24h' ? '1h' : '5m';
      const limit = period === '24h' ? 24 : 12;
      
      const candles = await this.getCandles(symbol, timeframe, limit);
      if (candles.length < 2) {
        return 0;
      }

      // Рассчитываем стандартное отклонение цен
      const closes = candles.map(c => c.close);
      const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
      const variance = closes.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / closes.length;
      const stdDev = Math.sqrt(variance);
      
      // Волатильность в процентах
      return (stdDev / mean) * 100;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error calculating volatility for ${symbol}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 0;
    }
  }
}

