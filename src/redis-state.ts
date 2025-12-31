import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

/**
 * Redis State Manager
 * Управляет персистентным хранением состояния в Redis
 * Использует существующую Redis инфраструктуру из cache.ts
 */
class RedisStateManager {
  private redis: Redis | null = null;
  private useRedis: boolean = false;
  private readonly PREFIX_ABANDONED = 'abandoned:tokens:';
  private readonly PREFIX_POSITIONS = 'positions:active:';
  private readonly KEY_ABANDONED_LIST = 'abandoned:tokens:list';
  private readonly KEY_POSITIONS_LIST = 'positions:active:list';

  constructor() {
    this.initializeRedis();
  }

  private async initializeRedis(): Promise<void> {
    // Если Redis не настроен в .env - используем fallback
    if (!config.redisHost) {
      this.useRedis = false;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: '⚠️ Redis not configured, state persistence disabled',
      });
      return;
    }

    try {
      this.redis = new Redis({
        host: config.redisHost,
        port: config.redisPort || 6379,
        password: config.redisPassword,
        retryStrategy: () => null, // Не переподключаемся автоматически
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
        connectTimeout: 2000,
      });

      this.redis.on('error', (err) => {
        this.useRedis = false;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `❌ Redis connection error: ${err.message}`,
        });
      });

      this.redis.on('connect', () => {
        this.useRedis = true;
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'info',
          message: '✅ Redis state manager connected',
        });
      });

      // Пытаемся подключиться
      await Promise.race([
        this.redis.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Redis connection timeout')), 2000)),
      ]);

      await this.redis.ping();
      this.useRedis = true;
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: '✅ Redis state manager initialized successfully',
      });
    } catch (error) {
      this.useRedis = false;
      if (this.redis) {
        try {
          await this.redis.quit();
        } catch (e) {
          // Ignore
        }
        this.redis = null;
      }
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'warning',
        message: `⚠️ Redis not available, state persistence disabled: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Проверяет доступность Redis
   */
  isAvailable(): boolean {
    return this.useRedis && this.redis !== null;
  }

  /**
   * Сохраняет abandoned token
   */
  async saveAbandonedToken(token: string, data: any): Promise<void> {
    if (!this.isAvailable()) {
      return; // Fallback: не сохраняем, если Redis недоступен
    }

    try {
      const key = `${this.PREFIX_ABANDONED}${token}`;
      await this.redis!.set(key, JSON.stringify(data));
      await this.redis!.sadd(this.KEY_ABANDONED_LIST, token);
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to save abandoned token to Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Удаляет abandoned token
   */
  async removeAbandonedToken(token: string): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const key = `${this.PREFIX_ABANDONED}${token}`;
      await this.redis!.del(key);
      await this.redis!.srem(this.KEY_ABANDONED_LIST, token);
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to remove abandoned token from Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Загружает все abandoned tokens
   */
  async loadAbandonedTokens(): Promise<Map<string, any>> {
    const result = new Map<string, any>();

    if (!this.isAvailable()) {
      return result;
    }

    try {
      const tokens = await this.redis!.smembers(this.KEY_ABANDONED_LIST);
      
      for (const token of tokens) {
        const key = `${this.PREFIX_ABANDONED}${token}`;
        const data = await this.redis!.get(key);
        
        if (data) {
          try {
            const parsed = JSON.parse(data);
            result.set(token, parsed);
          } catch (e) {
            // Invalid JSON, skip
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'warning',
              message: `⚠️ Invalid JSON for abandoned token ${token.substring(0, 8)}..., skipping`,
            });
          }
        }
      }
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to load abandoned tokens from Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return result;
  }

  /**
   * Сохраняет активную позицию
   */
  async saveActivePosition(token: string, data: any): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const key = `${this.PREFIX_POSITIONS}${token}`;
      await this.redis!.set(key, JSON.stringify(data));
      await this.redis!.sadd(this.KEY_POSITIONS_LIST, token);
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to save active position to Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Удаляет активную позицию
   */
  async removeActivePosition(token: string): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const key = `${this.PREFIX_POSITIONS}${token}`;
      await this.redis!.del(key);
      await this.redis!.srem(this.KEY_POSITIONS_LIST, token);
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to remove active position from Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Загружает все активные позиции
   */
  async loadActivePositions(): Promise<Map<string, any>> {
    const result = new Map<string, any>();

    if (!this.isAvailable()) {
      return result;
    }

    try {
      const tokens = await this.redis!.smembers(this.KEY_POSITIONS_LIST);
      
      for (const token of tokens) {
        const key = `${this.PREFIX_POSITIONS}${token}`;
        const data = await this.redis!.get(key);
        
        if (data) {
          try {
            const parsed = JSON.parse(data);
            result.set(token, parsed);
          } catch (e) {
            // Invalid JSON, skip
            logger.log({
              timestamp: getCurrentTimestamp(),
              type: 'warning',
              message: `⚠️ Invalid JSON for active position ${token.substring(0, 8)}..., skipping`,
            });
          }
        }
      }
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to load active positions from Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return result;
  }

  /**
   * Очищает все abandoned tokens
   */
  async clearAbandonedTokens(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const tokens = await this.redis!.smembers(this.KEY_ABANDONED_LIST);
      if (tokens.length > 0) {
        const keys = tokens.map(t => `${this.PREFIX_ABANDONED}${t}`);
        await this.redis!.del(...keys);
      }
      await this.redis!.del(this.KEY_ABANDONED_LIST);
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to clear abandoned tokens from Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Очищает все активные позиции
   */
  async clearActivePositions(): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    try {
      const tokens = await this.redis!.smembers(this.KEY_POSITIONS_LIST);
      if (tokens.length > 0) {
        const keys = tokens.map(t => `${this.PREFIX_POSITIONS}${t}`);
        await this.redis!.del(...keys);
      }
      await this.redis!.del(this.KEY_POSITIONS_LIST);
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `❌ Failed to clear active positions from Redis: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * Закрывает соединение
   */
  async close(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch (e) {
        // Ignore
      }
      this.redis = null;
      this.useRedis = false;
    }
  }
}

// Singleton instance
export const redisState = new RedisStateManager();

