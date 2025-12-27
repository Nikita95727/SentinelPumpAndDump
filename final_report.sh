#!/bin/bash
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     ОТЧЕТ: КАЧЕСТВО ОТБОРА ТОКЕНОВ И ДВИЖЕНИЕ ЦЕНЫ          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

ssh root@64.226.114.69 << 'REMOTE'
cd /var/www/SentinelPumpAndDump/logs

echo "📊 ОБЩАЯ СТАТИСТИКА"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
total_opened=$(grep 'Position opened successfully' pm2-out.log | wc -l)
echo "Всего открыто позиций: $total_opened"

unique_tokens=$(grep 'Position opened successfully' pm2-out.log | grep -oE 'token: [A-Za-z0-9]{8}' | sort | uniq | wc -l)
echo "Уникальных токенов: $unique_tokens"

echo ""
echo "📈 АНАЛИЗ ДВИЖЕНИЯ ЦЕНЫ (MULTIPLIER)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Собираем все уникальные токены с их максимальным multiplier
echo "Токены достигшие >= 2.5x (целевой результат):"
grep -E '[2-9]\.[5-9][0-9]*x|[3-9]\.[0-9]+x' pm2-out.log | grep -oE '[A-Za-z0-9]{8}\.\.\.' | sort | uniq | wc -l

echo ""
echo "Токены достигшие >= 2.0x:"
grep -E '[2-9]\.[0-9]+x' pm2-out.log | grep -oE '[A-Za-z0-9]{8}\.\.\.' | sort | uniq | wc -l

echo ""
echo "Токены достигшие >= 1.5x:"
grep -E '1\.[5-9][0-9]*x' pm2-out.log | grep -oE '[A-Za-z0-9]{8}\.\.\.' | sort | uniq | wc -l

echo ""
echo "Токены с 0.7-0.9x (поздний вход):"
grep -E '0\.[7-9][0-9]*x' pm2-out.log | grep -oE '[A-Za-z0-9]{8}\.\.\.' | sort | uniq | wc -l

echo ""
echo "💰 ФИНАНСОВЫЕ ПОКАЗАТЕЛИ"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Начальный депозит: 0.03 SOL"
peak=$(grep 'Peak:' pm2-out.log | tail -1 | grep -oE 'Peak: [0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+')
echo "Пиковый депозит: $peak SOL"
peak_mult=$(echo "scale=2; $peak / 0.03" | bc)
echo "Пиковый multiplier: ${peak_mult}x"

current=$(grep 'Deposit:' pm2-out.log | tail -1 | grep -oE 'Deposit: [0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+')
echo "Текущий депозит: $current SOL"

echo ""
echo "🎯 ВЫВОДЫ"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. Пиковый депозит достиг ${peak_mult}x - токены показывали рост!"
echo "2. Нужно проанализировать связь возраста при входе и финального multiplier"
echo "3. Если >= 3 из 10 токенов достигли >= 2.5x - отбор качественный"

REMOTE

