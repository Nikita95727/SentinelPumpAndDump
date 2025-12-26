import Redis from 'ioredis';
import { config } from './config';

/**
 * Кеш для результатов фильтров и RPC запросов
 * Использует Redis если доступен, иначе in-memory кеш
 */
class Cache {
  private redis: Redis | null = null;
  private memoryCache: Map<string, { value: any; expires: number }> = new Map();
  private useRedis: boolean = false;

  constructor() {
    this.initializeRedis();
  }

  private async initializeRedis(): Promise<void> {
    if (config.redisHost) {
      try {
        this.redis = new Redis({
          host: config.redisHost,
          port: config.redisPort || 6379,
          password: config.redisPassword,
          retryStrategy: (times) => {
            // Экспоненциальная задержка с максимумом 3 секунды
            const delay = Math.min(times * 50, 3000);
            return delay;
          },
          maxRetriesPerRequest: 3,
        });

        this.redis.on('error', (err) => {
          console.warn('Redis connection error, falling back to memory cache:', err.message);
          this.useRedis = false;
        });

        this.redis.on('connect', () => {
          this.useRedis = true;
          console.log('Redis cache connected');
        });

        // Проверяем соединение
        await this.redis.ping();
        this.useRedis = true;
      } catch (error) {
        console.warn('Redis not available, using memory cache:', error);
        this.useRedis = false;
      }
    }
  }

  /**
   * Получает значение из кеша
   */
  async get<T>(key: string): Promise<T | null> {
    if (this.useRedis && this.redis) {
      try {
        const value = await this.redis.get(key);
        if (value) {
          return JSON.parse(value) as T;
        }
      } catch (error) {
        // Fallback to memory cache
      }
    }

    // Memory cache fallback
    const cached = this.memoryCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value as T;
    }

    // Удаляем истекший кеш
    if (cached) {
      this.memoryCache.delete(key);
    }

    return null;
  }

  /**
   * Сохраняет значение в кеш
   */
  async set(key: string, value: any, ttlSeconds: number = 10): Promise<void> {
    if (this.useRedis && this.redis) {
      try {
        await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
        return;
      } catch (error) {
        // Fallback to memory cache
      }
    }

    // Memory cache fallback
    this.memoryCache.set(key, {
      value,
      expires: Date.now() + ttlSeconds * 1000,
    });

    // Очищаем старые записи периодически (каждые 1000 записей)
    if (this.memoryCache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.memoryCache.entries()) {
        if (v.expires <= now) {
          this.memoryCache.delete(k);
        }
      }
    }
  }

  /**
   * Удаляет значение из кеша
   */
  async delete(key: string): Promise<void> {
    if (this.useRedis && this.redis) {
      try {
        await this.redis.del(key);
      } catch (error) {
        // Ignore
      }
    }

    this.memoryCache.delete(key);
  }

  /**
   * Очищает весь кеш
   */
  async clear(): Promise<void> {
    if (this.useRedis && this.redis) {
      try {
        await this.redis.flushdb();
      } catch (error) {
        // Ignore
      }
    }

    this.memoryCache.clear();
  }

  /**
   * Закрывает соединения
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
      this.useRedis = false;
    }
    this.memoryCache.clear();
  }
}

// Singleton instance
export const cache = new Cache();

