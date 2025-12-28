// src/solana/ata.ts
// ⚠️ DO NOT MODIFY THIS FILE
// This code is Solana plumbing. Wrong programId burns SOL.
// ONLY use SPL helpers for ATA creation.

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Returns the ATA address for (mint, owner).
 */
export async function getAtaAddress(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  // allowOwnerOffCurve = true is safe and avoids edge cases
  return getAssociatedTokenAddress(mint, owner, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/**
 * Builds an ATA create instruction ONLY if ATA does not exist.
 * - Uses getAccountInfo (1 RPC) to avoid burning fees on failed create.
 * - Never constructs ATA instruction manually.
 */
export async function buildCreateAtaIfMissingIx(params: {
  connection: Connection;
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): Promise<{ ata: PublicKey; ix: TransactionInstruction | null }> {
  const { connection, payer, owner, mint } = params;

  const ata = await getAtaAddress(mint, owner);

  // ✅ IMPROVEMENT: Используем confirmed commitment для более надежной проверки
  // ✅ IMPROVEMENT: Дополнительно проверяем через SPL Token getAccount для валидации
  try {
    const account = await getAccount(connection, ata, "confirmed");
    // Дополнительная проверка: убеждаемся что это правильный ATA
    if (account.owner.equals(owner) && account.mint.equals(mint)) {
      return { ata, ix: null };
    }
  } catch (error: any) {
    // Account не существует или ошибка - нужно создать
    // Игнорируем ожидаемые ошибки (account not found)
    const errorMsg = error?.message || String(error);
    if (!errorMsg.includes('InvalidAccountData') && 
        !errorMsg.includes('could not find account') &&
        !errorMsg.includes('AccountNotFound')) {
      // Неожиданная ошибка - логируем, но продолжаем создание
      console.warn(`[ATA] Unexpected error checking ATA ${ata.toString()}: ${errorMsg}`);
    }
  }

  const ix = createAssociatedTokenAccountInstruction(
    payer,   // payer funds the account creation
    ata,     // associated token account address
    owner,   // owner of the ATA
    mint,    // token mint
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return { ata, ix };
}

