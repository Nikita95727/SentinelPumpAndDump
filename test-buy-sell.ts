import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './src/config';
import { TokenCandidate } from './src/types';
import { PumpFunSwap } from './src/pumpfun-swap';
import { WalletManager } from './src/wallet';
import { getCurrentTimestamp } from './src/utils';
import { PUMP_FUN_PROGRAM_ID } from './src/config';

// WebSocket import - using require to avoid TypeScript issues
const WS = require('ws');
type WS = any;

const MIN_TOKEN_AGE_SECONDS = 1; // Минимальный возраст токена (уменьшено для теста)
const MIN_BUY_AMOUNT_SOL = 0.001; // Минимальная сумма покупки (0.001 SOL)
const TEST_MODE = true; // Режим тестирования - только 1 токен

let tokensProcessed = 0;
let buySuccess = false;
let sellSuccess = false;

/**
 * Тестовый скрипт для проверки покупки и продажи в mainnet
 * Цель: проверить что транзакции проходят успешно
 */
async function testBuySell() {
  console.log('🧪 ===============================================');
  console.log('🧪 TEST MODE: Buy & Sell Test');
  console.log('🧪 ===============================================\n');

  // 1. Инициализация кошелька
  console.log('📝 Step 1: Initializing wallet...');
  if (!config.walletMnemonic) {
    throw new Error('❌ WALLET_MNEMONIC not set in .env');
  }

  const walletManager = new WalletManager();
  const walletInitialized = await walletManager.initialize(config.walletMnemonic);
  if (!walletInitialized) {
    throw new Error('❌ Failed to initialize wallet');
  }

  const keypair = walletManager.getKeypair();
  if (!keypair) {
    throw new Error('❌ Failed to get keypair');
  }

  const balance = await walletManager.getBalance();
  console.log(`✅ Wallet: ${walletManager.getPublicKey()?.toString()}`);
  console.log(`✅ Balance: ${balance.toFixed(6)} SOL\n`);

  if (balance < 0.01) {
    throw new Error(`❌ Insufficient balance: ${balance.toFixed(6)} SOL (need at least 0.01 SOL for testing)`);
  }

  // 2. Инициализация PumpFunSwap
  console.log('📝 Step 2: Initializing PumpFunSwap...');
  const connection = new Connection(config.heliusHttpUrl, {
    commitment: 'confirmed',
  });
  const pumpFunSwap = new PumpFunSwap(connection);
  console.log('✅ PumpFunSwap initialized\n');

  // 3. Подключение к WebSocket для получения токенов
  console.log('📝 Step 3: Connecting to Helius WebSocket...');
  const ws = new WS(config.heliusWsUrl);

  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    
    // Подписываемся на логи Pump.fun программы
    const subscribeMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        {
          mentions: [PUMP_FUN_PROGRAM_ID],
        },
        {
          commitment: 'confirmed',
        },
      ],
    };

    ws.send(JSON.stringify(subscribeMessage));
    console.log('✅ Subscribed to pump.fun program logs\n');
    console.log('⏳ Waiting for token creation...\n');
  });

  ws.on('message', async (data: any) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.method === 'logsNotification') {
        await handleLogNotification(message, connection, pumpFunSwap, keypair, walletManager, balance);
      } else if (message.result && typeof message.result === 'number') {
        console.log(`✅ Subscription confirmed, ID: ${message.result}\n`);
      }
    } catch (error: any) {
      console.error('❌ Error processing WebSocket message:', error);
    }
  });

  ws.on('error', (error: any) => {
    console.error('❌ WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('\n⚠️ WebSocket closed');
    if (!buySuccess || !sellSuccess) {
      console.log('❌ Test incomplete - WebSocket closed before completion');
      process.exit(1);
    }
  });
}

/**
 * Обработка уведомления о создании токена
 */
