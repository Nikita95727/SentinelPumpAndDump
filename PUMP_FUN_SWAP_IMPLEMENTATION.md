# 🔥 Pump.fun Swap Implementation Guide

## ⚡ Цель: Реализовать Real Trading за 1-2 часа

---

## 🎯 Что Нужно Реализовать

### Pump.fun Bonding Curve Swap

**Адрес программы:** `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`

**Что нужно:**
1. **Buy:** SOL → Token через bonding curve
2. **Sell:** Token → SOL через bonding curve

---

## 🔍 Варианты Реализации (от простого к сложному)

### ✅ Вариант 1: Jupiter Aggregator API (Рекомендуется, 30 минут)

**Описание:** Jupiter - самый популярный Solana DEX aggregator, поддерживает pump.fun

**Преимущества:**
- ✅ Готовый API
- ✅ Автоматический routing
- ✅ Slippage protection
- ✅ Лучшие цены

**Код:**

```typescript
// src/jupiter-swap.ts
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import fetch from 'node-fetch';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

// SOL mint address
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export class JupiterSwap {
  constructor(private connection: Connection) {}
  
  /**
   * Получить quote для swap
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number, // в lamports
    slippageBps: number = 300 // 3% slippage
  ): Promise<any> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false',
      asLegacyTransaction: 'false',
    });
    
    const response = await fetch(`${JUPITER_QUOTE_API}?${params}`);
    const quote = await response.json();
    
    if (!quote || !quote.routePlan) {
      throw new Error(`No route found for ${inputMint} → ${outputMint}`);
    }
    
    return quote;
  }
  
  /**
   * Выполнить swap
   */
  async executeSwap(
    wallet: Keypair,
    quote: any
  ): Promise<string> {
    // Получить swap transaction
    const response = await fetch(JUPITER_SWAP_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });
    
    const { swapTransaction } = await response.json();
    
    // Deserialize transaction
    const transactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = Transaction.from(transactionBuf);
    
    // Подписать и отправить
    transaction.sign(wallet);
    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, maxRetries: 3 }
    );
    
    // Ждать подтверждения
    await this.connection.confirmTransaction(signature, 'confirmed');
    
    return signature;
  }
  
  /**
   * BUY: SOL → Token
   */
  async buy(
    wallet: Keypair,
    tokenMint: string,
    amountSol: number // в SOL
  ): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      const amountLamports = Math.floor(amountSol * 1e9);
      
      // Получить quote
      const quote = await this.getQuote(
        SOL_MINT,
        tokenMint,
        amountLamports,
        300 // 3% slippage
      );
      
      console.log(`Jupiter quote: ${amountSol} SOL → ${quote.outAmount} tokens`);
      
      // Выполнить swap
      const signature = await this.executeSwap(wallet, quote);
      
      return { success: true, signature };
    } catch (error) {
      console.error('Jupiter buy error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  
  /**
   * SELL: Token → SOL
   */
  async sell(
    wallet: Keypair,
    tokenMint: string,
    amountTokens: number // в token units
  ): Promise<{ success: boolean; signature?: string; error?: string }> {
    try {
      // Получить quote
      const quote = await this.getQuote(
        tokenMint,
        SOL_MINT,
        Math.floor(amountTokens),
        300 // 3% slippage
      );
      
      console.log(`Jupiter quote: ${amountTokens} tokens → ${quote.outAmount / 1e9} SOL`);
      
      // Выполнить swap
      const signature = await this.executeSwap(wallet, quote);
      
      return { success: true, signature };
    } catch (error) {
      console.error('Jupiter sell error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
```

**Использование:**

```typescript
// В real-trading-adapter.ts
import { JupiterSwap } from './jupiter-swap';

export class RealTradingAdapter {
  private jupiterSwap: JupiterSwap;
  
  constructor(private connection: Connection) {
    this.walletManager = new WalletManager();
    this.jupiterSwap = new JupiterSwap(connection);
  }
  
  async executeBuy(mint: string, amountSol: number): Promise<{ success: boolean; signature?: string; error?: string }> {
    const keypair = this.walletManager.getKeypair();
    if (!keypair) {
      return { success: false, error: 'Wallet not initialized' };
    }
    
    return await this.jupiterSwap.buy(keypair, mint, amountSol);
  }
  
  async executeSell(mint: string, amountSol: number): Promise<{ success: boolean; signature?: string; error?: string }> {
    const keypair = this.walletManager.getKeypair();
    if (!keypair) {
      return { success: false, error: 'Wallet not initialized' };
    }
    
    // TODO: Получить количество токенов из балансов
    const tokenAmount = await this.getTokenBalance(mint);
    
    return await this.jupiterSwap.sell(keypair, mint, tokenAmount);
  }
  
  private async getTokenBalance(mint: string): Promise<number> {
    const publicKey = this.walletManager.getPublicKey();
    if (!publicKey) throw new Error('Wallet not initialized');
    
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
      publicKey,
      { mint: new PublicKey(mint) }
    );
    
    if (tokenAccounts.value.length === 0) {
      return 0;
    }
    
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
    return parseInt(balance);
  }
}
```

**Установка:**

```bash
npm install node-fetch@2.6.7
npm install @types/node-fetch --save-dev
```

---

### ✅ Вариант 2: Raydium SDK (1 час)

**Описание:** Raydium - второй по популярности DEX на Solana

**Преимущества:**
- ✅ Официальный SDK
- ✅ Стабильный
- ✅ Хорошая документация

**Установка:**

```bash
npm install @raydium-io/raydium-sdk
```

**Код:**

```typescript
// src/raydium-swap.ts
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeys,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';

// TODO: Реализовать через Raydium SDK
// Документация: https://docs.raydium.io/raydium/
```

