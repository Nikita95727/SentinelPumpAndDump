# Pump.fun Sniper Simulator

Paper trading симулятор для тестирования стратегии снайпер-бота мемкоинов на pump.fun (Solana). Работает 24/7 в фоне через PM2, симулирует торговлю на реальных данных без риска реальных денег.

## Особенности

- ✅ Полноценная симуляция торговли (paper trading)
- ✅ Реал-тайм мониторинг новых токенов через WebSocket (Helius)
- ✅ Автоматическая фильтрация токенов по критериям
- ✅ Батч-торговля (10 позиций одновременно)
- ✅ Автоматический выход по тейк-профиту, таймеру или трейлинг-стопу
- ✅ Compounding после каждого батча
- ✅ Защита от drawdown
- ✅ JSONL логирование с ротацией по датам
- ✅ Graceful shutdown

## Технический стек

- Node.js 20+ / TypeScript
- @solana/web3.js, @solana/spl-token
- Jupiter API для получения цен
- Helius RPC для WebSocket мониторинга
- ioredis (опционально, для кеша)
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
HELIUS_WS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Helius HTTP RPC URL
HELIUS_HTTP_URL=https://atlas-mainnet.helius-rpc.com/?api-key=YOUR_API_KEY

# Redis (опционально)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Логирование
LOG_DIR=./logs
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
│   ├── index.ts          # Главный файл, оркестрация
│   ├── scanner.ts        # WebSocket мониторинг новых токенов
│   ├── filters.ts        # Фильтрация токенов по критериям
│   ├── simulator.ts      # Симуляция торговли
│   ├── logger.ts         # JSONL логирование
│   ├── types.ts          # TypeScript типы
│   ├── config.ts         # Конфигурация
│   └── utils.ts          # Утилиты
├── logs/                 # Логи (создается автоматически)
│   ├── trades-YYYY-MM-DD.jsonl
│   └── stats-daily-YYYY-MM-DD.json
├── dist/                 # Скомпилированный JavaScript
├── package.json
├── tsconfig.json
├── ecosystem.config.js    # PM2 конфигурация
└── README.md
```

## Бизнес-логика

### Стартовый депозит
- Начальный депозит: 0.03 SOL (~$5)
- Депозит обновляется после каждого батча (compounding)

### Мониторинг токенов
- WebSocket подписка на логи программы pump.fun
- Детектирование новых токенов в реальном времени

### Фильтры токенов (все должны пройти)
1. **Задержка**: 10-30 секунд после создания
2. **Минимум покупок**: 5-10 транзакций
3. **Объем торгов**: >= 2000 USD
4. **LP burned**: LP токены сожжены
5. **Mint renounced**: mint authority = null
6. **Нет снайперов**: топ-5 холдеров, никто не держит >20%

### Батч-торговля
- Собирается 10 кандидатов
- Позиция = currentDeposit / 10
- Если депозит < 0.01 SOL — остановка

### Выход из позиции (первое сработавшее)
- **Тейк-профит**: 4x от цены входа
- **Таймер**: 90 секунд
- **Трейлинг-стоп**: 25% от локального максимума

### Защита
- Максимум 100 открытых позиций
- При drawdown >25% от peakDeposit — пауза 5 минут

## Логирование

### JSONL логи (trades-YYYY-MM-DD.jsonl)

Каждая строка — валидный JSON объект:

```json
{"timestamp":"2025-12-26T15:32:45.123Z","type":"buy","batchId":47,"token":"ABC...","investedSol":0.003,"entryPrice":0.00012}
{"timestamp":"2025-12-26T15:34:12.456Z","type":"sell","batchId":47,"token":"ABC...","exitPrice":0.00061,"multiplier":5.08,"profitSol":0.0123,"reason":"take_profit"}
{"timestamp":"2025-12-26T15:34:15.000Z","type":"batch_complete","batchId":47,"netProfitPct":178,"depositBefore":0.03,"depositAfter":0.0834}
```

### Статистика (stats-daily-YYYY-MM-DD.json)

Обновляется каждые 30 минут и в конце суток:

```json
{
  "date": "2025-12-26",
  "initialDeposit": 0.03,
  "finalDeposit": 0.45,
  "peakDeposit": 0.52,
  "totalBatches": 50,
  "winBatches": 31,
  "avgBatchProfitPct": 35,
  "totalTrades": 500,
  "hitsAbove3x": 92,
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
- `MAX_OPEN_POSITIONS`: Максимум открытых позиций (по умолчанию 100)
- `MAX_DRAWDOWN_PCT`: Максимальный drawdown в % (по умолчанию 25)

## Troubleshooting

### WebSocket не подключается
- Проверьте правильность `HELIUS_WS_URL` в `.env`
- Убедитесь, что API ключ валидный
- Проверьте интернет-соединение

### Токены не детектируются
- Проверьте логи в консоли
- Убедитесь, что подписка на WebSocket активна
- Проверьте правильность `PUMP_FUN_PROGRAM_ID`

### Ошибки при фильтрации
- Проверьте доступность RPC endpoint
- Убедитесь, что у вас достаточно rate limit на Helius
- Проверьте логи в `logs/trades-*.jsonl`

## Лицензия

MIT