async function handleLogNotification(
  notification: any,
  connection: Connection,
  pumpFunSwap: PumpFunSwap,
  keypair: any,
  walletManager: WalletManager,
  balance: number
): Promise<void> {
  try {
    const logs = notification.params?.result?.value?.logs || [];
    const signature = notification.params?.result?.value?.signature;

    // Проверяем есть ли признак создания токена
    const hasTokenCreation = logs.some((log: string) => 
      log.includes('Program log:') && log.includes('initialize')
    );

    if (!hasTokenCreation) {
      return;
    }

    // Получаем транзакцию для извлечения mint address
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return;
    }

    // Извлекаем mint address из транзакции
    const mintAddress = extractMintFromTransaction(tx);
    if (!mintAddress) {
      return;
    }

    // Проверяем возраст токена
    const txTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    const tokenCreatedAt = txTime;
    const age = (Date.now() - tokenCreatedAt) / 1000;

    console.log(`\n🔍 Token detected: ${mintAddress.substring(0, 8)}...`);
    console.log(`   Age: ${age.toFixed(2)}s`);

    // Фильтр по возрасту
    if (age < MIN_TOKEN_AGE_SECONDS) {
      console.log(`   ⏭️  Too young (need ${MIN_TOKEN_AGE_SECONDS}s), skipping...\n`);
      return;
    }

    // Проверяем что это не SOL токен
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (mintAddress === SOL_MINT) {
      console.log(`   ⏭️  SOL token, skipping...\n`);
      return;
    }

    tokensProcessed++;
    console.log(`\n🎯 ===============================================`);
    console.log(`🎯 Processing token #${tokensProcessed}: ${mintAddress}`);
    console.log(`🎯 ===============================================\n`);

    // ПОКУПКА
    console.log(`📝 Step 4: BUYING ${MIN_BUY_AMOUNT_SOL} SOL worth of tokens...`);
    const buyResult = await pumpFunSwap.buy(keypair, mintAddress, MIN_BUY_AMOUNT_SOL);

    if (!buyResult.success) {
      let errorMsg = 'Unknown error';
      const error: any = buyResult.error;
      
      if (error instanceof Error) {
        errorMsg = error.message;
        if (error.stack) {
          console.error(`   Stack: ${error.stack.substring(0, 500)}`);
        }
      } else if (typeof error === 'string') {
        errorMsg = error;
      } else if (error && typeof error === 'object') {
        // Извлекаем сообщение из объекта ошибки
        if (error.message) {
          errorMsg = error.message;
        } else if (error.error) {
          errorMsg = error.error;
        } else if (error.logs && Array.isArray(error.logs)) {
          errorMsg = error.logs.join('; ');
        } else {
          // Пытаемся найти любое строковое поле
          const stringFields = Object.values(error).filter((v: any) => typeof v === 'string');
          if (stringFields.length > 0) {
            errorMsg = stringFields[0] as string;
          } else {
            errorMsg = JSON.stringify(error, null, 2);
          }
        }
        
        // Выводим полный объект для отладки
        console.error(`   Full error object:`, JSON.stringify(error, null, 2));
      }
      
      console.error(`❌ BUY FAILED: ${errorMsg}`);
      console.log('\n⚠️ Test incomplete - BUY failed');
      process.exit(1);
    }

    buySuccess = true;
    console.log(`✅ BUY SUCCESS: ${buyResult.signature}`);
    console.log(`   Explorer: https://solscan.io/tx/${buyResult.signature}\n`);

    // Ждем немного перед продажей
    console.log('⏳ Waiting 3 seconds before SELL...\n');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Получаем баланс токенов для продажи
    console.log(`📝 Step 5: Getting token balance...`);
    const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');
    const ata = await getAssociatedTokenAddress(
      new PublicKey(mintAddress),
      keypair.publicKey
    );

    let tokenBalance = 0;
    try {
      const tokenAccount = await getAccount(connection, ata);
      tokenBalance = Number(tokenAccount.amount);
      console.log(`✅ Token balance: ${tokenBalance}\n`);
    } catch (error) {
      console.error(`❌ Failed to get token balance: ${error}`);
      console.log('\n⚠️ Test incomplete - failed to get token balance');
      process.exit(1);
    }

    if (tokenBalance === 0) {
      console.error(`❌ Token balance is 0 - cannot sell`);
      console.log('\n⚠️ Test incomplete - no tokens to sell');
      process.exit(1);
    }

    // ПРОДАЖА
    console.log(`📝 Step 6: SELLING ${tokenBalance} tokens...`);
    const sellResult = await pumpFunSwap.sell(keypair, mintAddress, tokenBalance);

    if (!sellResult.success) {
      console.error(`❌ SELL FAILED: ${sellResult.error}`);
      console.log('\n⚠️ Test incomplete - SELL failed');
      process.exit(1);
    }

    sellSuccess = true;
    console.log(`✅ SELL SUCCESS: ${sellResult.signature}`);
    console.log(`   Explorer: https://solscan.io/tx/${sellResult.signature}\n`);

    // Финальный баланс
    const finalBalance = await walletManager.getBalance();
    console.log(`\n🎉 ===============================================`);
    console.log(`🎉 TEST COMPLETE - Both BUY and SELL successful!`);
    console.log(`🎉 ===============================================`);
    console.log(`   Initial balance: ${balance.toFixed(6)} SOL`);
    console.log(`   Final balance: ${finalBalance.toFixed(6)} SOL`);
    console.log(`   Change: ${(finalBalance - balance >= 0 ? '+' : '')}${(finalBalance - balance).toFixed(6)} SOL\n`);

    // Выходим после успешного теста
    process.exit(0);

  } catch (error) {
    console.error('❌ Error handling log notification:', error);
  }
}

/**
 * Извлекает mint address из транзакции
 */
function extractMintFromTransaction(tx: any): string | null {
  try {
    // Приоритет 1: postTokenBalances
    const postTokenBalances = tx.meta?.postTokenBalances || [];
    for (const balance of postTokenBalances) {
      if (balance.mint) {
        return balance.mint;
      }
    }

    // Приоритет 2: preTokenBalances
    const preTokenBalances = tx.meta?.preTokenBalances || [];
    for (const balance of preTokenBalances) {
      if (balance.mint) {
        return balance.mint;
      }
    }

    // Приоритет 3: instruction accounts
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const accountKeysArray = accountKeys.map((acc: any) => 
      typeof acc === 'string' ? acc : acc.pubkey
    );
    const instructions = tx.transaction?.message?.instructions || [];
    for (const instruction of instructions) {
      const programId = typeof instruction.programId === 'string' 
        ? instruction.programId 
        : instruction.programId?.toString();
      
      if (programId === PUMP_FUN_PROGRAM_ID) {
        const accounts = instruction.accounts || [];
        for (const accountIndex of accounts) {
          if (typeof accountIndex === 'number' && accountKeysArray[accountIndex]) {
            const potentialMint = accountKeysArray[accountIndex];
            if (potentialMint && 
                potentialMint !== '11111111111111111111111111111111' &&
                potentialMint !== 'So11111111111111111111111111111111111111112') {
              return potentialMint;
            }
          }
        }
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

// Запуск теста
testBuySell().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

