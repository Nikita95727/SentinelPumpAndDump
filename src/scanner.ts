import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, PUMP_FUN_PROGRAM_ID } from './config';
import { TokenCandidate } from './types';
import { logger } from './logger';
import { getCurrentTimestamp, sleep } from './utils';

export class TokenScanner {
  private ws: WebSocket | null = null;
  private connection: Connection;
  private subscriptionId: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private isShuttingDown = false;
  private onNewTokenCallback: (candidate: TokenCandidate) => void;

  constructor(onNewToken: (candidate: TokenCandidate) => void) {
    this.onNewTokenCallback = onNewToken;
    this.connection = new Connection(config.heliusHttpUrl, {
      commitment: 'confirmed',
    });
  }

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      // Убеждаемся, что URL начинается с wss://
      let wsUrl = config.heliusWsUrl;
      if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) {
        wsUrl = wsUrl.replace('https://', 'wss://').replace('http://', 'ws://');
      }
      if (wsUrl.startsWith('https://')) {
        wsUrl = wsUrl.replace('https://', 'wss://');
      }
      
      console.log(`Connecting to WebSocket: ${wsUrl.substring(0, 60)}...`);
      
      // Добавляем заголовки для WebSocket подключения
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://helius.dev',
        },
      });

      this.ws.on('open', () => {
        console.log('WebSocket connected to Helius');
        this.reconnectAttempts = 0;
        this.subscribe();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        console.error('WebSocket error:', error);
        console.error('Error details:', {
          message: error.message,
          stack: error.stack,
          name: error.name,
        });
        logger.log({
          timestamp: getCurrentTimestamp(),
          type: 'error',
          message: `WebSocket error: ${error.message}`,
        });
      });

      this.ws.on('close', () => {
        console.log('WebSocket closed');
        if (!this.isShuttingDown && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          setTimeout(() => this.connect(), this.reconnectDelay);
        }
      });

    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to connect WebSocket: ${error instanceof Error ? error.message : String(error)}`,
      });
      
      if (!this.isShuttingDown && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), this.reconnectDelay);
      }
    }
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const programId = new PublicKey(PUMP_FUN_PROGRAM_ID);
      
      // Подписка на логи программы pump.fun
      // Helius использует стандартный Solana WebSocket RPC формат
      const subscribeMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          {
            mentions: [programId.toBase58()],
          },
          {
            commitment: 'confirmed',
            encoding: 'jsonParsed',
          },
        ],
      };

      this.ws.send(JSON.stringify(subscribeMessage));
      console.log('Subscribed to pump.fun program logs');
    } catch (error) {
      console.error('Failed to subscribe:', error);
      logger.log({
        timestamp: getCurrentTimestamp(),
        type: 'error',
        message: `Failed to subscribe to logs: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message = JSON.parse(data.toString());

      // Обработка ответа на подписку
      if (message.id === 1 && message.result) {
        this.subscriptionId = message.result;
        console.log(`Subscription confirmed, ID: ${this.subscriptionId}`);
        return;
      }

      // Обработка уведомлений о логах
      if (message.method === 'logsNotification' && message.params) {
        const notification = message.params;
        await this.processLogNotification(notification);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  private async processLogNotification(notification: any): Promise<void> {
    try {
      // Задержка перед обработкой уведомления для соблюдения rate limit
      // Это предотвращает обработку слишком большого количества токенов одновременно
      await sleep(200); // 200ms между обработкой уведомлений = ~5 токенов/сек
      
      const signature = notification.result.value.signature;
      const logs = notification.result.value.logs || [];

      // Ищем события создания токена
      // pump.fun использует специфичные логи для создания токена
      const createTokenLogs = logs.filter((log: string) => 
        log.includes('initialize') || 
        log.includes('Create') ||
        log.includes('mint')
      );

      if (createTokenLogs.length > 0) {
        // Получаем детали транзакции для извлечения mint адреса
        // Добавляем дополнительную задержку перед запросом транзакции
        await sleep(100);
        
        const tx = await this.connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (!tx) return;

        // Ищем mint адрес в инструкциях
        const mintAddress = this.extractMintFromTransaction(tx);
        
        if (mintAddress) {
          const candidate: TokenCandidate = {
            mint: mintAddress,
            createdAt: Date.now(),
            signature: signature,
          };

          this.onNewTokenCallback(candidate);
        }
      }
    } catch (error: any) {
      // Обработка rate limiting
      if (error?.message?.includes('429') || error?.message?.includes('rate limit')) {
        await sleep(2000); // Увеличиваем задержку при rate limit
      }
      console.error('Error processing log notification:', error);
    }
  }

  private extractMintFromTransaction(tx: any): string | null {
    try {
      // Способ 1: Ищем mint в postTokenBalances
      const tokenBalances = tx.meta?.postTokenBalances || [];
      const mintSet = new Set<string>();
      
      for (const balance of tokenBalances) {
        if (balance.mint) {
          mintSet.add(balance.mint);
        }
      }

      // Способ 2: Ищем в preTokenBalances (для новых токенов может быть пусто)
      const preTokenBalances = tx.meta?.preTokenBalances || [];
      for (const balance of preTokenBalances) {
        if (balance.mint) {
          mintSet.add(balance.mint);
        }
      }

      // Способ 3: Ищем новые аккаунты, которые могут быть mint
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const accountKeysArray = accountKeys.map((acc: any) => 
        typeof acc === 'string' ? acc : acc.pubkey
      );

      // Способ 4: Анализируем инструкции pump.fun
      const instructions = tx.transaction?.message?.instructions || [];
      for (const instruction of instructions) {
        const programId = typeof instruction.programId === 'string' 
          ? instruction.programId 
          : instruction.programId?.toString();
        
        if (programId === PUMP_FUN_PROGRAM_ID) {
          // В pump.fun инструкция создания токена обычно содержит mint в accounts
          const accounts = instruction.accounts || [];
          for (const accountIndex of accounts) {
            if (typeof accountIndex === 'number' && accountKeysArray[accountIndex]) {
              const potentialMint = accountKeysArray[accountIndex];
              // Проверяем, что это не системные аккаунты
              if (potentialMint && 
                  potentialMint !== '11111111111111111111111111111111' &&
                  potentialMint !== 'So11111111111111111111111111111111111111112') {
                mintSet.add(potentialMint);
              }
            }
          }
        }
      }

      // Возвращаем первый найденный mint (обычно в pump.fun создается один токен за транзакцию)
      if (mintSet.size > 0) {
        return Array.from(mintSet)[0];
      }

      return null;
    } catch (error) {
      console.error('Error extracting mint from transaction:', error);
      return null;
    }
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;

    if (this.subscriptionId !== null && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const unsubscribeMessage = {
          jsonrpc: '2.0',
          id: 2,
          method: 'logsUnsubscribe',
          params: [this.subscriptionId],
        };
        this.ws.send(JSON.stringify(unsubscribeMessage));
      } catch (error) {
        console.error('Error unsubscribing:', error);
      }
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

