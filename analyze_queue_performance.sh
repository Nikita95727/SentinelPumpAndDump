#!/bin/bash

LOG_FILE="/var/www/SentinelPumpAndDump/logs/pm2-out.log"

echo "╔══════════════════════════════════════════════════════════════════════════╗"
echo "║     АНАЛИЗ ПРОИЗВОДИТЕЛЬНОСТИ ОЧЕРЕДЕЙ                                  ║"
echo "╚══════════════════════════════════════════════════════════════════════════╝"
echo ""

# Проверка SSH соединения
ssh -o BatchMode=yes -o ConnectTimeout=5 root@64.226.114.69 exit
if [ $? -ne 0 ]; then
    echo "Ошибка: Не удалось подключиться к серверу по SSH. Проверьте соединение."
    exit 1
fi

echo "=== ИЗВЛЕЧЕНИЕ ДАННЫХ ==="
echo ""

# Извлекаем открытия позиций
echo "Извлечение открытий позиций..."
ssh root@64.226.114.69 "grep 'Position opened successfully' $LOG_FILE | tail -500" > /tmp/opens.txt

# Обрабатываем локально с sed/awk
cat /tmp/opens.txt | sed -n 's/.*Token: \([A-Za-z0-9]\{8\}\).*/\1/p' > /tmp/tokens.txt
cat /tmp/opens.txt | sed -n 's/.*Token age at open: \([0-9\.]\+\).*/\1/p' > /tmp/ages_new.txt
cat /tmp/opens.txt | sed -n 's/.*Token age: \([0-9\.]\+\).*/\1/p' > /tmp/ages_old.txt

# Объединяем tokens и ages
paste -d' ' /tmp/tokens.txt /tmp/ages_new.txt | awk '$1 != "" && $2 != "" {print}' > /tmp/token_age_new.txt
paste -d' ' /tmp/tokens.txt /tmp/ages_old.txt | awk '$1 != "" && $2 != "" {print}' > /tmp/token_age_old.txt

# Объединяем, приоритет новому формату
cat /tmp/token_age_new.txt /tmp/token_age_old.txt | sort -u > /tmp/token_entry_age.txt

echo "Найдено открытий: $(wc -l < /tmp/token_entry_age.txt)"
echo ""

# Извлекаем закрытия позиций (SELL)
echo "Извлечение закрытий позиций..."
ssh root@64.226.114.69 "grep 'SELL' $LOG_FILE | grep -E '([0-9\.]+)x' | tail -500" > /tmp/sells.txt

cat /tmp/sells.txt | sed -n 's/.*Token: \([A-Za-z0-9]\{8\}\).*/\1/p' > /tmp/sell_tokens.txt
cat /tmp/sells.txt | sed -n 's/.*\([0-9\.]\+\)x |.*/\1/p' > /tmp/sell_mults.txt

paste -d' ' /tmp/sell_tokens.txt /tmp/sell_mults.txt | awk '$1 != "" && $2 != "" {print}' > /tmp/sell_tokens_full.txt

echo "Найдено закрытий: $(wc -l < /tmp/sell_tokens_full.txt)"
echo ""

# Связываем закрытия с entry age
echo "Связывание данных..."
awk 'FNR==NR {
    # Загружаем маппинг token -> entry age
    token_age[$1] = $2;
    next
}
{
    # Обрабатываем закрытия
    token = $1;
    mult = $2;
    age = token_age[token];
    
    if (age != "" && age != "0") {
        # Определяем очередь
        if (age >= 0 && age <= 5) {
            queue = "queue1";
        } else if (age > 5 && age <= 15) {
            queue = "queue2";
        } else {
            queue = "queue3+";
        }
        print queue, age, mult, token;
    }
}' /tmp/token_entry_age.txt /tmp/sell_tokens_full.txt > /tmp/queue_analysis.txt

echo "Связано позиций: $(wc -l < /tmp/queue_analysis.txt)"
echo ""

if [ ! -s /tmp/queue_analysis.txt ]; then
    echo "⚠️  Не удалось связать данные. Возможно, недостаточно данных в логах."
    echo "Попробуйте позже, когда накопится больше закрытых позиций."
    rm -f /tmp/opens.txt /tmp/tokens.txt /tmp/ages_*.txt /tmp/token_age_*.txt /tmp/token_entry_age.txt /tmp/sells.txt /tmp/sell_*.txt
    exit 0
fi

echo "=== РАСПРЕДЕЛЕНИЕ ПО ОЧЕРЕДЯМ ==="
echo ""

echo "Распределение всех закрытых позиций:"
awk '{print $1}' /tmp/queue_analysis.txt | sort | uniq -c | sort -rn

echo ""
echo "=== УСПЕШНЫЕ ТОКЕНЫ (>= 2.5x) ПО ОЧЕРЕДЯМ ==="
echo ""

# Фильтруем успешные (>= 2.5x)
awk '$3 >= 2.5 {print $1, $2, $3}' /tmp/queue_analysis.txt > /tmp/successful_tokens.txt

echo "Всего успешных токенов (>= 2.5x): $(wc -l < /tmp/successful_tokens.txt)"
echo ""

if [ -s /tmp/successful_tokens.txt ]; then
    echo "Распределение успешных токенов по очередям:"
    awk '{print $1}' /tmp/successful_tokens.txt | sort | uniq -c | sort -rn
else
    echo "⚠️  Пока нет успешных токенов (>= 2.5x)"
fi

