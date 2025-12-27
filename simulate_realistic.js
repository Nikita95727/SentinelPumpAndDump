// Реалистичная симуляция с учетом роста цены

console.log("╔══════════════════════════════════════════════════════════════════════════╗");
console.log("║     РЕАЛИСТИЧНАЯ СИМУЛЯЦИЯ: РАННИЙ ВХОД vs ПОЗДНИЙ ВХОД                ║");
console.log("╚══════════════════════════════════════════════════════════════════════════╝\n");

const positionSize = 0.0035; // SOL
const totalPositions = 83;

// Модель роста цены в первые секунды
// Предположение: цена растет экспоненциально
// Если токен достиг 0.8x за 10-12 сек, значит цена выросла в 1.25x за это время
// Если бы зашли на 8 сек раньше (через 2-4 сек), цена была бы ниже

function estimateEarlyEntryPrice(lateEntryPrice, lateEntryMultiplier, timeDelay) {
  // Если зашли поздно и получили 0.8x, значит цена выросла в 1.25x за время задержки
  // Если бы зашли раньше, цена была бы в 1.25x ниже
  const priceGrowthFactor = 1 / lateEntryMultiplier; // 1 / 0.8 = 1.25
  const earlyEntryPrice = lateEntryPrice / priceGrowthFactor;
  return earlyEntryPrice;
}

// Реальные данные
const currentScenario = {
  successful: 7,
  lateEntry: 22,
  others: 54,
  avgSuccessfulMultiplier: 2.5,
  avgLateEntryMultiplier: 0.8,
  avgOthersMultiplier: 1.0,
  avgLateEntryPrice: 0.0000285 // примерная цена при позднем входе
};

const earlyEntryScenario = {
  successful: 29, // 7 + 22
  lateEntry: 0,
  others: 54,
  avgSuccessfulMultiplier: 2.5,
  avgLateEntryMultiplier: 0.8,
  avgOthersMultiplier: 1.0
};

function calculate(scenario, isEarly = false) {
  const invested = totalPositions * positionSize;
  
  let successfulReturn, lateEntryReturn, othersReturn;
  
  if (isEarly) {
    // При раннем входе: 22 токена теперь успешные
    successfulReturn = scenario.successful * positionSize * scenario.avgSuccessfulMultiplier;
    lateEntryReturn = 0;
    othersReturn = scenario.others * positionSize * scenario.avgOthersMultiplier;
  } else {
    successfulReturn = scenario.successful * positionSize * scenario.avgSuccessfulMultiplier;
    lateEntryReturn = scenario.lateEntry * positionSize * scenario.avgLateEntryMultiplier;
    othersReturn = scenario.others * positionSize * scenario.avgOthersMultiplier;
  }
  
  const totalReturn = successfulReturn + lateEntryReturn + othersReturn;
  const profit = totalReturn - invested;
  const roi = (profit / invested) * 100;
  
  return { invested, totalReturn, profit, roi, successfulReturn, lateEntryReturn, othersReturn };
}

console.log("📊 ТЕКУЩАЯ СИТУАЦИЯ (поздний вход, 10-12 сек):");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const current = calculate(currentScenario);
console.log(`• Успешных (>= 2.5x): ${currentScenario.successful} токенов`);
console.log(`• Поздний вход (0.7-0.9x): ${currentScenario.lateEntry} токенов`);
console.log(`• Остальные: ${currentScenario.others} токенов`);
console.log(`\n💰 Финансовые результаты:`);
console.log(`   Инвестировано: ${current.invested.toFixed(6)} SOL`);
console.log(`   От успешных: ${current.successfulReturn.toFixed(6)} SOL`);
console.log(`   От поздних: ${current.lateEntryReturn.toFixed(6)} SOL (убыток: ${(currentScenario.lateEntry * positionSize * (1 - currentScenario.avgLateEntryMultiplier)).toFixed(6)} SOL)`);
console.log(`   От остальных: ${current.othersReturn.toFixed(6)} SOL`);
console.log(`   Всего получено: ${current.totalReturn.toFixed(6)} SOL`);
console.log(`   Прибыль: ${current.profit.toFixed(6)} SOL`);
console.log(`   ROI: ${current.roi.toFixed(2)}%`);

