#!/bin/bash
# Детальный анализ timing данных

echo "=== ДЕТАЛЬНЫЙ АНАЛИЗ TIMING ==="
echo "Время: $(date)"
echo ""

ssh root@64.226.114.69 << 'EOF'
cd /var/www/SentinelPumpAndDump/logs

echo "=== ВСЕ ОТКРЫТИЯ ПОЗИЦИЙ (последние 30) ==="
grep "Position opened successfully" pm2-out.log | tail -30

echo ""
echo "=== ВСЕ ЗАКРЫТИЯ ПОЗИЦИЙ (последние 30) ==="
grep "Position closed:" pm2-out.log | tail -30

echo ""
echo "=== ГРУППИРОВКА ПО MULTIPLIER ==="
echo "> 2.5x сделки:"
grep "Position closed:" pm2-out.log | grep -E "[3-9]\.[0-9]+x" | tail -20

echo ""
echo "0.7-0.9x сделки:"
grep "Position closed:" pm2-out.log | grep -E "0\.[7-9][0-9]*x" | tail -20

echo ""
echo "=== TIMING BREAKDOWN ==="
echo "Последние 20 сделок с полным timing:"
grep "Position closed:" pm2-out.log | grep "TIMING ANALYSIS" | tail -20

EOF