echo ""
echo "=== ДЕТАЛЬНАЯ СТАТИСТИКА ПО ОЧЕРЕДЯМ ==="
echo ""

for queue in "queue1" "queue2" "queue3+"; do
    echo "--- $queue ---"
    
    # Все позиции из этой очереди
    total=$(awk -v q="$queue" '$1 == q {count++} END {print count+0}' /tmp/queue_analysis.txt)
    
    if [ "$total" -eq 0 ]; then
        echo "Нет данных для этой очереди"
        echo ""
        continue
    fi
    
    # Успешные позиции (>= 2.5x)
    successful=$(awk -v q="$queue" '$1 == q && $3 >= 2.5 {count++} END {print count+0}' /tmp/queue_analysis.txt)
    
    # Хорошие позиции (>= 1.5x)
    good=$(awk -v q="$queue" '$1 == q && $3 >= 1.5 {count++} END {print count+0}' /tmp/queue_analysis.txt)
    
    # Поздние входы (0.7-0.9x)
    late=$(awk -v q="$queue" '$1 == q && $3 >= 0.7 && $3 < 1.0 {count++} END {print count+0}' /tmp/queue_analysis.txt)
    
    # Убыточные (< 0.7x)
    loss=$(awk -v q="$queue" '$1 == q && $3 < 0.7 {count++} END {print count+0}' /tmp/queue_analysis.txt)
    
    success_rate=$(echo "scale=1; $successful * 100 / $total" | bc 2>/dev/null || echo "0.0")
    good_rate=$(echo "scale=1; $good * 100 / $total" | bc 2>/dev/null || echo "0.0")
    
    echo "Всего позиций: $total"
    echo "Успешных (>= 2.5x): $successful ($success_rate%)"
    echo "Хороших (>= 1.5x): $good ($good_rate%)"
    echo "Поздние входы (0.7-0.9x): $late"
    echo "Убыточные (< 0.7x): $loss"
    
    # Средний multiplier
    avg_mult=$(awk -v q="$queue" '$1 == q {sum+=$3; count++} END {if (count > 0) printf "%.2f", sum/count; else print "0.00"}' /tmp/queue_analysis.txt)
    echo "Средний multiplier: ${avg_mult}x"
    
    # Средний entry age
    avg_age=$(awk -v q="$queue" '$1 == q {sum+=$2; count++} END {if (count > 0) printf "%.2f", sum/count; else print "0.00"}' /tmp/queue_analysis.txt)
    echo "Средний entry age: ${avg_age}s"
    echo ""
done

echo "=== ТОП-10 УСПЕШНЫХ ТОКЕНОВ С УКАЗАНИЕМ ОЧЕРЕДИ ==="
echo ""

if [ -s /tmp/successful_tokens.txt ]; then
    sort -k3 -rn /tmp/successful_tokens.txt | head -10 | awk '{
        printf "Queue: %-8s | Entry age: %5.2fs | Multiplier: %5.2fx\n", $1, $2, $3
    }'
else
    echo "Нет успешных токенов для отображения"
fi

echo ""
echo "=== РЕКОМЕНДАЦИИ ==="
echo ""

# Подсчитываем общую статистику
total_successful=$(wc -l < /tmp/successful_tokens.txt 2>/dev/null || echo "0")
queue1_success=$(awk '$1 == "queue1" && $3 >= 2.5 {count++} END {print count+0}' /tmp/queue_analysis.txt)
queue2_success=$(awk '$1 == "queue2" && $3 >= 2.5 {count++} END {print count+0}' /tmp/queue_analysis.txt)
queue3_success=$(awk '$1 == "queue3+" && $3 >= 2.5 {count++} END {print count+0}' /tmp/queue_analysis.txt)

if [ "$total_successful" -gt 0 ]; then
    queue1_pct=$(echo "scale=1; $queue1_success * 100 / $total_successful" | bc 2>/dev/null || echo "0.0")
    queue2_pct=$(echo "scale=1; $queue2_success * 100 / $total_successful" | bc 2>/dev/null || echo "0.0")
    queue3_pct=$(echo "scale=1; $queue3_success * 100 / $total_successful" | bc 2>/dev/null || echo "0.0")
    
    echo "Распределение успешных токенов (>= 2.5x):"
    echo "  Queue1 (0-5s):   $queue1_success ($queue1_pct%)"
    echo "  Queue2 (5-15s):  $queue2_success ($queue2_pct%)"
    echo "  Queue3+ (>15s):  $queue3_success ($queue3_pct%)"
    echo ""
    
    if [ $(echo "$queue1_pct > 50" | bc 2>/dev/null || echo "0") -eq 1 ]; then
        echo "✅ Queue1 дает большинство успешных токенов - фокус на queue1 оправдан"
    elif [ $(echo "$queue2_pct > 50" | bc 2>/dev/null || echo "0") -eq 1 ]; then
        echo "✅ Queue2 дает большинство успешных токенов - стоит рассмотреть фокус на queue2"
    else
        echo "⚠️  Успешные токены распределены между очередями - нужен баланс"
    fi
else
    echo "⚠️  Пока недостаточно данных для рекомендаций"
    echo "Нужно больше закрытых позиций для анализа"
fi

# Очистка временных файлов
rm -f /tmp/opens.txt /tmp/tokens.txt /tmp/ages_*.txt /tmp/token_age_*.txt /tmp/token_entry_age.txt /tmp/sells.txt /tmp/sell_*.txt /tmp/queue_analysis.txt /tmp/successful_tokens.txt

echo ""
echo "Анализ завершен."
