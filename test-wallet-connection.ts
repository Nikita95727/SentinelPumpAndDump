import * as dotenv from 'dotenv';
import { RealTradingAdapter } from './src/real-trading-adapter';
import { getConnection } from './src/utils';

dotenv.config();

async function testWalletConnection() {
  console.log('🔍 Testing wallet connection...\n');

  try {
    const connection = await getConnection();
    console.log('✅ Connected to Solana RPC');

    const mnemonic = process.env.WALLET_MNEMONIC;
    if (!mnemonic) {
      console.error('❌ WALLET_MNEMONIC not found in .env');
      process.exit(1);
    }

    console.log(`📝 Wallet mnemonic found: ${mnemonic.substring(0, 10)}...${mnemonic.substring(mnemonic.length - 10)}\n`);

    const adapter = new RealTradingAdapter(connection);
    const success = await adapter.initialize(mnemonic);

    if (!success) {
      console.error('❌ Failed to initialize wallet');
      process.exit(1);
    }

    const address = adapter.getPublicKeyString();
    const balance = await adapter.getBalance();

    console.log('\n✅ ===== WALLET CONNECTION SUCCESS =====');
    console.log(`Wallet Address: ${address}`);
    console.log(`Balance: ${balance.toFixed(6)} SOL ($${(balance * 123).toFixed(2)})`);
    console.log('✅ ======================================\n');

    // Health check
    const health = await adapter.healthCheck();
    if (health.healthy) {
      console.log('✅ Wallet health check: OK');
    } else {
      console.warn(`⚠️ Wallet health check: ${health.error}`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

testWalletConnection();

