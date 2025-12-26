# Pump.fun Sniper Simulator

Paper trading симулятор для тестирования стратегии снайпер-бота мемкоинов на pump.fun (Solana). Работает 24/7 в фоне через PM2, симулирует торговлю на реальных данных без риска реальных денег.

## Особенности

- ✅ Полноценная симуляция торговли (paper trading)
- ✅ Реал-тайм мониторинг новых токенов через WebSocket (Helius)
- ✅ Быстрая фильтрация токенов (LP burned + mint renounced)
- ✅ Немедленное открытие позиций (до 10 одновременно)
- ✅ Параллельный мониторинг всех позиций
- ✅ Автоматический выход по тейк-профиту, таймеру или трейлинг-стопу
- ✅ Compounding после каждой закрытой позиции
- ✅ Защита от drawdown
- ✅ Получение цен напрямую из bonding curve контракта
- ✅ JSONL логирование с ротацией по датам
- ✅ Graceful shutdown

## Технический стек

- Node.js 20+ / TypeScript
- @solana/web3.js, @solana/spl-token
- **Bonding Curve Price Fetcher** - чтение цен напрямую из контракта pump.fun
- Helius RPC для WebSocket мониторинга и RPC запросов
- RPC Connection Pool для оптимизации запросов
- Redis (опционально, для кеша)
- PM2 для управления процессом

## Установка

### 1. Клонирование и установка зависимостей

```bash
cd SentinelPumpAndDump
npm install
```

### 2. Настройка окружения

Скопируйте `env.example` в `.env` и заполните:

```bash
cp env.example .env
```

Отредактируйте `.env`:

```env
# Helius RPC WebSocket URL (обязательно)
HELIUS_WS_URL=wss://mainnet.helius-rpc.com?api-key=YOUR_API_KEY

# Helius HTTP RPC URL
HELIUS_HTTP_URL=https://mainnet.helius-rpc.com?api-key=YOUR_API_KEY

# Redis (опционально)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Логирование
LOG_DIR=./logs

# Начальный депозит
INITIAL_DEPOSIT=0.03

# Курс SOL/USD
SOL_USD_RATE=170

# Take profit multiplier
TAKE_PROFIT_MULTIPLIER=2.5
```

### 3. Компиляция TypeScript

```bash
npm run build
```

## Запуск

### Разработка (с автоперезагрузкой)

```bash
npm run dev
```

### Production через PM2

```bash
# Запуск
npm run pm2:start

# Просмотр логов
npm run pm2:logs

# Остановка
npm run pm2:stop

# Перезапуск
npm run pm2:restart
```

### Прямой запуск

```bash
npm start
```

## Структура проекта

```
SentinelPumpAndDump/
├── src/
│   ├── index.ts              # Главный файл, оркестрация
│   ├── scanner.ts            # WebSocket мониторинг новых токенов
│   ├── quick-filters.ts      # Быстрая проверка безопасности (LP burned + mint renounced)
│   ├── filters.ts            # Дополнительные фильтры (для получения цены)
│   ├── position-manager.ts   # Управление позициями (открытие, мониторинг, закрытие)
│   ├── price-fetcher.ts     # Получение цен из bonding curve контракта
│   ├── simulator.ts         # Симуляция торговли (legacy, используется частично)
│   ├── logger.ts            # JSONL логирование
│   ├── rpc-pool.ts          # Пул RPC соединений для оптимизации
│   ├── cache.ts             # Кеширование (Redis или in-memory)
│   ├── types.ts             # TypeScript типы
│   ├── config.ts            # Конфигурация
│   └── utils.ts             # Утилиты
├── logs/                    # Логи (создается автоматически)
│   ├── trades-YYYY-MM-DD.jsonl
│   └── stats-daily-YYYY-MM-DD.json
├── dist/                    # Скомпилированный JavaScript
├── package.json
├── tsconfig.json
├── ecosystem.config.js       # PM2 конфигурация
└── README.md
```

## Бизнес-логика

### Стартовый депозит
- Начальный депозит: 0.03 SOL (~$5)
- Депозит обновляется после каждой закрытой позиции (compounding)
- Размер позиции = currentDeposit / 10

