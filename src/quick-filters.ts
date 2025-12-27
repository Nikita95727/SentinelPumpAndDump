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
 * Быстрая проверка безопасности - ОПТИМИЗИРОВАННАЯ
 * Pipeline: локальные проверки → RPC mint check → кеш
 * Цель: фильтрация за <30-40ms, максимальная надежность
 * @param skipFreezeCheck - для queue1 можно пропустить проверку freezeAuthority (ускорение)
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
    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(candidate.mint);
    } catch (error) {
      return false; // Невалидный адрес
    }
    
    // 1.3. Heuristic: pump.fun токены обычно имеют длину 44 символа (base58)
    // Слишком короткие адреса - вероятно не валидные токены
    if (candidate.mint.length < 32 || candidate.mint.length > 44) {
      return false;
    }
    
    // ===== 2. SINGLE RPC CHECK (MANDATORY) =====
    // Проверяем mint account: mintAuthority === null, freezeAuthority === null
    
    // 2.1. Проверяем микро-кеш (50-150ms TTL)
    const cacheKey = `mintAuth:${candidate.mint}`;
    const cached = getMicroCache<{ mintAuthority: boolean; freezeAuthority: boolean }>(cacheKey);
    if (cached !== null) {
      // Кеш попадание - используем кешированное значение
      return cached.mintAuthority && cached.freezeAuthority;
    }
    
    // 2.2. Проверяем Redis/общий кеш (более долгий TTL)
    const sharedCacheKey = `mint:${candidate.mint}`;
    const sharedCached = await cache.get<{ 
      mintAuthority: string | null; 
      freezeAuthority: string | null;
      decimals: number;
      supply: string;
    }>(sharedCacheKey);
    
    let mintInfo: any;
    if (sharedCached) {
      // Используем кешированные данные
      mintInfo = {
        mintAuthority: sharedCached.mintAuthority ? new PublicKey(sharedCached.mintAuthority) : null,
        freezeAuthority: sharedCached.freezeAuthority ? new PublicKey(sharedCached.freezeAuthority) : null,
        decimals: sharedCached.decimals,
        supply: BigInt(sharedCached.supply),
      };
    } else {
      // 2.3. RPC запрос (единственный обязательный)
      const rpcPool = getRpcPool();
      const connection = rpcPool.getConnection();
      try {
        mintInfo = await getMint(connection, mintPubkey);
        
        // Кешируем в общий кеш (10 секунд)
        await cache.set(sharedCacheKey, {
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
          freezeAuthority: mintInfo.freezeAuthority?.toString() || null,
          decimals: mintInfo.decimals,
          supply: mintInfo.supply.toString(),
        }, 10);
      } catch (rpcError: any) {
        // RPC ошибка - токен может быть слишком новым или не существует
        // Не логируем на hot path, просто пропускаем
        return false;
      }
    }
    
    // 2.4. Валидация mint params (если доступны)
    // Проверяем decimals в разумном диапазоне (6-9 для pump.fun)
    if (mintInfo.decimals !== undefined) {
      if (mintInfo.decimals < 6 || mintInfo.decimals > 9) {
        return false;
      }
    }
    
    // Проверяем supply > 0
    if (mintInfo.supply !== undefined) {
      if (mintInfo.supply === BigInt(0) || mintInfo.supply < BigInt(0)) {
        return false;
      }
    }
    
    // 2.5. Критичные проверки: mintAuthority и freezeAuthority должны быть null
    const mintRenounced = mintInfo.mintAuthority === null;
    // freezeAuthority может отсутствовать в старых версиях, считаем null = безопасно
    const freezeRenounced = mintInfo.freezeAuthority === null || mintInfo.freezeAuthority === undefined;
    
    // Кешируем результат в микро-кеш (100ms TTL)
    setMicroCache(cacheKey, {
      mintAuthority: mintRenounced,
      freezeAuthority: freezeRenounced,
    }, 100);
    
    // Для queue1 можно пропустить проверку freezeAuthority (ускорение, минимальный риск)
    if (skipFreezeCheck) {
      return mintRenounced; // Только mintAuthority проверка
    }
    
    // Обе проверки должны пройти
    return mintRenounced && freezeRenounced;
    
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
        mintInfo = await getMint(connection, mintPubkey);
        
        // Кешируем результат на 10 секунд
        await cache.set(cacheKey, {
          supply: mintInfo.supply.toString(),
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
          decimals: mintInfo.decimals,
        }, 10);
      } catch (rpcError: any) {
        // Если RPC ошибка - токен может быть слишком новым
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
        mintInfo = await getMint(connection, mintPubkey);
        
        // Кешируем результат на 10 секунд
        await cache.set(cacheKey, {
          mintAuthority: mintInfo.mintAuthority?.toString() || null,
        }, 10);
      } catch (rpcError: any) {
        // Если RPC ошибка - токен может быть слишком новым или не существует
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

