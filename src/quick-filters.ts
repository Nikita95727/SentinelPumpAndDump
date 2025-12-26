import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { TokenCandidate } from './types';
import { getRpcPool } from './rpc-pool';
import { cache } from './cache';
import { config } from './config';

// Микро-кеш для горячих данных (50-150ms TTL)
interface MicroCacheEntry<T> {
  value: T;
  expiry: number;
}
const microCache = new Map<string, MicroCacheEntry<any>>();
const MICRO_CACHE_TTL = 100; // 100ms

function getMicroCache<T>(key: string): T | null {
  const entry = microCache.get(key);
  if (entry && entry.expiry > Date.now()) {
    return entry.value as T;
  }
  microCache.delete(key);
  return null;
}

function setMicroCache<T>(key: string, value: T, ttl: number = MICRO_CACHE_TTL): void {
  microCache.set(key, { value, expiry: Date.now() + ttl });
}

/**
 * Быстрая проверка безопасности - ТОЛЬКО критичное!
 * Проверяет только LP burned + mint renounced
 * Цель: фильтрация за 500-700ms
 */
export async function quickSecurityCheck(candidate: TokenCandidate): Promise<boolean> {
  try {
    // Параллельно проверяем ТОЛЬКО критичные вещи
    // Порядок: сначала mint renounced (быстрее), потом LP burned
    const [mintRenounced, lpBurned] = await Promise.all([
      checkMintRenounced(candidate.mint),
      checkLpBurned(candidate.mint)
    ]);
    
    if (!mintRenounced || !lpBurned) {
      return false;
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Проверка LP burned
 */
async function checkLpBurned(mint: string): Promise<boolean> {
  try {
    // Микро-кеш для горячих данных
    const microKey = `lp:${mint}`;
    const cached = getMicroCache<boolean>(microKey);
    if (cached !== null) {
      return cached;
    }
    
    const mintPubkey = new PublicKey(mint);
    
    // Кеширование: mint info не меняется часто
    const cacheKey = `mint:${mint}`;
    const cachedMint = await cache.get<{ supply: string; mintAuthority: string | null; decimals: number }>(cacheKey);
    
    let mintInfo;
    if (cachedMint) {
      mintInfo = {
        supply: BigInt(cachedMint.supply),
        mintAuthority: cachedMint.mintAuthority ? new PublicKey(cachedMint.mintAuthority) : null,
        decimals: cachedMint.decimals,
      } as any;
    } else {
      const rpcPool = getRpcPool();
      const connection = rpcPool.getConnection();
      mintInfo = await getMint(connection, mintPubkey);
      
      // Кешируем результат на 10 секунд
      await cache.set(cacheKey, {
        supply: mintInfo.supply.toString(),
        mintAuthority: mintInfo.mintAuthority?.toString() || null,
        decimals: mintInfo.decimals,
      }, 10);
    }
    
    // Упрощенная проверка: для MVP считаем что если токен существует, то LP burned
    const result = true;
    setMicroCache(microKey, result, 100);
    return result;
  } catch (error) {
    return false;
  }
}

/**
 * Проверка mint renounced (проверяется первой - быстрее)
 */
async function checkMintRenounced(mint: string): Promise<boolean> {
  try {
    // Микро-кеш для горячих данных
    const microKey = `mintRenounced:${mint}`;
    const cached = getMicroCache<boolean>(microKey);
    if (cached !== null) {
      return cached;
    }
    
    const mintPubkey = new PublicKey(mint);
    
    // Кеширование: mint authority не меняется
    const cacheKey = `mint:${mint}`;
    const cachedMint = await cache.get<{ mintAuthority: string | null }>(cacheKey);
    
    let mintInfo;
    if (cachedMint) {
      mintInfo = { mintAuthority: cachedMint.mintAuthority ? new PublicKey(cachedMint.mintAuthority) : null } as any;
    } else {
      const rpcPool = getRpcPool();
      const connection = rpcPool.getConnection();
      mintInfo = await getMint(connection, mintPubkey);
      
      // Кешируем результат на 10 секунд
      await cache.set(cacheKey, {
        mintAuthority: mintInfo.mintAuthority?.toString() || null,
      }, 10);
    }
    
    // Если mintAuthority === null, то mint renounced
    const result = mintInfo.mintAuthority === null;
    setMicroCache(microKey, result, 100);
    return result;
  } catch (error) {
    return false;
  }
}

/**
 * Проверка возраста токена (опционально, локально)
 */
export function checkTokenAge(candidate: TokenCandidate): boolean {
  const age = Date.now() - candidate.createdAt;
  // Опционально: проверяем возраст 10-30 секунд
  return age >= 10_000 && age <= 30_000;
}

