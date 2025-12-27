#!/bin/bash
# Скрипт для анализа timing данных из логов бота

echo "=== АНАЛИЗ TIMING ДАННЫХ ==="
echo "Время анализа: $(date)"
echo ""

# Подключение к серверу и сбор данных
ssh root@64.226.114.69 << 'EOF'
cd /var/www/SentinelPumpAndDump

echo "=== ПОСЛЕДНИЕ ОТКРЫТИЯ ПОЗИЦИЙ ==="
grep "Position opened successfully" logs/pm2-out.log | tail -20 | grep -E "(Token age|Entry price)" | tail -10

echo ""
echo "=== ПОСЛЕДНИЕ ЗАКРЫТИЯ ПОЗИЦИЙ ==="
grep "Position closed:" logs/pm2-out.log | tail -20 | grep -E "(TIMING ANALYSIS|multiplier)" | tail -10

echo ""
echo "=== СТАТИСТИКА ПО MULTIPLIER И ВОЗРАСТУ ==="
echo "Сделки с multiplier > 2.5x:"
grep "Position closed:" logs/pm2-out.log | grep -E "TIMING ANALYSIS" | grep -E "[3-9]\.[0-9]+x" | wc -l

echo "Сделки с multiplier 0.7-0.9x:"
grep "Position closed:" logs/pm2-out.log | grep -E "TIMING ANALYSIS" | grep -E "0\.[7-9][0-9]*x" | wc -l

echo ""
echo "=== АНАЛИЗ ВОЗРАСТА ПРИ ВХОДЕ ==="
echo "Средний возраст токена при входе для успешных сделок (>2.5x):"
grep "Position closed:" logs/pm2-out.log | grep -E "TIMING ANALYSIS" | grep -E "[3-9]\.[0-9]+x" | grep -oP "Entry age: \K[0-9]+\.[0-9]+" | awk '{sum+=$1; count++} END {if(count>0) print sum/count "s"; else print "Нет данных"}'

echo "Средний возраст токена при входе для неуспешных сделок (0.7-0.9x):"
grep "Position closed:" logs/pm2-out.log | grep -E "TIMING ANALYSIS" | grep -E "0\.[7-9][0-9]*x" | grep -oP "Entry age: \K[0-9]+\.[0-9]+" | awk '{sum+=$1; count++} END {if(count>0) print sum/count "s"; else print "Нет данных"}'

echo ""
echo "=== ДЕТАЛЬНЫЕ ДАННЫЕ ПОСЛЕДНИХ СДЕЛОК ==="
grep "Position closed:" logs/pm2-out.log | tail -10 | grep -E "TIMING ANALYSIS"

EOF

echo ""
echo "=== АНАЛИЗ ЗАВЕРШЕН ==="