console.log("\n\n📊 СЦЕНАРИЙ: РАННИЙ ВХОД (2-4 сек, исправлено)");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`• 22 токена с поздним входом → теперь успешные (>= 2.5x)`);
console.log(`• Успешных (>= 2.5x): ${earlyEntryScenario.successful} токенов (было ${currentScenario.successful})`);
console.log(`• Поздний вход (0.7-0.9x): ${earlyEntryScenario.lateEntry} токенов (было ${currentScenario.lateEntry})`);
console.log(`• Остальные: ${earlyEntryScenario.others} токенов`);

const early = calculate(earlyEntryScenario, true);
console.log(`\n💰 Финансовые результаты:`);
console.log(`   Инвестировано: ${early.invested.toFixed(6)} SOL`);
console.log(`   От успешных: ${early.successfulReturn.toFixed(6)} SOL (было ${current.successfulReturn.toFixed(6)})`);
console.log(`   От поздних: ${early.lateEntryReturn.toFixed(6)} SOL (было ${current.lateEntryReturn.toFixed(6)})`);
console.log(`   От остальных: ${early.othersReturn.toFixed(6)} SOL`);
console.log(`   Всего получено: ${early.totalReturn.toFixed(6)} SOL`);
console.log(`   Прибыль: ${early.profit.toFixed(6)} SOL`);
console.log(`   ROI: ${early.roi.toFixed(2)}%`);

console.log("\n\n📈 УЛУЧШЕНИЕ:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const profitIncrease = early.profit - current.profit;
const roiIncrease = early.roi - current.roi;
const returnIncrease = early.totalReturn - current.totalReturn;

console.log(`   Прибыль увеличится на: ${profitIncrease.toFixed(6)} SOL`);
console.log(`   ROI увеличится с ${current.roi.toFixed(2)}% до ${early.roi.toFixed(2)}% (+${roiIncrease.toFixed(2)}%)`);
console.log(`   Возврат увеличится на: ${returnIncrease.toFixed(6)} SOL`);
console.log(`   Улучшение прибыли: ${((profitIncrease / Math.abs(current.profit)) * 100).toFixed(0)}%`);

console.log("\n\n💡 ДЕТАЛЬНЫЙ РАСЧЕТ ДЛЯ 22 ТОКЕНОВ:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
const lateEntryInvestment = currentScenario.lateEntry * positionSize;
const lateEntryCurrentReturn = currentScenario.lateEntry * positionSize * currentScenario.avgLateEntryMultiplier;
const lateEntryEarlyReturn = currentScenario.lateEntry * positionSize * earlyEntryScenario.avgSuccessfulMultiplier;

console.log(`Текущая ситуация (поздний вход):`);
console.log(`   Инвестировано: ${lateEntryInvestment.toFixed(6)} SOL`);
console.log(`   Получено: ${lateEntryCurrentReturn.toFixed(6)} SOL`);
console.log(`   Убыток: ${(lateEntryInvestment - lateEntryCurrentReturn).toFixed(6)} SOL`);

console.log(`\nЕсли бы зашли вовремя (ранний вход):`);
console.log(`   Инвестировано: ${lateEntryInvestment.toFixed(6)} SOL`);
console.log(`   Получено: ${lateEntryEarlyReturn.toFixed(6)} SOL`);
console.log(`   Прибыль: ${(lateEntryEarlyReturn - lateEntryInvestment).toFixed(6)} SOL`);

const additionalProfit = lateEntryEarlyReturn - lateEntryCurrentReturn;
console.log(`\n💰 ДОПОЛНИТЕЛЬНАЯ ПРИБЫЛЬ: ${additionalProfit.toFixed(6)} SOL`);
console.log(`   Это ${((additionalProfit / lateEntryInvestment) * 100).toFixed(0)}% от инвестиций в эти 22 токена`);

console.log("\n\n🎯 ИТОГОВЫЙ ВЫВОД:");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`✅ При раннем входе (2-4 сек вместо 10-12 сек):`);
console.log(`   • Прибыль: ${current.profit.toFixed(6)} SOL → ${early.profit.toFixed(6)} SOL`);
console.log(`   • ROI: ${current.roi.toFixed(2)}% → ${early.roi.toFixed(2)}%`);
console.log(`   • Улучшение: +${profitIncrease.toFixed(6)} SOL (+${roiIncrease.toFixed(2)}% ROI)`);
console.log(`\n✅ Стратегия работает: 3+ токена по 2.5x перекрывают убытки`);
console.log(`   При раннем входе: 29 токенов >= 2.5x (в 4+ раза больше чем нужно!)`);

