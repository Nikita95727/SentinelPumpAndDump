# REFACTOR SUMMARY — SentinelPumpAndDump

## 🎯 ЦЕЛЬ РЕФАКТОРА

Привести проект в порядок:
- Убрать рассинхронизацию логики
- Сделать торговый пайплайн детерминированным и стабильным
- Чёткое разделение ответственности между модулями
- Максимально подробное логирование

## ✅ ВЫПОЛНЕННЫЕ ИЗМЕНЕНИЯ

### 1. НОВАЯ АРХИТЕКТУРА PIPELINE

**Было:** Scanner → Filters (смешанная логика) → PositionManager (всё в одном)

**Стало:**
```
Scanner
 → AntiHoneypotFilter (только anti-honeypot)
 → MetricsCollector (сбор метрик)
 → TokenClassifier (классификация)
 → StrategyRouter (выбор стратегии)
 → PositionManager (оркестрация)
 → ExecutionAdapter (paper | real, Jito)
```

Каждый модуль делает ТОЛЬКО СВОЮ задачу.

### 2. НОВЫЕ МОДУЛИ

#### 2.1 `AntiHoneypotFilter` (src/anti-honeypot-filter.ts)
- **Единственный жёсткий фильтр**
- Проверяет: `uniqueBuyers > 1`
- Это ЕДИНСТВЕННЫЙ фильтр, который НАВСЕГДА отклоняет токен
- Все остальные проверки — в MetricsCollector и TokenClassifier

#### 2.2 `MetricsCollector` (src/metrics-collector.ts)
- **Сбор объективных метрик**
- Собирает:
  - liquidityUSD
  - marketCapUSD
  - holdersCount
  - price
  - multiplier (от стартовой цены pump.fun)
  - hasConcentratedLiquidity
  - earlyActivityScore
  - volumeUSD
  - uniqueBuyers
- **НЕ принимает решений**, только собирает данные

#### 2.3 `TokenClassifier` (src/token-classifier.ts)
- **Классификация токенов по типам**
- Правила (СТРОГО):
  - **MANIPULATOR**: concentrated liquidity + liquidityUSD >= 500 + marketCap >= 1000
  - **GEM**: multiplier >= 2.0 + liquidityUSD >= 1500
  - **MID**: multiplier >= 1.12 + liquidityUSD >= 1000
  - **TRASH**: всё остальное (НЕ торгуется)

#### 2.4 `Strategies` (src/strategies/)
Каждый TokenType имеет свою стратегию:

**Interface Strategy** (`strategy.interface.ts`):
- `shouldEnter()` — решает, входить ли в позицию
- `entryParams()` — вычисляет параметры входа
- `monitorTick()` — тик мониторинга (каждую секунду)
- `exitPlan()` — создаёт план выхода

**ManipulatorStrategy** (`manipulator-strategy.ts`):
- Вход МОМЕНТАЛЬНО после классификации
- Малый размер позиции: 0.005–0.01 SOL
- Stop-loss: -10%
- Timeout: 60s
- Выход по ослаблению импульса (2 тика подряд)
- Jito первым, высокий приоритет

**GemStrategy** (`gem-strategy.ts`):
- Вход при multiplier >= 2.0x + liquidity >= 1500
- Позиция ДОЛГОСРОЧНОГО сопровождения
- НЕТ жёсткого timeout
- Адаптивный trailing stop:
  - 2x–3x → 20%
  - 3x–5x → 25%
  - 5x–10x → 30%
  - 10x+ → 35–40%
- Выход ТОЛЬКО по:
  - структурному дампу
  - потере импульса
  - слому тренда
  - критическим условиям

**MidStrategy** (`mid-strategy.ts`):
- Вход при multiplier >= 1.12 + liquidity >= 1000
- Take-profit: 1.35x
- Stop-loss: -10%
- Timeout: 45s
- Цель: микроприбыль, высокая частота

#### 2.5 `StrategyRouter` (src/strategy-router.ts)
- **Маршрутизация токенов к стратегиям**
- Возвращает Strategy для ClassifiedToken
- TRASH токены не имеют стратегии → не торгуются

