# Отчет об анализе сделок (31 декабря 2025)

## Критические проблемы

### 1. ❌ executionPrice = 0.0000000000

**Проблема:**
- Во всех успешных покупках `executionPrice` равен `0.0000000000`
- Это приводит к `entryPrice = 0` в позиции
- Из-за этого `expectedExitPrice` тоже становится 0
- Результат: `netProfit <= 0` → позиция сразу `abandoned`

**Примеры из логов:**
```
✅ REAL BUY SUCCESS: ... | MarkPrice: 0.0002417869, ExecutionPrice: 0.0000000000
✅ Position opened successfully | Entry price: 0.00000000
[ABANDONED POSITION] ... | entrySOL: 0.004000, expectedExitSOL: 0.002281, netProfit: -0.002724 SOL
```

**Причина:**
В `RealTradingAdapter.executeBuy()` (строка 141-143):
```typescript
const executionPrice = result.outAmount && result.outAmount > 0
  ? amountSol / result.outAmount
  : markPrice || 0;
```

**КРИТИЧЕСКАЯ ОШИБКА:**
`result.outAmount` возвращается из `PumpFunSwap.buy()` в **raw units** (с учетом decimals токена, обычно 9 decimals для pump.fun токенов).

Например:
- `outAmount = 24963003988` (raw tokens)
- `amountSol = 0.004`
- `executionPrice = 0.004 / 24963003988 = 1.602e-13` ≈ **0** ❌

**Правильный расчет:**
Нужно нормализовать `outAmount` перед расчетом:
```typescript
const TOKEN_DECIMALS = 9; // pump.fun tokens обычно имеют 9 decimals
const normalizedTokens = result.outAmount / Math.pow(10, TOKEN_DECIMALS);
const executionPrice = normalizedTokens > 0
  ? amountSol / normalizedTokens
  : markPrice || 0;
```

Или использовать `markPrice` как fallback, если `outAmount` не нормализован.

**Решение:**
1. В `RealTradingAdapter.executeBuy()` нормализовать `outAmount` перед расчетом `executionPrice`
2. Использовать `TOKEN_DECIMALS = 9` для pump.fun токенов
3. Добавить fallback на `markPrice`, если расчет не удался

### 2. ❌ entryPrice = 0 в PositionManager

**Проблема:**
В `position-manager.ts` при открытии позиции:
```typescript
let executionPrice = buyResult.executionPrice;
if (!executionPrice || executionPrice <= 0) {
  executionPrice = buyResult.markPrice || actualEntryPrice;
}
if (!executionPrice || executionPrice <= 0) {
  executionPrice = actualEntryPrice; // Always use price from bonding curve as a last resort
}
position.entryPrice = executionPrice;
```

Но если `buyResult.executionPrice = 0` (из-за проблемы выше), `buyResult.markPrice` может быть тоже неточным, и `actualEntryPrice` может быть 0.

**Решение:**
- Исправить расчет `executionPrice` в `RealTradingAdapter` (см. выше)
- Добавить дополнительный fallback: `entryPrice = investedSol / normalizedTokensReceived`

### 3. ⚠️ Abandoned позиции из-за неправильного расчета

**Проблема:**
Токены помечаются как `abandoned` сразу после покупки из-за:
- `entryPrice = 0` → `expectedExitPrice = 0` → `netProfit <= 0`

**Пример:**
```
Token: 9eWXgFgJ...
Buy:  Invested: 0.004 SOL, Entry: 0.00000000
Sell: ABANDONED (через 1 секунду)
Reason: netProfit = -0.002724 SOL <= 0
```

**Решение:**
После исправления `executionPrice`, позиции должны правильно рассчитывать `netProfit` и не быть abandoned преждевременно.

## Статистика сделок

