# Анализ причин стабильных убытков

## 🔴 ПРОБЛЕМА

Бот стабильно идет в минус, несмотря на положительные multipliers (1.56x, 1.64x, 1.91x).

## 📊 Примеры из логов

### Пример 1: Токен A2EsszCmooFvAFZbnEsg71LHi57Y9RCoU9U1X1gkpump
- **Покупка**: `Invested: 0.004 SOL` → `investedSol: 0.002995 SOL` (после комиссий)
- **Продажа**: `Received: 0.003660 SOL`, `multiplier: 1.56x`
- **Прибыль**: `profitSol: -0.001525 SOL` ❌

### Пример 2: Токен 6Ju5ptZQAteM1AXhdZy1QPFhQuAHwFAbpsCDrRqXpump
- **Покупка**: `Invested: 0.004 SOL` → `investedSol: 0.002995 SOL`
- **Продажа**: `Received: 0.003901 SOL`, `multiplier: 1.64x`
- **Прибыль**: `profitSol: -0.001283 SOL` ❌

### Пример 3: Токен 4zeF2PANtWfqP3kVXHwUHGtNuLdaERuXb14ywcxmpump
- **Покупка**: `Invested: 0.004 SOL` → `investedSol: 0.002995 SOL`
- **Продажа**: `Received: 0.004711 SOL`, `multiplier: 1.91x`
- **Прибыль**: `profitSol: -0.000473 SOL` ❌

## 🔍 Корневая причина

### Расчет `reservedAmount`

```typescript
const positionSize = 0.004; // SOL
const entryFees = 0.001 + 0.000005 = 0.001005; // priorityFee + signatureFee
const investedAmount = positionSize - entryFees = 0.002995; // SOL

const takeProfitMultiplier = 2.0;
const slippageMax = 0.03; // 3%

const expectedProceedsAtTakeProfit = investedAmount * takeProfitMultiplier = 0.00599;
const exitSlippage = expectedProceedsAtTakeProfit * slippageMax = 0.0001797;
const exitFees = 0.001 + 0.000005 = 0.001005;

const totalReservedAmount = positionSize + exitFees + exitSlippage = 0.0051847;
```

### Расчет прибыли

```typescript
const profit = proceeds - reservedAmount;
```

### Проблема

**`reservedAmount` рассчитан для максимального сценария (2.5x с slippage), но реальная продажа происходит при меньшем multiplier (1.56x-1.91x).**

#### Пример расчета:

1. **Покупка**: `investedAmount = 0.002995 SOL`
2. **Продажа**: `proceeds = 0.003660 SOL` (multiplier 1.56x)
3. **reservedAmount**: `0.0051847 SOL` (рассчитан для 2.5x с slippage)
4. **profit**: `0.003660 - 0.0051847 = -0.001525 SOL` ❌

#### Что должно быть:

Если multiplier 1.56x:
- `expectedProceeds = 0.002995 * 1.56 = 0.004667 SOL`
- `exitSlippage = 0.004667 * 0.03 = 0.00014 SOL`
- `reservedAmount = 0.004 + 0.001005 + 0.00014 = 0.005145 SOL`
- `profit = 0.003660 - 0.005145 = -0.001485 SOL` ❌

**Проблема остается!**

## 💡 Реальное объяснение

### Проблема #1: Неправильный расчет `reservedAmount`

`reservedAmount` включает:
- `positionSize` (0.004) - это правильно
- `exitFees` (0.001005) - это правильно
- `exitSlippage` (0.0001797) - **РАССЧИТАН ДЛЯ 2.5x, НО РЕАЛЬНАЯ ПРОДАЖА 1.56x!**

### Проблема #2: Неправильный расчет прибыли

При расчете прибыли используется:
```typescript
const profit = proceeds - reservedAmount;
```

Но `proceeds` - это реальная сумма после продажи (уже включает все комиссии и slippage), а `reservedAmount` - это зарезервированная сумма для максимального сценария.

**Правильный расчет должен быть:**
```typescript
const profit = proceeds - investedAmount - entryFees - exitFees;
// или
const profit = proceeds - positionSize - exitFees;
```

### Проблема #3: Slippage при продаже

Реальная продажа дает меньше, чем ожидалось из-за:
1. **Slippage** - разница между ожидаемой и реальной ценой
2. **Комиссии** - уже учтены в `proceeds`
3. **Низкая ликвидность** - токены продаются по худшей цене

## 📈 Статистика

Из логов видно:
- Все сделки показывают положительный multiplier (1.56x-1.91x)
- Но все сделки показывают отрицательный profit
- Средний убыток: ~0.001 SOL на сделку

## ✅ Решение

### Вариант 1: Исправить расчет прибыли

```typescript
// Вместо:
const profit = proceeds - reservedAmount;

// Использовать:
const profit = proceeds - positionSize - exitFees;
// или еще лучше:
const profit = proceeds - investedAmount - entryFees - exitFees;
```

### Вариант 2: Пересчитывать `reservedAmount` при закрытии

```typescript
// При закрытии позиции пересчитать reservedAmount на основе реального proceeds
const actualReservedAmount = positionSize + exitFees + (proceeds * slippageMax);
const profit = proceeds - actualReservedAmount;
```

### Вариант 3: Использовать `investedAmount` вместо `reservedAmount`

```typescript
// Прибыль = получено - потрачено (включая все комиссии)
const profit = proceeds - positionSize - exitFees;
```

## 🎯 Рекомендация

**Использовать Вариант 3** - самый простой и правильный:
- `profit = proceeds - positionSize - exitFees`
- Это даст реальную прибыль/убыток от сделки