#### 2.6 `PositionManagerNew` (src/position-manager-new.ts)
- **ОРКЕСТРАТОР** (не принимает торговых решений)
- Управляет:
  - Слотами (maxOpenPositions)
  - Балансом (Account)
  - Readiness проверкой
  - Monitor loop
- Делегирует торговые решения стратегиям
- **Гейты открытия** (строго по порядку):
  1. free slots
  2. free balance
  3. shouldEnter (стратегия)
  4. readiness
  5. buy success

### 3. ОБНОВЛЁННЫЕ МОДУЛИ

#### 3.1 `Scanner` (src/scanner.ts)
- Упрощён
- Выдаёт простой `TokenCandidate`:
  ```typescript
  {
    mint: string;
    createdAt: number;
    signature: string;
    rawLogs?: any[];
  }
  ```
- НЕ фильтрует, НЕ классифицирует, НЕ принимает решений
- Гарантирует:
  - Дедупликацию
  - FIFO порядок
  - Отсутствие блокировок

#### 3.2 `Types` (src/types.ts)
- Обновлены типы:
  - `TokenType = 'MANIPULATOR' | 'GEM' | 'MID' | 'TRASH'`
  - `TokenMetrics` — метрики после сбора
  - `ClassifiedToken` — классифицированный токен
  - `StrategyContext` — контекст для стратегий
  - `EntryParams` — параметры входа
  - `MonitorDecision` — решение мониторинга
  - `ExitPlan` — план выхода
- Добавлены поля в `Position`:
  - `tokenType: TokenType`
  - `strategyId: string`
  - `structure` — для GEM
  - `impulse` — для всех стратегий

#### 3.3 `index-new.ts` (src/index-new.ts)
- **Новый главный файл с правильным pipeline**
- Инициализирует все модули в правильном порядке
- `handleNewToken()` реализует полный pipeline:
  1. AntiHoneypotFilter
  2. MetricsCollector
  3. TokenClassifier
  4. StrategyRouter
  5. PositionManager
- Детальное логирование на каждом шаге

### 4. ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ

Каждый токен оставляет трассу:

```
🔔 CANDIDATE_DETECTED
🔍 [STEP 1/5] ANTI-HONEYPOT CHECK
  ✅ ANTI-HONEYPOT PASSED | ❌ FILTER_REJECT
📊 [STEP 2/5] METRICS COLLECTION
  ✅ METRICS COLLECTED | ❌ FILTER_REJECT
🏷️ [STEP 3/5] TOKEN CLASSIFICATION
  ✅ CLASSIFIED: MANIPULATOR/GEM/MID/TRASH
🎯 [STEP 4/5] STRATEGY ROUTING
  ✅ STRATEGY SELECTED | 🗑️ NOT TRADING (TRASH)
🚀 [STEP 5/5] POSITION MANAGER
  🎯 OPEN_ATTEMPT
  ❌ OPEN_SKIPPED (gate, reason)
  ✅ OPEN_SUCCESS
  📊 MONITOR_TICK (throttled)
  🚪 EXIT_DECISION
  ✅ SELL_SUCCESS | ❌ SELL_FAIL

📋 CANDIDATE_FLOW (агрегированная строка)
```

## 📁 ИЗМЕНЁННЫЕ ФАЙЛЫ

### Новые файлы:
1. `src/anti-honeypot-filter.ts` — AntiHoneypotFilter
2. `src/metrics-collector.ts` — MetricsCollector
3. `src/token-classifier.ts` — TokenClassifier
4. `src/strategy-router.ts` — StrategyRouter
5. `src/strategies/strategy.interface.ts` — интерфейс Strategy
6. `src/strategies/manipulator-strategy.ts` — стратегия для MANIPULATOR
7. `src/strategies/gem-strategy.ts` — стратегия для GEM
8. `src/strategies/mid-strategy.ts` — стратегия для MID
9. `src/position-manager-new.ts` — новый PositionManager (оркестратор)
10. `src/index-new.ts` — новый главный файл

### Обновлённые файлы:
1. `src/types.ts` — обновлены типы
2. `src/scanner.ts` — упрощён Scanner

### Старые файлы (не удаляем для обратной совместимости):
- `src/filters.ts` — старый Filters (можно удалить после проверки)
- `src/position-manager.ts` — старый PositionManager (можно удалить после проверки)
- `src/index.ts` — старый главный файл (можно удалить после проверки)

