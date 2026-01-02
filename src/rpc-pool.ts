import { Connection } from '@solana/web3.js';
import { config } from './config';

/**
 * Пул RPC соединений для распределения нагрузки
 * Использует round-robin для распределения запросов между соединениями
 */
export class RpcConnectionPool {
  private primaryConnections: Connection[] = [];
  private secondaryConnections: Connection[] = [];
  private primaryIndex = 0;
  private secondaryIndex = 0;
  private poolSize: number;

  constructor(poolSize: number = 3) {
    this.poolSize = poolSize;
    this.initializeConnections();
  }

  private initializeConnections(): void {
    // Основные соединения (Helius)
    for (let i = 0; i < this.poolSize; i++) {
      this.primaryConnections.push(
        new Connection(config.heliusHttpUrl, {
          commitment: 'confirmed',
        })
      );
    }

    // Вторичные соединения (Fallback/Free)
    if (config.secondaryRpcUrls && config.secondaryRpcUrls.length > 0) {
      for (const url of config.secondaryRpcUrls) {
        this.secondaryConnections.push(
          new Connection(url, {
            commitment: 'confirmed',
          })
        );
      }
    }
  }

  /**
   * Получает основное соединение (Helius)
   */
  getConnection(): Connection {
    const connection = this.primaryConnections[this.primaryIndex];
    this.primaryIndex = (this.primaryIndex + 1) % this.primaryConnections.length;
    return connection;
  }

  /**
   * Получает вторичное соединение (если есть), иначе основное
   */
  getSecondaryConnection(): Connection {
    if (this.secondaryConnections.length > 0) {
      const connection = this.secondaryConnections[this.secondaryIndex];
      this.secondaryIndex = (this.secondaryIndex + 1) % this.secondaryConnections.length;
      return connection;
    }
    return this.getConnection();
  }

  /**
   * Получает все основные соединения
   */
  getAllConnections(): Connection[] {
    return this.primaryConnections;
  }

  /**
   * Получает размер пула
   */
  getPoolSize(): number {
    return this.poolSize;
  }
}

// Singleton instance
let poolInstance: RpcConnectionPool | null = null;

export function getRpcPool(): RpcConnectionPool {
  if (!poolInstance) {
    poolInstance = new RpcConnectionPool(3); // 3 соединения по умолчанию
  }
  return poolInstance;
}


