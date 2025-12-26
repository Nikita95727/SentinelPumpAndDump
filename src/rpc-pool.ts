import { Connection } from '@solana/web3.js';
import { config } from './config';

/**
 * Пул RPC соединений для распределения нагрузки
 * Использует round-robin для распределения запросов между соединениями
 */
export class RpcConnectionPool {
  private connections: Connection[] = [];
  private currentIndex = 0;
  private poolSize: number;

  constructor(poolSize: number = 3) {
    this.poolSize = poolSize;
    this.initializeConnections();
  }

  private initializeConnections(): void {
    for (let i = 0; i < this.poolSize; i++) {
      this.connections.push(
        new Connection(config.heliusHttpUrl, {
          commitment: 'confirmed',
        })
      );
    }
  }

  /**
   * Получает следующее соединение из пула (round-robin)
   */
  getConnection(): Connection {
    const connection = this.connections[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.poolSize;
    return connection;
  }

  /**
   * Получает все соединения (для batch запросов)
   */
  getAllConnections(): Connection[] {
    return this.connections;
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

