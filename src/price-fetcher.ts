import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config';
import { getRpcPool } from './rpc-pool';

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_FUN_BONDING_CURVE_SEED = 'bonding-curve';
const VIRTUAL_SOL_RESERVES = 30_000_000_000; // 30 SOL в lamports
const VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000; // Виртуальные резервы токенов
const LAMPORTS_PER_SOL = 1_000_000_000;

interface TokenPrice {
  priceInSol: number;
  priceInUsd: number;
  timestamp: number;
}

interface TokenMarketData {
  price: number;
  marketCap: number; // в USD
  totalSupply: number;
}

/**
 * Получает цены pump.fun токенов напрямую из bonding curve контракта
 * НЕ использует Jupiter API (новые токены не индексируются сразу)
 */
export class PumpFunPriceFetcher {
  private rpcPool = getRpcPool();
  private priceCache = new Map<string, TokenPrice>();
  private readonly CACHE_TTL = 2000; // 2 секунды
  private readonly MICRO_CACHE_TTL = 100; // 100ms для повторных запросов
  private microPriceCache = new Map<string, { price: number; expiry: number }>();
  private solUsdPrice = 170;

  constructor() {
    this.updateSolPrice();
    // Обновляем цену SOL каждые 30 секунд
    setInterval(() => this.updateSolPrice(), 30_000);
  }

  /**
   * Получает цену одного токена в SOL
   */
  async getPrice(tokenMint: string, useSecondary: boolean = false): Promise<number> {
    // Микро-кеш для повторных запросов в пределах 100ms
    const microCached = this.microPriceCache.get(tokenMint);
    if (microCached && microCached.expiry > Date.now()) {
      return microCached.price;
    }

    const cached = this.priceCache.get(tokenMint);
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      // Обновляем микро-кеш
      this.microPriceCache.set(tokenMint, { price: cached.priceInSol, expiry: Date.now() + this.MICRO_CACHE_TTL });
      return cached.priceInSol;
    }

