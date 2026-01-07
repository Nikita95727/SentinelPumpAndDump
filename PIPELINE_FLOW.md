# PIPELINE FLOW — Быстрая справка

## 📋 НОВЫЙ PIPELINE (5 ЭТАПОВ)

```
Scanner
  ↓
AntiHoneypotFilter (REJECT если honeypot)
  ↓
MetricsCollector (собрать метрики)
  ↓
TokenClassifier (MANIPULATOR/GEM/MID/TRASH)
  ↓
StrategyRouter (выбрать стратегию)
  ↓
PositionManager (оркестрация: slots, balance, readiness, buy, monitor)
  ↓
ExecutionAdapter (paper | real, Jito)
```

## 🎯 КЛАССИФИКАЦИЯ ТОКЕНОВ

### MANIPULATOR
- **Критерии**: concentrated liquidity + liquidityUSD >= 500 + marketCap >= 1000
- **Стратегия**: 
  - Вход: МОМЕНТАЛЬНО
  - Размер: 0.005–0.01 SOL
  - Stop-loss: -10%
  - Timeout: 60s
  - Выход: 2 падения импульса подряд

### GEM
- **Критерии**: multiplier >= 2.0x + liquidityUSD >= 1500
- **Стратегия**:
  - Вход: при 2.0x+
  - Размер: 0.005–0.015 SOL
  - Trailing stop: 20-40% (адаптивный)
  - Timeout: НЕТ (долгосрочное сопровождение)
  - Выход: структурный дамп, потеря импульса, слом тренда

### MID
- **Критерии**: multiplier >= 1.12x + liquidityUSD >= 1000
- **Стратегия**:
  - Вход: при 1.12x+
  - Размер: 0.004–0.01 SOL
  - Take-profit: 1.35x
  - Stop-loss: -10%
  - Timeout: 45s
  - Выход: take-profit, stop-loss, timeout

### TRASH
- **Критерии**: всё остальное
- **Стратегия**: НЕТ (не торгуется)

## 🚪 ГЕЙТЫ ОТКРЫТИЯ ПОЗИЦИИ

PositionManager проверяет в строгом порядке:

1. **Free slots**: `positions.size < maxOpenPositions`
   - ❌ OPEN_SKIPPED: no free slots

2. **Free balance**: `freeBalance >= 0.005 SOL`
   - ❌ OPEN_SKIPPED: insufficient balance

3. **shouldEnter** (стратегия): стратегия решает входить ли
   - ❌ OPEN_SKIPPED: strategy rejected

4. **Readiness**: токен готов к торговле
   - ❌ OPEN_SKIPPED: not ready

5. **Buy success**: покупка прошла успешно
   - ❌ OPEN_FAIL: buy failed
   - ✅ OPEN_SUCCESS

## 📊 ЛОГИ

Каждый токен оставляет чёткую трассу:

```
🔔 CANDIDATE_DETECTED: {mint}
🔍 [STEP 1/5] ANTI-HONEYPOT CHECK
  → ✅ ANTI-HONEYPOT PASSED: {uniqueBuyers} buyers
  → ❌ FILTER_REJECT: honeypot

📊 [STEP 2/5] METRICS COLLECTION
  → ✅ METRICS COLLECTED: price, multiplier, liquidity, marketCap
  → ❌ FILTER_REJECT: metrics failed

🏷️ [STEP 3/5] TOKEN CLASSIFICATION
  → ✅ CLASSIFIED: {MANIPULATOR/GEM/MID/TRASH}

🎯 [STEP 4/5] STRATEGY ROUTING
  → ✅ STRATEGY SELECTED: {type}
  → 🗑️ NOT TRADING: TRASH

🚀 [STEP 5/5] POSITION MANAGER
  → 🎯 OPEN_ATTEMPT
  → ❌ OPEN_SKIPPED: {gate}, {reason}
  → ✅ OPEN_SUCCESS

📊 MONITOR_TICK (каждую секунду)
  → action: hold/exit
  → reason: {reason}

🚪 EXIT_DECISION: {exitType}
  → ✅ SELL_SUCCESS
  → ❌ SELL_FAIL

📋 CANDIDATE_FLOW (агрегированная строка)
```

## 🔧 ФАЙЛЫ

### Новые модули:
- `src/anti-honeypot-filter.ts`
- `src/metrics-collector.ts`
- `src/token-classifier.ts`
- `src/strategy-router.ts`
- `src/strategies/` (strategy.interface.ts, manipulator-strategy.ts, gem-strategy.ts, mid-strategy.ts)
- `src/position-manager-new.ts`
- `src/index-new.ts`

### Обновлённые:
- `src/types.ts`
- `src/scanner.ts`

## 🚀 ЗАПУСК

```bash
# Вариант 1: переименовать файлы
mv src/index.ts src/index-old.ts
mv src/index-new.ts src/index.ts
mv src/position-manager.ts src/position-manager-old.ts
mv src/position-manager-new.ts src/position-manager.ts

npm start

# Вариант 2: запустить напрямую
tsx src/index-new.ts
```

## ❓ FAQ

**Q: Почему позиции не открываются?**
A: Проверьте логи. Каждый гейт логирует причину отказа:
- OPEN_SKIPPED: {gate} — показывает на каком гейте отказ
- Смотрите на CANDIDATE_FLOW — полный путь токена

**Q: Как добавить новый тип токена?**
A: 
1. Добавьте тип в `TokenType` (types.ts)
2. Обновите правила в `TokenClassifier.classify()`
3. Создайте новую стратегию в `src/strategies/`
4. Зарегистрируйте в `StrategyRouter`

**Q: Как изменить параметры стратегии?**
A: Отредактируйте соответствующий файл в `src/strategies/`
- MANIPULATOR → manipulator-strategy.ts
- GEM → gem-strategy.ts
- MID → mid-strategy.ts

**Q: Scanner не находит токены?**
A: Scanner НЕ изменён, работает как раньше. Проверьте:
- WebSocket подключение к pump.fun
- Логи CANDIDATE_DETECTED