---

### ⚠️ Вариант 3: Прямой Swap через Pump.fun Contract (3-5 часов)

**Описание:** Реверс-инжиниринг pump.fun bonding curve

**Недостатки:**
- ❌ Требует глубокого понимания Solana программ
- ❌ Нет официальной документации
- ❌ Риск ошибок

**НЕ РЕКОМЕНДУЕТСЯ для быстрого старта**

---

## 🚀 Рекомендуемый План (1 час)

### Шаг 1: Установить Jupiter Swap (10 минут)

```bash
cd /Users/macbook/Documents/SentinelPumpAndDump
npm install node-fetch@2.6.7
npm install @types/node-fetch --save-dev
```

### Шаг 2: Создать jupiter-swap.ts (20 минут)

Скопировать код из "Вариант 1" выше

### Шаг 3: Обновить real-trading-adapter.ts (10 минут)

Интегрировать JupiterSwap в RealTradingAdapter

### Шаг 4: Тест на Devnet (20 минут)

```typescript
// test/test-jupiter-swap.ts
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { JupiterSwap } from '../src/jupiter-swap';

async function test() {
  // Devnet connection
  const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
  
  // Test wallet
  const wallet = Keypair.generate();
  
  // Airdrop SOL на devnet
  const airdropSignature = await connection.requestAirdrop(
    wallet.publicKey,
    2 * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(airdropSignature);
  
  console.log(`Wallet: ${wallet.publicKey.toString()}`);
  console.log(`Balance: ${await connection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL} SOL`);
  
  // Test Jupiter swap
  const jupiterSwap = new JupiterSwap(connection);
  
  // Swap 0.1 SOL → USDC
  const USDC_DEVNET = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
  const result = await jupiterSwap.buy(wallet, USDC_DEVNET, 0.1);
  
  console.log('Swap result:', result);
}

test().catch(console.error);
```

---

## 📋 Финальный Чек-Лист

### Реализовать Real Trading:

- [ ] **Jupiter Swap установлен** (`node-fetch`)
- [ ] **jupiter-swap.ts создан** (код выше)
- [ ] **real-trading-adapter.ts обновлён** (интеграция)
- [ ] **Тест на Devnet пройден** (test-jupiter-swap.ts)
- [ ] **Тест на Mainnet с 0.001 SOL** (реальные деньги!)
- [ ] **Полный запуск** (после подтверждения)

---

## 💡 Дополнительные Оптимизации

### 1. Кэширование Token Accounts

```typescript
// Кэш для token accounts, чтобы не запрашивать каждый раз
private tokenAccountCache = new Map<string, string>(); // mint → tokenAccount

async getOrCreateTokenAccount(mint: PublicKey): Promise<PublicKey> {
  const cached = this.tokenAccountCache.get(mint.toString());
  if (cached) return new PublicKey(cached);
  
  // Получить или создать token account
  const tokenAccount = await this.createTokenAccountIfNeeded(mint);
  this.tokenAccountCache.set(mint.toString(), tokenAccount.toString());
  
  return tokenAccount;
}
```

### 2. Priority Fees для Скорости

```typescript
// Jupiter API поддерживает auto priority fees
{
  prioritizationFeeLamports: 'auto', // Автоматически
  // или
  prioritizationFeeLamports: 50000, // 0.00005 SOL для приоритета
}
```

### 3. Мониторинг Failed Swaps

```typescript
// Логировать каждую failed транзакцию для анализа
if (!result.success) {
  logger.log({
    timestamp: getCurrentTimestamp(),
    type: 'swap_failed',
    mint,
    amountSol,
    error: result.error,
  });
  
  // Alert для критичных ошибок
  if (result.error.includes('Slippage tolerance exceeded')) {
    // Возможно нужно увеличить slippage
  }
}
```

---

## 🎯 Итоговое Время

### С Jupiter API:
- Код: 30 минут
- Тест на Devnet: 20 минут
- Тест на Mainnet: 10 минут
- **ИТОГО: 1 час до первой реальной сделки!**

### Без Jupiter (прямой swap):
- Реверс-инжиниринг: 2-3 часа
- Код: 1-2 часа
- Тестирование: 1 час
- **ИТОГО: 4-6 часов**

**Вывод: Jupiter API - самый быстрый путь!** 🚀

---

## 📞 Если Что-то Не Работает

### Jupiter API недоступен:

```typescript
// Fallback на другие aggregators
const AGGREGATORS = [
  'https://quote-api.jup.ag/v6/quote', // Jupiter
  'https://api.raydium.io/v2/swap/quote', // Raydium
  // Добавить другие
];

async getQuoteWithFallback(...) {
  for (const api of AGGREGATORS) {
    try {
      return await this.getQuote(api, ...);
    } catch (error) {
      continue;
    }
  }
  throw new Error('All aggregators failed');
}
```

### Pump.fun токены не поддерживаются:

```typescript
// Проверить ликвидность перед swap
const quote = await jupiterSwap.getQuote(...);
if (!quote || quote.priceImpactPct > 10) {
  // Слишком большой impact, токен неликвиден
  return { success: false, error: 'Insufficient liquidity' };
}
```

---

## 🏆 Финальный Совет

**Начни с Jupiter API!**
- Самый быстрый
- Самый надёжный
- Самый простой

**Если Jupiter не поддерживает pump.fun:**
- Raydium SDK (второй вариант)
- Прямой bonding curve swap (последний вариант)

**Главное:** Тестируй на Devnet, потом малые суммы на Mainnet, потом полный запуск!

**Время = деньги, поэтому используй готовые решения!** ⚡