    try {
      const bondingCurvePda = await this.getBondingCurvePDA(tokenMint);
      const connection = useSecondary ? this.rpcPool.getSecondaryConnection() : this.rpcPool.getConnection();
      const accountInfo = await connection.getAccountInfo(bondingCurvePda);

      if (!accountInfo) {
        const fallbackPrice = this.calculateFallbackPrice();
        this.microPriceCache.set(tokenMint, { price: fallbackPrice, expiry: Date.now() + this.MICRO_CACHE_TTL });
        return fallbackPrice;
      }

      const price = this.parseBondingCurvePrice(accountInfo.data);

      this.priceCache.set(tokenMint, {
        priceInSol: price,
        priceInUsd: price * this.solUsdPrice,
        timestamp: Date.now()
      });

      this.microPriceCache.set(tokenMint, { price, expiry: Date.now() + this.MICRO_CACHE_TTL });

      return price;
    } catch (error) {
      const fallbackPrice = this.calculateFallbackPrice();
      this.microPriceCache.set(tokenMint, { price: fallbackPrice, expiry: Date.now() + this.MICRO_CACHE_TTL });
      return fallbackPrice;
    }
  }

  /**
   * Получает цены для нескольких токенов батчем
   */
  async getPricesBatch(tokenMints: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    const toFetch: string[] = [];

    // 1. Проверяем кэш
    for (const mint of tokenMints) {
      const cached = this.priceCache.get(mint);
      if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
        prices.set(mint, cached.priceInSol);
      } else {
        toFetch.push(mint);
      }
    }

    // 2. Запрашиваем только те что не в кэше
    if (toFetch.length > 0) {
      const results = await Promise.allSettled(
        toFetch.map(mint => this.getPrice(mint, true)) // Батчевые запросы для очереди всегда через secondary
      );

      results.forEach((result, index) => {
        const mint = toFetch[index];
        if (result.status === 'fulfilled') {
          prices.set(mint, result.value);
        } else {
          // При ошибке используем fallback
          prices.set(mint, this.calculateFallbackPrice());
        }
      });
    }

    return prices;
  }

  /**
   * Получает PDA адрес bonding curve для токена
   */
  private async getBondingCurvePDA(tokenMint: string): Promise<PublicKey> {
    const [pda] = await PublicKey.findProgramAddress(
      [
        Buffer.from(PUMP_FUN_BONDING_CURVE_SEED),
        new PublicKey(tokenMint).toBuffer()
      ],
      PUMP_FUN_PROGRAM
    );
    return pda;
  }

  /**
   * Парсит цену из данных bonding curve аккаунта
   */
  private parseBondingCurvePrice(data: Buffer): number {
    try {
      // Структура данных bonding curve (примерно):
      // offset 24: realTokenReserves (u64)
      // offset 32: realSolReserves (u64)

      const realTokenReserves = Number(data.readBigUInt64LE(24));
      const realSolReserves = Number(data.readBigUInt64LE(32));

      if (realTokenReserves > 0 && realSolReserves > 0) {
        // Цена = SOL_reserves / Token_reserves
        // Конвертируем в правильные единицы
        const solAmount = realSolReserves / LAMPORTS_PER_SOL;
        const tokenAmount = realTokenReserves / 1e9; // Предполагаем 9 decimals для токенов
        return solAmount / tokenAmount;
      }

      // Если резервы не инициализированы - используем fallback
      return this.calculateFallbackPrice();
    } catch (error) {
      console.error('Error parsing bonding curve price:', error);
      return this.calculateFallbackPrice();
    }
  }

  /**
   * Вычисляет fallback цену на основе виртуальных резервов
   */
  private calculateFallbackPrice(): number {
    const solAmount = VIRTUAL_SOL_RESERVES / LAMPORTS_PER_SOL;
    const tokenAmount = VIRTUAL_TOKEN_RESERVES / 1e9;
    return solAmount / tokenAmount;
  }

  /**
   * Обновляет цену SOL в USD
   */
  private async updateSolPrice(): Promise<void> {
    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { signal: AbortSignal.timeout(5000) }
      );

      if (response.ok) {
        const data = await response.json() as { solana?: { usd?: number } };
        if (data.solana?.usd) {
          this.solUsdPrice = data.solana.usd;
          console.log(`📊 SOL/USD updated: $${this.solUsdPrice.toFixed(2)}`);
        }
      }
    } catch (error) {
      // При ошибке используем значение по умолчанию
      console.warn('Error updating SOL price, using default:', error);
    }
  }

  /**
   * Получает рыночные данные токена (цена + капитализация)
   * ⭐ НОВОЕ: Получает капитализацию для мониторинга
   */
  async getMarketData(tokenMint: string, useSecondary: boolean = false): Promise<TokenMarketData | null> {
    try {
      const price = await this.getPrice(tokenMint, useSecondary);
      if (price <= 0) {
        // ⭐ ЛОГИРУЕМ: цена <= 0
        console.warn(`[PriceFetcher] getMarketData: price <= 0 for ${tokenMint.substring(0, 8)}... (price=${price})`);
        return null;
      }

      // ⭐ КРИТИЧНО: Для pump.fun токенов market cap рассчитывается по-другому
      // Для токенов на bonding curve: Market Cap = (Virtual SOL + Real SOL) * 2 * SOL/USD
      // Для токенов на Raydium: Market Cap = price * circulatingSupply * SOL/USD

      // Пытаемся получить bonding curve account
      let marketCap = 0;
      let totalSupply = 0;

      try {
        const bondingCurvePda = await this.getBondingCurvePDA(tokenMint);
        const connection = useSecondary ? this.rpcPool.getSecondaryConnection() : this.rpcPool.getConnection();
        const accountInfo = await connection.getAccountInfo(bondingCurvePda);

        if (accountInfo && accountInfo.data.length > 0) {
          // Токен еще на bonding curve - читаем реальные резервы из bonding curve
          // Структура: offset 24: realTokenReserves (u64), offset 32: realSolReserves (u64)
          const realTokenReserves = Number(accountInfo.data.readBigUInt64LE(24));
          const realSolReserves = Number(accountInfo.data.readBigUInt64LE(32));

          if (realSolReserves > 0 && realTokenReserves > 0) {
            // Market Cap = (Virtual SOL + Real SOL) * 2 * SOL/USD
            // Формула: (30 + realSolReserves) * 2 * SOL/USD
            const virtualSol = VIRTUAL_SOL_RESERVES / LAMPORTS_PER_SOL; // 30 SOL
            const realSol = realSolReserves / LAMPORTS_PER_SOL;
            marketCap = (virtualSol + realSol) * 2 * this.solUsdPrice;
            totalSupply = (VIRTUAL_TOKEN_RESERVES + realTokenReserves) / 1e9;
          } else {
            // Резервы не инициализированы - используем fallback на основе цены
            const INITIAL_PRICE = VIRTUAL_SOL_RESERVES / LAMPORTS_PER_SOL / (VIRTUAL_TOKEN_RESERVES / 1e9); // ~0.000000028 SOL
            const priceMultiplier = price / INITIAL_PRICE;
            const estimatedRealSol = 30 * priceMultiplier;
            marketCap = (30 + estimatedRealSol) * 2 * this.solUsdPrice;
            totalSupply = VIRTUAL_TOKEN_RESERVES / 1e9;
          }
        } else {
          // Токен перешел на Raydium - используем totalSupply из mint
          const { getMint } = await import('@solana/spl-token');
          const mintPubkey = new PublicKey(tokenMint);
          const mintInfo = await getMint(connection, mintPubkey);
          totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
          marketCap = price * totalSupply * this.solUsdPrice;
        }
      } catch (error) {
        // Fallback: используем старую формулу с totalSupply
        try {
          const { getMint } = await import('@solana/spl-token');
          const mintPubkey = new PublicKey(tokenMint);
          const connection = this.rpcPool.getConnection();
          const mintInfo = await getMint(connection, mintPubkey);
          totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
          marketCap = price * totalSupply * this.solUsdPrice;
        } catch (fallbackError) {
          // Если и это не работает, возвращаем null
          throw fallbackError;
        }
      }

      return {
        price,
        marketCap,
        totalSupply,
      };
    } catch (error) {
      // ⭐ ЛОГИРУЕМ: ошибка при получении market data
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.warn(`[PriceFetcher] getMarketData failed for ${tokenMint.substring(0, 8)}...: ${errorName}: ${errorMessage}`);
      return null;
    }
  }

  /**
   * Очищает кэш
   * ⭐ КРИТИЧНО: Вызывается при старте для полной очистки всех кешей цен
   */
  clearCache(): void {
    this.priceCache.clear();
    this.microPriceCache.clear();
  }
}

// Экспортируем singleton instance
export const priceFetcher = new PumpFunPriceFetcher();
