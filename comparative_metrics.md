# Strategy Comparison: Old vs New

## Old Strategy (2025-12-29 Results)
- **Entry**: Used standard RPC (delayed), subject to MEV sandboxing.
- **Slippage**: High (~40% impact).
- **Exits**: Hard Take Profit (1.77x) or "Abandon" (100% loss).
- **Result**: "Bad Day" with 1.3x-1.7x wins and total losses on bad tokens. Missed early impulse.

## New Strategy (Jito Aggressive)
- **Entry**: Jito Bundles (Private/Prioritized). Catch the *start* of the candle.
- **Slippage**: MEV Protection. Fill or Kill (50% tolerance) with price protection.
- **Exits**: Adaptive Trailing Stop (Tightens as profit grows). No ceiling for 3x-7x-10x.
- **Risk**: Force Sell (Stop Loss -15%). Return ~85% of capital instead of 0%.

## Predicted Outcome
Higher volume of successful "early" entries. Significantly higher RR (Risk/Reward) ratio due to smaller losses and uncapped wins.
