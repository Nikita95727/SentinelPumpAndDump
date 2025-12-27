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
 * Выполняет RPC запрос с timeout (1 секунда - агрессивный timeout)
 * Это критично для быстрой фильтрации токенов
 * Если RPC не отвечает за 1 секунду, токен уже старый
 */
async function getMintWithTimeout(connection: Connection, mintPubkey: PublicKey, timeoutMs: number = 1000): Promise<any> {
  const rpcTimeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('RPC timeout')), timeoutMs);
  });
  
  return Promise.race([
    getMint(connection, mintPubkey),
    rpcTimeout
  ]);
}

/**
 * Быстрая проверка безопасности - МАКСИМАЛЬНО УПРОЩЕННАЯ
 * Pipeline: локальные проверки → RPC mint check → кеш
 * Цель: фильтрация за <500ms, только критичные проверки
 * 
 * КРИТИЧНО: mintAuthority === null (защита от honeypot/scam)
 * Остальное: не критично для безопасности, убрано для скорости
 */
export async function quickSecurityCheck(candidate: TokenCandidate, skipFreezeCheck: boolean = false): Promise<boolean> {
  try {
    // ===== 1. LOCAL / ZERO-COST CHECKS (NO ASYNC, NO RPC) =====
    
    // 1.1. Исключаем SOL токен
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (candidate.mint === SOL_MINT) {
      return false;
    }
    
    // 1.2. Проверяем что адрес валидный (без RPC)
    // PublicKey валидация уже проверяет формат, длина не нужна
    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(candidate.mint);
    } catch (error) {
      return false; // Невалидный адрес
    }
    
    // ===== 2. SINGLE RPC CHECK (MANDATORY) =====
    // Проверяем ТОЛЬКО mintAuthority === null (критично для безопасности)
    // Убраны: decimals, supply, freezeAuthority (не критично для pump.fun)
    
    // 2.1. Проверяем микро-кеш (100ms TTL)
    const cacheKey = `mintAuth:${candidate.mint}`;
    const cached = getMicroCache<boolean>(cacheKey);
    if (cached !== null) {
      // Кеш попадание - используем кешированное значение
      return cached;
    }
    
    // 2.2. Проверяем Redis/общий кеш (10 секунд TTL)
    const sharedCacheKey = `mint:${candidate.mint}`;
    const sharedCached = await cache.get<{ 
      mintAuthority: string | null;
    }>(sharedCacheKey);
    
    let mintAuthority: PublicKey | null = null;
    if (sharedCached) {
      // Используем кешированные данные
      mintAuthority = sharedCached.mintAuthority ? new PublicKey(sharedCached.mintAuthority) : null;
    } else {
      // 2.3. RPC запрос (единственный обязательный) с timeout 1 секунда
      const rpcPool = getRpcPool();
      const connection = rpcPool.getConnection();
      try {
        const mintInfo = await getMintWithTimeout(connection, mintPubkey);
        mintAuthority = mintInfo.mintAuthority;
        
        // Кешируем в общий кеш (10 секунд) - только mintAuthority
        await cache.set(sharedCacheKey, {
          mintAuthority: mintAuthority?.toString() || null,
        }, 10);
      } catch (rpcError: any) {
        // RPC ошибка или timeout - токен может быть слишком новым или не существует
        // Не логируем на hot path, просто пропускаем
        return false;
      }
    }
    
    // 2.4. КРИТИЧНАЯ ПРОВЕРКА: mintAuthority должен быть null
    // Это защита от honeypot/scam токенов
    const mintRenounced = mintAuthority === null;
    
    // Кешируем результат в микро-кеш (100ms TTL)
    setMicroCache(cacheKey, mintRenounced, 100);
    
    return mintRenounced;
    
  } catch (error) {
    // Любая ошибка - пропускаем токен (не логируем на hot path)
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
      try {
        mintInfo = await getMintWithTimeout(connection, mintPubkey);
        
        // Кешируем результат на 10 секунд
        await cache.set(cacheKey, {
          supply: mintInfo.supply.toString(),
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
          decimals: mintInfo.decimals,
        }, 10);
      } catch (rpcError: any) {
        // Если RPC ошибка или timeout - токен может быть слишком новым
        return false;
      }
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
      try {
        mintInfo = await getMintWithTimeout(connection, mintPubkey);
        
        // Кешируем результат на 10 секунд
        await cache.set(cacheKey, {
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
        }, 10);
      } catch (rpcError: any) {
        // Если RPC ошибка или timeout - токен может быть слишком новым или не существует
        // Для pump.fun токенов это нормально на ранней стадии
        return false;
      }
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

