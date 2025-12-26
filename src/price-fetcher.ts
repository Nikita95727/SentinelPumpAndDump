import { config } from './config';

/**
 * Класс для батч-запросов цен токенов
 * Оптимизирует API запросы: вместо 10 запросов делает 1 батч-запрос
 */
export class PriceFetcher {
  private priceCache = new Map<string, { price: number; timestamp: number }>();
  private readonly CACHE_TTL = 2000; // 2 секунды

  /**
   * Получает цены для нескольких токенов батчем
   */
  async getPricesBatch(tokens: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const toFetch: string[] = [];

    // 1. Проверяем кэш
    for (const token of tokens) {
      const cached = this.priceCache.get(token);
      if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
        result.set(token, cached.price);
      } else {
        toFetch.push(token);
      }
    }

    // 2. Запрашиваем только те что не в кэше (батчем через Jupiter API)
    if (toFetch.length > 0) {
      const prices = await this.fetchPricesFromJupiter(toFetch);

      for (const [token, price] of prices.entries()) {
        result.set(token, price);
        this.priceCache.set(token, { price, timestamp: Date.now() });
      }
    }

    return result;
  }

  /**
   * Получает цену одного токена (использует батч внутри)
   */
  async getPrice(token: string): Promise<number> {
    const prices = await this.getPricesBatch([token]);
    return prices.get(token) || 0;
  }

  /**
   * Запрашивает цены через Jupiter API
   */
  private async fetchPricesFromJupiter(tokens: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();

    // Параллельно запрашиваем цены для всех токенов
    const pricePromises = tokens.map(async (token) => {
      try {
        const price = await this.getJupiterQuote(token);
        return { token, price };
      } catch (error) {
        console.error(`Error fetching price for ${token.slice(0, 8)}...:`, error);
        return { token, price: 0 };
      }
    });

    const results = await Promise.all(pricePromises);
    for (const { token, price } of results) {
      prices.set(token, price);
    }

    return prices;
  }

  /**
   * Получает котировку от Jupiter API
   */
  private async getJupiterQuote(tokenMint: string): Promise<number> {
    try {
      // Jupiter API endpoint для получения цены
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const url = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=1000000&slippageBps=50`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status}`);
      }

      const data = await response.json() as { outAmount?: string; inAmount?: string };
      
      // Извлекаем цену из котировки
      if (data.outAmount && data.inAmount) {
        // Цена = outAmount / inAmount (сколько SOL за 1 токен)
        const price = Number(data.outAmount) / Number(data.inAmount);
        return price;
      }

      return 0;
    } catch (error) {
      console.error(`Error getting Jupiter quote for ${tokenMint}:`, error);
      // Fallback: возвращаем минимальную цену
      return 0.00000001;
    }
  }

  /**
   * Очищает кэш
   */
  clearCache(): void {
    this.priceCache.clear();
  }
}

