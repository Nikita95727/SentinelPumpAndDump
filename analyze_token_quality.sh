#!/bin/bash
# Анализ качества отбора токенов

echo "=== АНАЛИЗ КАЧЕСТВА ОТБОРА ТОКЕНОВ ==="
echo "Время: $(date)"
echo ""

ssh root@64.226.114.69 << 'EOF'
cd /var/www/SentinelPumpAndDump/logs

echo "=== СТАТИСТИКА ПО MULTIPLIER ==="
echo "Всего уникальных записей с multiplier:"
grep -E '[0-9]+\.[0-9]+x \(' pm2-out.log | wc -l

echo ""
echo "Распределение по диапазонам:"
echo ">= 2.5x (целевой результат):"
grep -E '[2-9]\.[5-9][0-9]*x|[3-9]\.[0-9]+x' pm2-out.log | wc -l

echo ">= 2.0x (близко к цели):"
grep -E '[2-9]\.[0-9]+x' pm2-out.log | wc -l

echo ">= 1.5x (хороший рост):"
grep -E '1\.[5-9][0-9]*x' pm2-out.log | wc -l

echo "1.0-1.5x (небольшой рост):"
grep -E '1\.[0-4][0-9]*x' pm2-out.log | wc -l

echo "0.7-0.9x (поздний вход, пропустили рост):"
grep -E '0\.[7-9][0-9]*x' pm2-out.log | wc -l

echo "< 0.7x (убыток):"
grep -E '0\.[0-6][0-9]*x' pm2-out.log | wc -l

echo ""
echo "=== ТОП-10 МАКСИМАЛЬНЫХ MULTIPLIER ==="
grep -E '[0-9]+\.[0-9]+x \(' pm2-out.log | grep -oE '[0-9]+\.[0-9]+x' | sort -rn | uniq | head -10

echo ""
echo "=== ПРИМЕРЫ УСПЕШНЫХ ТОКЕНОВ (>= 2.0x) ==="
grep -E '[2-9]\.[0-9]+x' pm2-out.log | head -5

echo ""
echo "=== ПРИМЕРЫ НЕУСПЕШНЫХ ТОКЕНОВ (0.7-0.9x) ==="
grep -E '0\.[7-9][0-9]*x' pm2-out.log | head -5

echo ""
echo "=== АНАЛИЗ DEPOSIT (показывает общую эффективность) ==="
echo "Начальный депозит: 0.03 SOL"
echo "Пиковый депозит:"
grep 'Peak:' pm2-out.log | tail -1 | grep -oE 'Peak: [0-9]+\.[0-9]+'
echo "Текущий депозит:"
grep 'Deposit:' pm2-out.log | tail -1 | grep -oE 'Deposit: [0-9]+\.[0-9]+'

EOF

echo ""
echo "=== ВЫВОДЫ ==="
echo "Если >= 30% токенов показали >= 1.5x - отбор хороший"
echo "Если >= 3 из 10 токенов достигли >= 2.5x - цель достигнута"

