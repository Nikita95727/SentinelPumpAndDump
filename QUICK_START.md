# Быстрый старт

## 1. Установка зависимостей

```bash
npm install
```

## 2. Настройка .env

Скопируйте `env.example` в `.env`:

```bash
cp env.example .env
```

Отредактируйте `.env` и укажите ваш Helius API ключ:

```env
HELIUS_WS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=ВАШ_КЛЮЧ
HELIUS_HTTP_URL=https://atlas-mainnet.helius-rpc.com/?api-key=ВАШ_КЛЮЧ
```

## 3. Компиляция

```bash
npm run build
```

## 4. Запуск

### Через PM2 (рекомендуется для production)

```bash
npm run pm2:start
npm run pm2:logs  # просмотр логов
```

### Прямой запуск

```bash
npm start
```

### Режим разработки

```bash
npm run dev
```

## 5. Проверка работы

Логи сохраняются в `logs/`:
- `trades-YYYY-MM-DD.jsonl` - все сделки
- `stats-daily-YYYY-MM-DD.json` - дневная статистика

Просмотр логов в реальном времени:
```bash
tail -f logs/trades-$(date +%Y-%m-%d).jsonl
```

## Остановка

```bash
npm run pm2:stop
```

Или через PM2:
```bash
pm2 stop pump-fun-sniper
```

## Troubleshooting

### Ошибка подключения к WebSocket
- Проверьте правильность API ключа в `.env`
- Убедитесь, что ключ активен на Helius

### Ошибки компиляции
- Убедитесь, что установлен Node.js 20+
- Выполните `npm install` заново

### Нет токенов в логах
- Проверьте, что WebSocket подключен (должно быть сообщение "WebSocket connected")
- Проверьте логи в консоли на наличие ошибок


