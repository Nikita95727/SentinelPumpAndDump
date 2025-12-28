/**
 * Readiness Checker - проверка готовности токена для BUY
 * Использует только read-only RPC вызовы для проверки готовности
 * Проверяет существование mint account и bonding curve account
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';
import { PUMP_FUN_PROGRAM_ID } from './config';

const PUMP_FUN_BONDING_CURVE_SEED = 'bonding-curve';

/**
 * Получает PDA адрес bonding curve для токена
 */
async function getBondingCurvePDA(mintAddress: string): Promise<PublicKey> {
  const [pda] = await PublicKey.findProgramAddress(
    [
      Buffer.from(PUMP_FUN_BONDING_CURVE_SEED),
      new PublicKey(mintAddress).toBuffer()
    ],
    new PublicKey(PUMP_FUN_PROGRAM_ID)
  );
  return pda;
}

/**
 * Проверяет готовность токена для покупки
 * @returns true если токен готов, false если нет
 */
export async function checkTokenReadiness(
  connection: Connection,
  mintAddress: string
): Promise<boolean> {
  try {
    const mintPubkey = new PublicKey(mintAddress);

    // Проверка 1: Mint account должен существовать
    const mintAccountInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
    if (!mintAccountInfo || mintAccountInfo.data.length === 0) {
      return false; // Mint не существует
    }

    // Проверка 2: Bonding curve account должен существовать
    // Pump.fun использует PDA для bonding curve: [mint, "bonding-curve"]
    const bondingCurvePDA = await getBondingCurvePDA(mintAddress);
    const bondingCurveInfo = await connection.getAccountInfo(bondingCurvePDA, 'confirmed');
    
    if (!bondingCurveInfo || bondingCurveInfo.data.length === 0) {
      return false; // Bonding curve не существует - токен не готов
    }

    // Проверка 3: Bonding curve должен принадлежать Pump.fun программе
    if (!bondingCurveInfo.owner.equals(new PublicKey(PUMP_FUN_PROGRAM_ID))) {
      return false; // Неправильный owner
    }

    // Все проверки пройдены - токен готов
    return true;
  } catch (error: any) {
    // При ошибке считаем токен не готовым
    return false;
  }
}

/**
 * Проверяет готовность токена с детальным логированием
 */
export async function checkTokenReadinessDetailed(
  connection: Connection,
  mintAddress: string
): Promise<{ ready: boolean; details: any }> {
  try {
    const mintPubkey = new PublicKey(mintAddress);
    const mintAccountInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
    
    const bondingCurvePDA = await getBondingCurvePDA(mintAddress);
    const bondingCurveInfo = await connection.getAccountInfo(bondingCurvePDA, 'confirmed');
    
    const details = {
      mintExists: mintAccountInfo !== null,
      mintDataLength: mintAccountInfo?.data.length || 0,
      mintOwner: mintAccountInfo?.owner.toString() || null,
      bondingCurveExists: bondingCurveInfo !== null,
      bondingCurveDataLength: bondingCurveInfo?.data.length || 0,
      bondingCurveOwner: bondingCurveInfo?.owner.toString() || null,
      bondingCurvePDA: bondingCurvePDA.toString(),
    };
    
    const ready = 
      mintAccountInfo !== null && 
      mintAccountInfo.data.length > 0 &&
      bondingCurveInfo !== null &&
      bondingCurveInfo.data.length > 0 &&
      bondingCurveInfo.owner.equals(new PublicKey(PUMP_FUN_PROGRAM_ID));
    
    return { ready, details };
  } catch (error: any) {
    return {
      ready: false,
      details: { error: error.message },
    };
  }
}