### Мониторинг токенов
- WebSocket подписка на логи программы pump.fun (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`)
- Детектирование новых токенов в реальном времени
- Немедленная обработка при получении уведомления

### Быстрая фильтрация (quickSecurityCheck)
Для немедленного открытия позиций проверяются только критичные параметры:
1. **LP burned**: LP токены сожжены
2. **Mint renounced**: mint authority = null

Цель: фильтрация за ~500-700ms для раннего входа.

### Получение цен
- **Bonding Curve Price Fetcher**: чтение цен напрямую из контракта pump.fun
- НЕ используется Jupiter API (новые токены не индексируются сразу)
- Цена вычисляется из резервов SOL и токенов в bonding curve контракте
- Кеширование на 2 секунды для оптимизации

### Управление позициями
- Максимум **10 активных позиций** одновременно
- При получении нового токена:
  1. Проверка наличия свободных слотов
  2. Быстрая проверка безопасности (~500ms)
  3. Немедленное открытие позиции (если проверка прошла)
  4. Параллельный мониторинг позиции
- Каждая позиция мониторится независимо

### Выход из позиции (первое сработавшее)
- **Тейк-профит**: 2.5x от цены входа
- **Таймер**: 90 секунд
- **Трейлинг-стоп**: 25% от локального максимума

### Compounding
- После закрытия позиции депозит обновляется: `currentDeposit += profit`
- Размер следующей позиции пересчитывается: `positionSize = currentDeposit / 10`
- Если `currentDeposit < 0.01 SOL` — бот останавливается

### Защита
- Максимум 10 открытых позиций одновременно
- При drawdown >25% от peakDeposit — пауза 5 минут

## Логирование

### JSONL логи (trades-YYYY-MM-DD.jsonl)

Каждая строка — валидный JSON объект:

```json
{"timestamp":"2025-12-26T15:32:45.123Z","type":"buy","token":"ABC...","investedSol":0.002,"entryPrice":0.00012}
{"timestamp":"2025-12-26T15:34:12.456Z","type":"sell","token":"ABC...","exitPrice":0.00030,"multiplier":2.50,"profitSol":0.003,"reason":"take_profit"}
{"timestamp":"2025-12-26T15:34:15.000Z","type":"info","message":"Position closed: ABC..., 2.50x, profit=0.003 SOL, reason=take_profit"}
```

### Статистика (stats-daily-YYYY-MM-DD.json)

Обновляется каждые 30 минут и в конце суток:

```json
{
  "date": "2025-12-26",
  "initialDeposit": 0.03,
  "finalDeposit": 0.45,
  "peakDeposit": 0.52,
  "totalTrades": 150,
  "hitsAbove2x": 92,
  "maxDrawdownPct": 18.4,
  "totalProfitSol": 0.42,
  "totalProfitUsd": 71.4
}
```

## Graceful Shutdown

При получении SIGINT/SIGTERM:
1. Останавливается сканер
2. Закрываются все открытые позиции по текущей цене
3. Сохраняется финальная статистика
4. Записывается summary в консоль

## Мониторинг

### Просмотр логов в реальном времени

```bash
# PM2 логи
npm run pm2:logs

# JSONL логи
tail -f logs/trades-$(date +%Y-%m-%d).jsonl

# Статистика
cat logs/stats-daily-$(date +%Y-%m-%d).json
```

### Проверка статуса

```bash
pm2 status
pm2 info pump-fun-sniper
```

## Настройка параметров

Все параметры настраиваются через `.env` или в `src/config.ts`:

- `INITIAL_DEPOSIT`: Начальный депозит в SOL (по умолчанию 0.03)
- `SOL_USD_RATE`: Курс SOL к USD (по умолчанию 170)
- `TAKE_PROFIT_MULTIPLIER`: Множитель тейк-профита (по умолчанию 2.5)
- `EXIT_TIMER_SECONDS`: Таймер выхода в секундах (по умолчанию 90)
- `TRAILING_STOP_PCT`: Трейлинг-стоп в % (по умолчанию 25)
- `MAX_DRAWDOWN_PCT`: Максимальный drawdown в % (по умолчанию 25)

## Архитектура

### Поток данных

```
WebSocket (Helius)
    ↓
TokenScanner → детектирует новые токены
    ↓
quickSecurityCheck → быстрая проверка (LP burned + mint renounced)
    ↓
PositionManager.tryOpenPosition() → открытие позиции
    ↓
PositionManager.monitorPosition() → параллельный мониторинг
    ↓
PriceFetcher → получение цены из bonding curve
    ↓
Выход по условию (take profit / timer / trailing stop)
    ↓
Compounding → обновление депозита
```

### Оптимизации

- **RPC Connection Pool**: 3 соединения для распределения нагрузки
- **Redis Caching**: кеширование mint info и largest accounts (с fallback на in-memory)
- **Batch RPC Requests**: группировка запросов для уменьшения количества вызовов
- **Price Caching**: кеширование цен на 2 секунды
- **Parallel Processing**: параллельная обработка токенов и мониторинг позиций

## Troubleshooting

### WebSocket не подключается
- Проверьте правильность `HELIUS_WS_URL` в `.env`
- Убедитесь, что API ключ валидный
- Проверьте интернет-соединение
- URL должен быть в формате: `wss://mainnet.helius-rpc.com?api-key=...` (без `/` перед `?`)

### Токены не детектируются
- Проверьте логи в консоли
- Убедитесь, что подписка на WebSocket активна
- Проверьте правильность `PUMP_FUN_PROGRAM_ID`

### Ошибки при получении цен
- Проверьте доступность RPC endpoint
- Убедитесь, что у вас достаточно rate limit на Helius
- Проверьте логи в `logs/trades-*.jsonl`
- Bonding curve контракт может быть недоступен для очень новых токенов (используется fallback)

### 429 Too Many Requests
- Это нормально при высокой нагрузке
- Бот автоматически обрабатывает rate limits с задержками
- Увеличьте `RPC_REQUEST_DELAY` в `.env` если ошибки частые

### Позиции не открываются
- Проверьте что есть свободные слоты (максимум 10)
- Проверьте логи security check - возможно токены не проходят фильтры
- Убедитесь что депозит достаточен для открытия позиции

## Лицензия

MIT
