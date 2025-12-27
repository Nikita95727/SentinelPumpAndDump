// Симуляция раннего входа в токены

// Данные из логов:
// - Токены с 0.7-0.9x (поздний вход)
// - Entry price при позднем входе
// - Финальный multiplier

// Модель: если зашли на 8 секунд раньше, цена была бы ниже
// Предположение: цена растет экспоненциально в первые секунды
// Формула: price(t) = price0 * (1 + growth_rate)^t

const scenarios = [
  {
    name: "Текущая ситуация (поздний вход)",
    totalPositions: 83,
    successful: 7,      // >= 2.5x
    lateEntry: 22,     // 0.7-0.9x (поздний вход)
    others: 54,         // остальные
    positionSize: 0.0035,
    avgSuccessfulMultiplier: 2.5,
    avgLateEntryMultiplier: 0.8,
    avgOthersMultiplier: 1.0
  },
  {
    name: "Сценарий: Ранний вход (исправлено)",
    totalPositions: 83,
    successful: 29,     // 7 + 22 (раньше зашли)
    lateEntry: 0,       // нет поздних входов
    others: 54,
    positionSize: 0.0035,
    avgSuccessfulMultiplier: 2.5,
    avgLateEntryMultiplier: 0.8,
    avgOthersMultiplier: 1.0
  }
];

function calculateProfit(scenario) {
  const invested = scenario.totalPositions * scenario.positionSize;
  
  const successfulReturn = scenario.successful * scenario.positionSize * scenario.avgSuccessfulMultiplier;
  const lateEntryReturn = scenario.lateEntry * scenario.positionSize * scenario.avgLateEntryMultiplier;
  const othersReturn = scenario.others * scenario.positionSize * scenario.avgOthersMultiplier;
  
  const totalReturn = successfulReturn + lateEntryReturn + othersReturn;
  const profit = totalReturn - invested;
  const roi = (profit / invested) * 100;
  
  return {
    invested,
    totalReturn,
    profit,
    roi,
    successfulReturn,
    lateEntryReturn,
    othersReturn
  };
}

console.log("╔══════════════════════════════════════════════════════════════════════════╗");
console.log("║           СИМУЛЯЦИЯ: РАННИЙ ВХОД vs ПОЗДНИЙ ВХОД                        ║");
console.log("╚══════════════════════════════════════════════════════════════════════════╝\n");

scenarios.forEach((scenario, index) => {
  const result = calculateProfit(scenario);
  
  console.log(`📊 ${scenario.name}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Всего позиций: ${scenario.totalPositions}`);
  console.log(`Успешных (>= 2.5x): ${scenario.successful}`);
  console.log(`Поздний вход (0.7-0.9x): ${scenario.lateEntry}`);
  console.log(`Остальные: ${scenario.others}`);
  console.log("");
  console.log(`💰 ФИНАНСОВЫЕ РЕЗУЛЬТАТЫ:`);
  console.log(`   Инвестировано: ${result.invested.toFixed(6)} SOL`);
  console.log(`   От успешных: ${result.successfulReturn.toFixed(6)} SOL`);
  console.log(`   От поздних: ${result.lateEntryReturn.toFixed(6)} SOL`);
  console.log(`   От остальных: ${result.othersReturn.toFixed(6)} SOL`);
  console.log(`   Всего получено: ${result.totalReturn.toFixed(6)} SOL`);
  console.log(`   Прибыль: ${result.profit.toFixed(6)} SOL`);
  console.log(`   ROI: ${result.roi.toFixed(2)}%`);
  console.log("");
  
  if (index === 0) {
    console.log("📈 УЛУЧШЕНИЕ:");
    const nextResult = calculateProfit(scenarios[1]);
    const improvement = nextResult.profit - result.profit;
    const roiImprovement = nextResult.roi - result.roi;
    console.log(`   Прибыль увеличится на: ${improvement.toFixed(6)} SOL`);
    console.log(`   ROI увеличится на: ${roiImprovement.toFixed(2)}%`);
    console.log("");
  }
});

// Детальный расчет для 22 токенов с поздним входом
console.log("🔍 ДЕТАЛЬНЫЙ АНАЛИЗ 22 ТОКЕНОВ С ПОЗДНИМ ВХОДОМ:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const lateEntryTokens = 22;
const positionSize = 0.0035;
const currentMultiplier = 0.8;
const targetMultiplier = 2.5;

console.log(`Текущая ситуация (поздний вход):`);
console.log(`   Инвестировано: ${(lateEntryTokens * positionSize).toFixed(6)} SOL`);
console.log(`   Получено: ${(lateEntryTokens * positionSize * currentMultiplier).toFixed(6)} SOL`);
console.log(`   Убыток: ${(lateEntryTokens * positionSize * (1 - currentMultiplier)).toFixed(6)} SOL`);

console.log(`\nЕсли бы зашли вовремя (ранний вход):`);
console.log(`   Инвестировано: ${(lateEntryTokens * positionSize).toFixed(6)} SOL`);
console.log(`   Получено: ${(lateEntryTokens * positionSize * targetMultiplier).toFixed(6)} SOL`);
console.log(`   Прибыль: ${(lateEntryTokens * positionSize * (targetMultiplier - 1)).toFixed(6)} SOL`);

const additionalProfit = lateEntryTokens * positionSize * (targetMultiplier - currentMultiplier);
console.log(`\n💰 ДОПОЛНИТЕЛЬНАЯ ПРИБЫЛЬ: ${additionalProfit.toFixed(6)} SOL`);
console.log(`   Это ${((additionalProfit / (lateEntryTokens * positionSize)) * 100).toFixed(0)}% от инвестиций в эти токены`);

