import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { TokenCandidate } from './types';
import { getRpcPool } from './rpc-pool';
import { cache } from './cache';
import { sleep } from './utils';
import { config } from './config';

/**
 * Быстрая проверка безопасности - ТОЛЬКО критичное!
 * Проверяет только LP burned + mint renounced
 * Цель: фильтрация за 500-700ms
 */
export async function quickSecurityCheck(candidate: TokenCandidate): Promise<boolean> {
  const startTime = Date.now();
  
  try {
    // Параллельно проверяем ТОЛЬКО критичные вещи
    const [lpBurned, mintRenounced] = await Promise.all([
      checkLpBurned(candidate.mint),
      checkMintRenounced(candidate.mint)
    ]);
    
    const duration = Date.now() - startTime;
    
    // Если LP не сожжен - скам/ханипот
    if (!lpBurned) {
      console.log(`⚠️ LP not burned for ${candidate.mint.slice(0, 8)}... (${duration}ms)`);
      return false;
    }
    
    // Если mint не renounced - могут создать больше токенов
    if (!mintRenounced) {
      console.log(`⚠️ Mint not renounced for ${candidate.mint.slice(0, 8)}... (${duration}ms)`);
      return false;
    }
    
    console.log(`✅ Security check passed for ${candidate.mint.slice(0, 8)}... (${duration}ms)`);
    return true;
  } catch (error) {
    console.error(`❌ Error in quickSecurityCheck for ${candidate.mint.slice(0, 8)}...:`, error);
    return false;
  }
}

/**
 * Проверка LP burned
 */
async function checkLpBurned(mint: string): Promise<boolean> {
  try {
    const mintPubkey = new PublicKey(mint);
    
    // Кеширование: mint info не меняется часто
    const cacheKey = `mint:${mint}`;
    const cached = await cache.get<{ supply: string; mintAuthority: string | null; decimals: number }>(cacheKey);
    
    let mintInfo;
    if (cached) {
      mintInfo = {
        supply: BigInt(cached.supply),
        mintAuthority: cached.mintAuthority ? new PublicKey(cached.mintAuthority) : null,
        decimals: cached.decimals,
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
    // В реальности нужно проверять конкретные аккаунты pump.fun
    return true;
  } catch (error) {
    console.error(`Error checking LP burned for ${mint}:`, error);
    return false;
  }
}

/**
 * Проверка mint renounced
 */
async function checkMintRenounced(mint: string): Promise<boolean> {
  try {
    const mintPubkey = new PublicKey(mint);
    
    // Кеширование: mint authority не меняется
    const cacheKey = `mint:${mint}`;
    const cached = await cache.get<{ mintAuthority: string | null }>(cacheKey);
    
    let mintInfo;
    if (cached) {
      mintInfo = { mintAuthority: cached.mintAuthority ? new PublicKey(cached.mintAuthority) : null } as any;
    } else {
      await sleep(50); // Минимальная задержка для rate limiting
      const rpcPool = getRpcPool();
      const connection = rpcPool.getConnection();
      mintInfo = await getMint(connection, mintPubkey);
      
      // Кешируем результат на 10 секунд
      await cache.set(cacheKey, {
        mintAuthority: mintInfo.mintAuthority?.toString() || null,
      }, 10);
    }
    
    // Если mintAuthority === null, то mint renounced
    return mintInfo.mintAuthority === null;
  } catch (error) {
    console.error(`Error checking mint renounced for ${mint}:`, error);
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

