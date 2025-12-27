// Детальная симуляция с реальными данными

console.log("╔══════════════════════════════════════════════════════════════════════════╗");
console.log("║        ДЕТАЛЬНАЯ СИМУЛЯЦИЯ: ЧТО БЫЛО БЫ ПРИ РАННЕМ ВХОДЕ                 ║");
console.log("╚══════════════════════════════════════════════════════════════════════════╝\n");

const positionSize = 0.0035; // SOL
const totalPositions = 83;

// Реальные данные из анализа
const currentScenario = {
  successful: 7,        // >= 2.5x
  lateEntry: 22,        // 0.7-0.9x (поздний вход)
  others: 54,           // остальные (разные результаты)
  avgSuccessfulMultiplier: 2.5,
  avgLateEntryMultiplier: 0.8,
  avgOthersMultiplier: 1.0
};

const earlyEntryScenario = {
  successful: 29,       // 7 + 22 (раньше зашли)
  lateEntry: 0,         // нет поздних входов
  others: 54,
  avgSuccessfulMultiplier: 2.5,
  avgLateEntryMultiplier: 0.8,
  avgOthersMultiplier: 1.0
};

function calculate(scenario) {
  const invested = totalPositions * positionSize;
  
  const successfulReturn = scenario.successful * positionSize * scenario.avgSuccessfulMultiplier;
  const lateEntryReturn = scenario.lateEntry * positionSize * scenario.avgLateEntryMultiplier;
  const othersReturn = scenario.others * positionSize * scenario.avgOthersMultiplier;
  
  const totalReturn = successfulReturn + lateEntryReturn + othersReturn;
  const profit = totalReturn - invested;
  const roi = (profit / invested) * 100;
  
  return { invested, totalReturn, profit, roi, successfulReturn, lateEntryReturn, othersReturn };
}

console.log("📊 ТЕКУЩАЯ СИТУАЦИЯ (поздний вход):");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const current = calculate(currentScenario);
console.log(`Успешных (>= 2.5x): ${currentScenario.successful}`);
console.log(`Поздний вход (0.7-0.9x): ${currentScenario.lateEntry}`);
console.log(`Остальные: ${currentScenario.others}`);
console.log(`\n💰 Результаты:`);
console.log(`   Инвестировано: ${current.invested.toFixed(6)} SOL`);
console.log(`   Получено: ${current.totalReturn.toFixed(6)} SOL`);
console.log(`   Прибыль: ${current.profit.toFixed(6)} SOL`);
console.log(`   ROI: ${current.roi.toFixed(2)}%`);

console.log("\n\n📊 СЦЕНАРИЙ: РАННИЙ ВХОД (исправлено)");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const early = calculate(earlyEntryScenario);
console.log(`Успешных (>= 2.5x): ${earlyEntryScenario.successful} (было ${currentScenario.successful})`);
console.log(`Поздний вход (0.7-0.9x): ${earlyEntryScenario.lateEntry} (было ${currentScenario.lateEntry})`);
console.log(`Остальные: ${earlyEntryScenario.others}`);
console.log(`\n💰 Результаты:`);
console.log(`   Инвестировано: ${early.invested.toFixed(6)} SOL`);
console.log(`   Получено: ${early.totalReturn.toFixed(6)} SOL`);
console.log(`   Прибыль: ${early.profit.toFixed(6)} SOL`);
console.log(`   ROI: ${early.roi.toFixed(2)}%`);

console.log("\n\n📈 УЛУЧШЕНИЕ:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const profitIncrease = early.profit - current.profit;
const roiIncrease = early.roi - current.roi;
const returnIncrease = early.totalReturn - current.totalReturn;

console.log(`   Прибыль увеличится на: ${profitIncrease.toFixed(6)} SOL`);
console.log(`   ROI увеличится на: ${roiIncrease.toFixed(2)}%`);
console.log(`   Возврат увеличится на: ${returnIncrease.toFixed(6)} SOL`);
console.log(`   Улучшение: ${((profitIncrease / current.profit) * 100).toFixed(0)}%`);

console.log("\n\n🎯 КЛЮЧЕВОЙ ВЫВОД:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`22 токена с поздним входом (0.7-0.9x) → потенциально >= 2.5x`);
console.log(`Дополнительная прибыль: ${(22 * positionSize * (2.5 - 0.8)).toFixed(6)} SOL`);
console.log(`Это ${((22 * positionSize * (2.5 - 0.8)) / current.invested * 100).toFixed(1)}% от всех инвестиций`);

