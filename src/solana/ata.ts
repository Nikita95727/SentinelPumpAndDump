// src/solana/ata.ts
// ⚠️ DO NOT MODIFY THIS FILE
// This code is Solana plumbing. Wrong programId burns SOL.
// ONLY use SPL helpers for ATA creation.

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
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

  const info = await connection.getAccountInfo(ata, "processed");
  if (info) {
    return { ata, ix: null };
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