## 🔄 НОВЫЙ FLOW

### Пример: MANIPULATOR токен

```
1. Scanner обнаруживает токен → CANDIDATE_DETECTED
2. AntiHoneypotFilter: uniqueBuyers = 5 → PASSED ✅
3. MetricsCollector:
   - liquidityUSD = 800
   - marketCapUSD = 1200
   - multiplier = 1.1x
   - hasConcentratedLiquidity = true
4. TokenClassifier: MANIPULATOR ✅
   (concentrated liquidity + liquidity >= 500 + marketCap >= 1000)
5. StrategyRouter: ManipulatorStrategy ✅
6. PositionManager:
   - Gate 1: free slots → OK ✅
   - Gate 2: free balance → OK ✅
   - Gate 3: shouldEnter → ENTER (immediate) ✅
   - Gate 4: readiness → OK ✅
   - Gate 5: buy → SUCCESS ✅
7. Monitor loop (каждую секунду):
   - Проверяет импульс (velocity + acceleration)
   - Выход если 2 падения подряд OR stop-loss OR timeout
8. Exit:
   - EXIT_DECISION: momentum_loss
   - SELL_SUCCESS (Jito, 25% slippage)
```

### Пример: GEM токен

```
1. Scanner → CANDIDATE_DETECTED
2. AntiHoneypotFilter → PASSED ✅
3. MetricsCollector:
   - liquidityUSD = 2000
   - marketCapUSD = 5000
   - multiplier = 2.5x
   - hasConcentratedLiquidity = false
4. TokenClassifier: GEM ✅
   (multiplier >= 2.0 + liquidity >= 1500)
5. StrategyRouter: GemStrategy ✅
6. PositionManager: OPEN_SUCCESS ✅
7. Monitor loop (долгосрочное сопровождение):
   - Проверяет структуру (higher highs / higher lows)
   - Проверяет импульс (velocity + acceleration)
   - Адаптивный trailing stop (20-40%)
   - НЕТ timeout
8. Exit:
   - EXIT_DECISION: trailing stop (30% from peak)
   - SELL_SUCCESS
```

### Пример: TRASH токен

```
1. Scanner → CANDIDATE_DETECTED
2. AntiHoneypotFilter → PASSED ✅
3. MetricsCollector:
   - liquidityUSD = 300
   - marketCapUSD = 500
   - multiplier = 1.05x
4. TokenClassifier: TRASH 🗑️
   (не соответствует критериям)
5. StrategyRouter: NO STRATEGY (TRASH) 🗑️
6. NOT TRADING ❌
```

## 🎯 РЕЗУЛЬТАТ

После рефактора:
- ✅ Позиции ДОЛЖНЫ открываться
- ✅ Если не открываются — причина ЯСНО ВИДНА В ЛОГАХ
- ✅ Архитектура позволяет легко добавить новый TokenType
- ✅ Чёткое разделение ответственности
- ✅ Детерминированный и стабильный пайплайн
- ✅ Никакой рассинхронизации логики

## 🚀 КАК ЗАПУСТИТЬ

Используйте новый главный файл:

```bash
# Обновите package.json
{
  "scripts": {
    "start": "tsx src/index-new.ts"
  }
}

# Запустите
npm start
```

Или переименуйте файлы:
```bash
mv src/index.ts src/index-old.ts
mv src/index-new.ts src/index.ts

mv src/position-manager.ts src/position-manager-old.ts
mv src/position-manager-new.ts src/position-manager.ts
```

## 📝 ДАЛЬНЕЙШИЕ ДЕЙСТВИЯ

1. Протестировать новый pipeline
2. Проверить что позиции открываются
3. Проверить логи на каждом этапе
4. Если всё работает — удалить старые файлы:
   - `src/index-old.ts`
   - `src/position-manager-old.ts`
   - `src/filters.ts` (заменён на anti-honeypot-filter + metrics-collector)

## ⚠️ ВАЖНО

- Scanner УЖЕ работает корректно — НЕ переписывали с нуля
- Подключение к pump.fun НЕ изменено
- Все RPC вызовы остались теми же
- Изменилась только организация логики