### Успешные покупки (из логов PM2):
1. **06:57:30** - Token: `7cNVeEVU...`
   - Invested: 0.004 SOL
   - Tokens: 41143679308 (raw)
   - Normalized: 41.143679308 tokens (с 9 decimals)
   - MarkPrice: 0.0000797758 SOL/token
   - ExecutionPrice: 0.0000000000 ❌ (должно быть ~0.0000972 SOL/token)
   - Entry price: 0.00000000 ❌
   - **Продано:** 06:57:33 за 0.003929 SOL (убыток ~0.000071 SOL)

2. **07:27:32** - Token: `3zPu2CNc...`
   - Invested: 0.004 SOL
   - Tokens: 29508778794 (raw)
   - Normalized: 29.508778794 tokens (с 9 decimals)
   - MarkPrice: 0.0001401554 SOL/token
   - ExecutionPrice: 0.0000000000 ❌ (должно быть ~0.0001356 SOL/token)
   - Entry price: 0.00000000 ❌
   - **Продано:** 07:27:35 за 0.003901 SOL (убыток ~0.000099 SOL)

3. **09:26:27** - Token: `9eWXgFgJ...`
   - Invested: 0.004 SOL
   - Tokens: 24963003988 (raw)
   - Normalized: 24.963003988 tokens (с 9 decimals)
   - MarkPrice: 0.0002417869 SOL/token
   - ExecutionPrice: 0.0000000000 ❌ (должно быть ~0.0001603 SOL/token)
   - Entry price: 0.00000000 ❌
   - **Abandoned:** 09:26:28 (через 1 секунду) ❌

### Проблемы с покупками:
- Много ошибок `Preflight:IncorrectProgramId` - токены уже не на bonding curve
- Много `BUY failed: Position opening returned null` - недостаточно баланса или другие ошибки

## Рекомендации по исправлению

### Приоритет 1 (Критично):
1. **Исправить расчет `executionPrice` в `RealTradingAdapter.executeBuy()`**
   ```typescript
   // ТЕКУЩИЙ КОД (НЕПРАВИЛЬНО):
   const executionPrice = result.outAmount && result.outAmount > 0
     ? amountSol / result.outAmount
     : markPrice || 0;
   
   // ИСПРАВЛЕННЫЙ КОД:
   const TOKEN_DECIMALS = 9; // pump.fun tokens
   const normalizedTokens = result.outAmount ? result.outAmount / Math.pow(10, TOKEN_DECIMALS) : 0;
   const executionPrice = normalizedTokens > 0
     ? amountSol / normalizedTokens
     : markPrice || 0;
   ```

2. **Исправить расчет `entryPrice` в `PositionManager`**
   - После исправления `executionPrice`, это должно работать автоматически
   - Добавить fallback: `entryPrice = investedSol / normalizedTokensReceived` если все остальные цены 0

3. **Исправить расчет `exitPrice` в `RealTradingAdapter.executeSell()`**
   - Аналогично, проверить нормализацию токенов при продаже

### Приоритет 2 (Важно):
1. **Улучшить обработку ошибок `Preflight:IncorrectProgramId`**
   - Проверять, что токен еще на bonding curve перед покупкой
   - Добавить фильтр по возрасту токена

2. **Улучшить баланс-менеджмент**
   - Много ошибок "insufficient balance" - возможно, баланс не синхронизируется правильно

### Приоритет 3 (Оптимизация):
1. **Улучшить логирование**
   - Логировать `normalizedTokens` и `rawTokens` для отладки
   - Логировать все промежуточные значения при расчете цен

2. **Добавить валидацию**
   - Проверять, что `executionPrice > 0` перед сохранением в позицию
   - Выбрасывать ошибку, если цена не может быть определена

## Следующие шаги

1. ✅ Исправить расчет `executionPrice` в `RealTradingAdapter.executeBuy()` - нормализовать `outAmount`
2. ✅ Исправить расчет `entryPrice` в `PositionManager` - добавить fallback
3. ✅ Протестировать на paper trading режиме
4. ✅ Запустить на production после исправлений
