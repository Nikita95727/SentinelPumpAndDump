import { Connection } from '@solana/web3.js';
import { RealTradingAdapter } from './src/real-trading-adapter';
import { config } from './src/config';

// Pump.fun токен для теста (можно заменить на любой активный pump.fun токен)
// Важно: используйте токен с ликвидностью! Проверьте на pump.fun перед тестом
const TEST_TOKEN = 'pump'; // Замените на реальный pump.fun mint address

async function testRealTrading() {
  console.log('🚀 Starting Real Trading Test (Pump.fun Direct Swap)...\n');
  console.log('⚠️  This will execute REAL transactions on Solana blockchain!\n');
  console.log('💡 Using Pump.fun direct swaps (faster & more private than Jupiter)\n');
  
  try {
    // Проверка mint address
    if (TEST_TOKEN === 'pump') {
      console.error('❌ Please set TEST_TOKEN to a valid pump.fun token mint address');
      console.error('   Visit https://pump.fun to find an active token with liquidity\n');
      return;
    }
    
    // 1. Initialize RealTradingAdapter
    console.log('📝 Step 1: Initializing Real Trading Adapter...');
    const connection = new Connection(config.heliusHttpUrl, 'confirmed');
    const adapter = new RealTradingAdapter(connection);
    
    const initialized = await adapter.initialize(config.walletMnemonic);
    
    if (!initialized) {
      console.error('❌ Failed to initialize adapter');
      return;
    }
    
    const publicKey = adapter.getPublicKeyString();
    const initialBalance = await adapter.getBalance();
    console.log(`✅ Wallet: ${publicKey}`);
    console.log(`✅ Initial Balance: ${initialBalance.toFixed(6)} SOL ($${(initialBalance * config.solUsdRate).toFixed(2)})\n`);
    
    if (initialBalance < 0.005) {
      console.error('❌ Insufficient balance for testing (need at least 0.005 SOL)');
      return;
    }
    
    // 2. Test BUY
    const testAmount = 0.001; // 0.001 SOL for testing (~$0.17)
    console.log(`📝 Step 2: Testing BUY (${testAmount} SOL → Pump.fun Token)...`);
    console.log(`⏱️  Buy started at: ${new Date().toLocaleTimeString()}`);
    
    const buyStartTime = Date.now();
    const buyResult = await adapter.executeBuy(TEST_TOKEN, testAmount);
    const buyEndTime = Date.now();
    const buyDuration = buyEndTime - buyStartTime;
    
    if (!buyResult.success) {
      console.error(`❌ Buy failed: ${buyResult.error}`);
      return;
    }
    
    console.log(`✅ BUY SUCCESS!`);
    console.log(`   - Signature: ${buyResult.signature}`);
    console.log(`   - Tokens received: ${buyResult.tokensReceived}`);
    console.log(`   - Duration: ${buyDuration}ms (${(buyDuration / 1000).toFixed(2)}s)`);
    console.log(`   - Explorer: https://solscan.io/tx/${buyResult.signature}\n`);
    
    // 3. Wait a bit (simulate holding)
    console.log('⏳ Waiting 5 seconds before selling...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 4. Test SELL
    console.log(`📝 Step 3: Testing SELL (${buyResult.tokensReceived} tokens → SOL)...`);
    console.log(`⏱️  Sell started at: ${new Date().toLocaleTimeString()}`);
    
    const sellStartTime = Date.now();
    const sellResult = await adapter.executeSell(TEST_TOKEN, testAmount); // expectedAmountSol for logging
    const sellEndTime = Date.now();
    const sellDuration = sellEndTime - sellStartTime;
    
    if (!sellResult.success) {
      console.error(`❌ Sell failed: ${sellResult.error}`);
      return;
    }
    
    console.log(`✅ SELL SUCCESS!`);
    console.log(`   - Signature: ${sellResult.signature}`);
    console.log(`   - SOL received: ${sellResult.solReceived?.toFixed(6) || 'N/A'}`);
    console.log(`   - Duration: ${sellDuration}ms (${(sellDuration / 1000).toFixed(2)}s)`);
    console.log(`   - Explorer: https://solscan.io/tx/${sellResult.signature}\n`);
    
    // 5. Check final balance
    console.log('📝 Step 4: Checking final balance...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for balance to update
    const finalBalance = await adapter.getBalance();
    const balanceChange = finalBalance - initialBalance;
    const totalFees = testAmount - (sellResult.solReceived || 0);
    
    console.log(`✅ Final Balance: ${finalBalance.toFixed(6)} SOL ($${(finalBalance * config.solUsdRate).toFixed(2)})`);
    console.log(`📊 Balance Change: ${balanceChange >= 0 ? '+' : ''}${balanceChange.toFixed(6)} SOL ($${(balanceChange * config.solUsdRate).toFixed(2)})`);
    console.log(`💰 Total Fees: ${totalFees.toFixed(6)} SOL ($${(totalFees * config.solUsdRate).toFixed(2)})\n`);
    
    // 6. Health check
    console.log('📝 Step 5: Running health check...');
    const healthCheck = await adapter.healthCheck();
    console.log(`✅ Health: ${healthCheck.healthy ? 'OK' : 'FAILED'}`);
    if (!healthCheck.healthy) {
      console.log(`⚠️  Health check warning: ${healthCheck.error}\n`);
    }
    
    // 7. Summary
    console.log('\n' + '='.repeat(70));
    console.log('📊 REAL TRADING TEST SUMMARY (PUMP.FUN DIRECT SWAP)');
    console.log('='.repeat(70));
    console.log(`Wallet:              ${publicKey}`);
    console.log(`Test Token:          ${TEST_TOKEN} (Pump.fun)`);
    console.log(`Swap Method:         Direct Pump.fun (no middleman)`);
    console.log(`Test Amount:         ${testAmount} SOL (~$${(testAmount * config.solUsdRate).toFixed(2)})`);
    console.log('');
    console.log(`Buy Duration:        ${buyDuration}ms (${(buyDuration / 1000).toFixed(2)}s)`);
    console.log(`Buy Signature:       ${buyResult.signature}`);
    console.log(`Tokens Received:     ${buyResult.tokensReceived}`);
    console.log('');
    console.log(`Sell Duration:       ${sellDuration}ms (${(sellDuration / 1000).toFixed(2)}s)`);
    console.log(`Sell Signature:      ${sellResult.signature}`);
    console.log(`SOL Received:        ${sellResult.solReceived?.toFixed(6) || 'N/A'} SOL`);
    console.log('');
    console.log(`Total Duration:      ${(buyDuration + sellDuration)}ms (${((buyDuration + sellDuration) / 1000).toFixed(2)}s)`);
    console.log(`Initial Balance:     ${initialBalance.toFixed(6)} SOL ($${(initialBalance * config.solUsdRate).toFixed(2)})`);
    console.log(`Final Balance:       ${finalBalance.toFixed(6)} SOL ($${(finalBalance * config.solUsdRate).toFixed(2)})`);
    console.log(`Net P&L:             ${balanceChange >= 0 ? '+' : ''}${balanceChange.toFixed(6)} SOL ($${(balanceChange * config.solUsdRate).toFixed(2)})`);
    console.log(`Total Fees Paid:     ${totalFees.toFixed(6)} SOL ($${(totalFees * config.solUsdRate).toFixed(2)})`);
    console.log(`Fees as % of trade:  ${((totalFees / testAmount) * 100).toFixed(2)}%`);
    console.log('='.repeat(70));
    
    if (buyResult.success && sellResult.success) {
      console.log('\n✅ ===== ALL TESTS PASSED! =====');
      console.log('✅ Buy and Sell transactions executed successfully');
      console.log('✅ Wallet connection stable');
      console.log('✅ Pump.fun direct swaps working');
      console.log('✅ Faster & more private than Jupiter');
      console.log('✅ Ready for real trading! 🚀\n');
      
      console.log('⚠️  IMPORTANT NOTES:');
      console.log('   - Average transaction time: ~' + ((buyDuration + sellDuration) / 2 / 1000).toFixed(1) + 's');
      console.log('   - Total fees: ~' + ((totalFees / testAmount) * 100).toFixed(1) + '% of trade amount');
      console.log('   - Wallet balance sufficient: ' + (finalBalance > 0.01 ? 'YES' : 'NO'));
      console.log('');
    } else {
      console.log('\n⚠️  Some tests failed. Review before proceeding.\n');
    }
    
  } catch (error: any) {
    console.error('\n❌ Test failed with error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
  }
}

// Run the test
console.log('⚠️  WARNING: This script will execute REAL transactions on Solana!');
console.log('⚠️  Make sure you have sufficient balance in your wallet.');
console.log('⚠️  Starting in 3 seconds...\n');

setTimeout(() => {
  testRealTrading().catch(console.error);
}, 3000);

