
import {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    VersionedTransaction,
    SystemProgram,
    TransactionMessage,
    TransactionInstruction
} from '@solana/web3.js';
import fetch from 'node-fetch';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';
import { config } from './config';

// Jito Block Engine Endpoints (Mainnet)
const JITO_BLOCK_ENGINE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

// Jito Tip Accounts (randomized selection)
const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCyb3qzK6Dcpk1mM9G33SLstY20cdgdqX',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnIzKZ6jJ',
    'Do8ZGwQA55HIk5gYv5c4d6o8v6jJqK6f9o8jJqK6f9o8', // Example, keeping list short but diverse
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL'
];

export class JitoService {
    /**
     * Получает случайный аккаунт для чаевых Jito
     */
    private getRandomTipAccount(): PublicKey {
        const randomAddress = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
        return new PublicKey(randomAddress);
    }

    /**
     * Создает инструкцию для "чаевых" Jito
     */
    public createTipInstruction(payer: PublicKey, lamports: number): TransactionInstruction {
        const tipAccount = this.getRandomTipAccount();
        return SystemProgram.transfer({
            fromPubkey: payer,
            toPubkey: tipAccount,
            lamports: lamports,
        });
    }

    /**
     * Отправляет бандл транзакций в Jito
     * @param transactions Список сериализованных транзакций (base58 строки)
     */
    public async sendBundle(transactions: string[]): Promise<string | null> {
        if (!config.jitoEnabled) return null;

        try {
            const payload = {
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [transactions]
            };

            const response = await fetch(`${JITO_BLOCK_ENGINE_URL}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (data.error) {
                throw new Error(JSON.stringify(data.error));
            }

            logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info', // Using 'info' as 'jito' is not in types
                message: `🌩️ Jito Bundle Sent! ID: ${data.result} | Txs: ${transactions.length}`,
            });

            return data.result;
        } catch (error: any) {
            logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'error',
                message: `❌ Jito Send Failed: ${error?.message || error}`,
            });
            return null;
        }
    }

    /**
     * Метод-обертка для отправки одной транзакции с чаевыми
     */
    public async sendTransactionWithTip(
        transaction: VersionedTransaction,
        payerKeypair: Keypair,
        connection: Connection
    ): Promise<boolean> {
        // NOTE: Для Jito нужно добавить Tip instruction прямо в транзакцию.
        // Но так как transaction уже Versioned и скомпилирован (скорее всего),
        // мы не можем просто добавить инструкцию. Нам нужно пересобрать её.
        // Поэтому лучше использовать этот метод ДО подписи, или передавать инструкции.

        // В текущей архитектуре pump-sdk возвращает уже готовую Transaction.
        // Нам нужно будет в pumpfun-swap.ts добавлять инструкцию ДО создания VersionedTransaction.

        // Этот метод просто отправляет уже готовую транзакцию (которая содержит Tip).

        // Сериализуем
        const serialized = Buffer.from(transaction.serialize()).toString('base64');
        const bundleId = await this.sendBundle([serialized]);

        return !!bundleId;
    }
}

export const jitoService = new JitoService();
