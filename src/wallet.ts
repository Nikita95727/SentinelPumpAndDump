import { Keypair } from '@solana/web3.js';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';
import { getRpcPool } from './rpc-pool';

/**
 * Wallet Manager
 * Управляет Solana кошельком на основе seed-фразы
 */
export class WalletManager {
  private keypair: Keypair | null = null;
  private publicKey: PublicKey | null = null;
  private rpcPool = getRpcPool();

  /**
   * Инициализирует кошелек из seed-фразы
   * @param mnemonic - seed-фраза (12 или 24 слова)
   * @param derivationPath - путь деривации (по умолчанию m/44'/501'/0'/0' для Solana)
   * @returns true если успешно, false если ошибка
   */
  async initialize(mnemonic: string, derivationPath: string = "m/44'/501'/0'/0'"): Promise<boolean> {
    try {
      // Валидация seed-фразы
      const normalizedMnemonic = mnemonic.trim();
      if (!bip39.validateMnemonic(normalizedMnemonic)) {
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: 'Invalid mnemonic phrase',
        });
        return false;
      }

      // Генерируем seed из mnemonic (возвращает Buffer)
      const seedBuffer = await bip39.mnemonicToSeed(normalizedMnemonic);
      
      // Деривируем ключ по стандартному пути Solana (m/44'/501'/0'/0')
      // ed25519-hd-key использует hex строку для seed
      const derivedResult = derivePath(derivationPath, seedBuffer.toString('hex'));
      
      // derivedResult.key - это уже Buffer (32 байта для ed25519)
      // Используем его напрямую для создания Keypair
      this.keypair = Keypair.fromSeed(derivedResult.key);
      this.publicKey = this.keypair.publicKey;

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Wallet initialized: ${this.publicKey.toString()}`,
      });

      return true;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error initializing wallet: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }

  /**
   * Получает публичный адрес кошелька
   */
  getPublicKey(): PublicKey | null {
    return this.publicKey;
  }

  /**
   * Получает публичный адрес в виде строки
   */
  getPublicKeyString(): string | null {
    return this.publicKey?.toString() || null;
  }

  /**
   * Получает Keypair (для подписания транзакций)
   * ВНИМАНИЕ: Не использовать в production без дополнительной защиты!
   */
  getKeypair(): Keypair | null {
    return this.keypair;
  }

  /**
   * Получает баланс кошелька в SOL
   */
  async getBalance(): Promise<number> {
    if (!this.publicKey) {
      throw new Error('Wallet not initialized');
    }

    try {
      const connection = this.rpcPool.getConnection();
      const balance = await connection.getBalance(this.publicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * Получает баланс кошелька в lamports
   */
  async getBalanceLamports(): Promise<number> {
    if (!this.publicKey) {
      throw new Error('Wallet not initialized');
    }

    try {
      const connection = this.rpcPool.getConnection();
      const balance = await connection.getBalance(this.publicKey);
      return balance;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * Проверяет, инициализирован ли кошелек
   */
  isInitialized(): boolean {
    return this.keypair !== null && this.publicKey !== null;
  }

  /**
   * Получает список SPL токенов кошелька
   */
  async getTokenAccounts(): Promise<Array<{
    mint: string;
    balance: number;
    decimals: number;
    address: string;
  }>> {
    if (!this.publicKey) {
      throw new Error('Wallet not initialized');
    }

    try {
      const connection = this.rpcPool.getConnection();
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(this.publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      });

      const tokens: Array<{
        mint: string;
        balance: number;
        decimals: number;
        address: string;
      }> = [];

      for (const accountInfo of tokenAccounts.value) {
        const parsedInfo = accountInfo.account.data.parsed?.info;
        if (parsedInfo) {
          const mint = parsedInfo.mint;
          const tokenAmount = parsedInfo.tokenAmount;
          const balance = tokenAmount.uiAmount || 0;
          const decimals = tokenAmount.decimals || 0;

          tokens.push({
            mint,
            balance,
            decimals,
            address: accountInfo.pubkey.toString(),
          });
        }
      }

      return tokens;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting token accounts: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * Получает баланс конкретного SPL токена
   */
  async getTokenBalance(tokenMint: string): Promise<number> {
    if (!this.publicKey) {
      throw new Error('Wallet not initialized');
    }

    try {
      const mintPubkey = new PublicKey(tokenMint);
      const connection = this.rpcPool.getConnection();
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(this.publicKey, {
        mint: mintPubkey,
      });

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      const tokenAmount = tokenAccounts.value[0].account.data.parsed?.info?.tokenAmount;
      return tokenAmount?.uiAmount || 0;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting token balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * Получает recent blockhash для создания транзакций
   */
  async getRecentBlockhash(): Promise<string> {
    if (!this.publicKey) {
      throw new Error('Wallet not initialized');
    }

    try {
      const connection = this.rpcPool.getConnection();
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      return blockhash;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting recent blockhash: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * Проверяет, достаточно ли баланса для транзакции
   * @param requiredSol - требуемый баланс в SOL (включая комиссии)
   */
  async hasEnoughBalance(requiredSol: number): Promise<boolean> {
    const balance = await this.getBalance();
    return balance >= requiredSol;
  }

  /**
   * Получает минимальный баланс для rent exemption аккаунта
   */
  async getMinimumBalanceForRentExemption(dataLength: number): Promise<number> {
    try {
      const connection = this.rpcPool.getConnection();
      const rent = await connection.getMinimumBalanceForRentExemption(dataLength);
      return rent / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting minimum balance: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * Получает информацию о последних транзакциях кошелька
   */
  async getRecentTransactions(limit: number = 10): Promise<Array<{
    signature: string;
    blockTime: number | null;
    success: boolean;
  }>> {
    if (!this.publicKey) {
      throw new Error('Wallet not initialized');
    }

    try {
      const connection = this.rpcPool.getConnection();
      const signatures = await connection.getSignaturesForAddress(this.publicKey, { limit });

      return signatures.map((sig: any) => ({
        signature: sig.signature,
        blockTime: sig.blockTime ?? null,
        success: sig.err === null,
      }));
    } catch (error) {
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Error getting recent transactions: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  /**
   * Тестовая функция для проверки работы кошелька
   */
  async testConnection(): Promise<{
    success: boolean;
    publicKey: string | null;
    balance: number | null;
    error?: string;
  }> {
    try {
      if (!this.isInitialized()) {
        return {
          success: false,
          publicKey: null,
          balance: null,
          error: 'Wallet not initialized',
        };
      }

      const publicKey = this.getPublicKeyString();
      const balance = await this.getBalance();

      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'info',
        message: `Wallet test: publicKey=${publicKey}, balance=${balance.toFixed(6)} SOL`,
      });

      return {
        success: true,
        publicKey,
        balance,
      };
    } catch (error) {
      return {
        success: false,
        publicKey: this.getPublicKeyString(),
        balance: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// Singleton instance
export const walletManager = new WalletManager();

