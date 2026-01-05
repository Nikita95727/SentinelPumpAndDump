import * as https from 'https';
import { config } from './config';
import { logger } from './logger';
import { getCurrentTimestamp } from './utils';

export class TelegramNotifier {
    private botToken: string;
    private chatId: string;
    private enabled: boolean;

    constructor() {
        this.botToken = config.telegramBotToken || '';
        this.chatId = config.telegramChatId || '';
        this.enabled = !!(this.botToken && this.chatId);

        if (this.enabled) {
            logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'info',
                message: '✅ TelegramNotifier initialized',
            });
        } else {
            logger.log({
                timestamp: getCurrentTimestamp(),
                type: 'warning',
                message: '⚠️ TelegramNotifier disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing',
            });
        }
    }

    /**
     * Send a raw message to Telegram
     */
    private async sendMessage(message: string): Promise<void> {
        if (!this.enabled) return;

        // Remove markdown symbols that might break parsing or use plain text if complex
        // For simplicity, we use HTML parse mode for bold/links
        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
        const payload = JSON.stringify({
            chat_id: this.chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        });

        return new Promise((resolve, reject) => {
            const req = https.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length,
                },
            }, (res) => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve();
                } else {
                    // Consume response data to free memory
                    res.resume();
                    // Don't log error to avoid flooding logs if API is down, just fail silently or debug
                    // console.error(\`Telegram API Error: \${res.statusCode}\`);
                    resolve();
                }
            });

            req.on('error', (e) => {
                logger.log({
                    timestamp: getCurrentTimestamp(),
                    type: 'error',
                    message: `Telegram Send Error: ${e.message}`,
                });
                resolve(); // Resolve anyway to not block flow
            });

            req.write(payload);
            req.end();
        });
    }

    /**
     * 1. Уведомление об обнаруженном токене
     */
    async notifyTokenDetected(token: string, type: 'GEM' | 'MANIPULATOR' | 'CANDIDATE', marketCap?: number): Promise<void> {
        const emoji = type === 'GEM' ? '💎' : type === 'MANIPULATOR' ? '🎭' : '👀';
        const mcapStr = marketCap ? ` ($${(marketCap / 1000).toFixed(1)}k)` : '';
        const msg = `
<b>${emoji} Token Detected: ${type}</b>

Token: <code>${token}</code>
Type: <b>${type}</b>${mcapStr}

<a href="https://pump.fun/${token}">Pump.fun</a> | <a href="https://solscan.io/token/${token}">Solscan</a>
`;
        await this.sendMessage(msg);
    }

    /**
     * 2. Уведомление об открытии сделки
     */
    async notifyTradeOpened(token: string, sizeSol: number, mcap: number, isPaper: boolean): Promise<void> {
        const mode = isPaper ? '[PAPER]' : '[REAL]';
        const msg = `
<b>🚀 Trade Opened ${mode}</b>

Token: <code>${token}</code>
Position: <b>${sizeSol.toFixed(4)} SOL</b>
MCap Entry: <b>$${(mcap / 1000).toFixed(1)}k</b>

<a href="https://pump.fun/${token}">Pump.fun</a>
`;
        await this.sendMessage(msg);
    }

    /**
     * 3. Уведомление о закрытии сделки
     */
    async notifyTradeClosed(
        token: string,
        sizeSol: number,
        profitSol: number,
        profitPct: number,
        mcapExit: number,
        reason: string,
        isPaper: boolean
    ): Promise<void> {
        const mode = isPaper ? '[PAPER]' : '[REAL]';
        const outcomeEmoji = profitSol >= 0 ? '✅' : '❌';
        const profitColor = profitSol >= 0 ? '+' : ''; // HTML doesn't support color easily without creating images/complex, just use +/-

        // Calculate precise profit percentage representation
        const profitStr = `${profitColor}${profitSol.toFixed(5)} SOL (${profitColor}${(profitPct * 100).toFixed(2)}%)`;

        const msg = `
<b>${outcomeEmoji} Trade Closed ${mode}</b>

Token: <code>${token}</code>
Position: <b>${sizeSol.toFixed(4)} SOL</b>
Profit: <b>${profitStr}</b>
MCap Exit: <b>$${(mcapExit / 1000).toFixed(1)}k</b>
Reason: ${reason}

<a href="https://pump.fun/${token}">Pump.fun</a>
`;
        await this.sendMessage(msg);
    }

    /**
     * 4. Ежечасный отчет
     */
    async notifyHourlyStatus(
        balance: number,
        startBalance: number,
        activePositions: number,
        tradesCount: number,
        isPaper: boolean
    ): Promise<void> {
        const mode = isPaper ? '[PAPER]' : '[REAL]';
        const change = balance - startBalance;
        const changeEmoji = change >= 0 ? '📈' : '📉';
        const changeSign = change >= 0 ? '+' : '';

        const msg = `
<b>📊 Hourly Report ${mode}</b>

Current Balance: <b>${balance.toFixed(4)} SOL</b>
Change (1h): <b>${changeEmoji} ${changeSign}${change.toFixed(4)} SOL</b>
Active Positions: <b>${activePositions}</b>
Trades (1h): <b>${tradesCount}</b>
`;
        await this.sendMessage(msg);
    }
    /**
     * 5. Уведомление о запуске бота
     */
    async notifyBotStarted(balance: number, mode: 'real' | 'paper', initialConfig: any): Promise<void> {
        const modeStr = mode === 'real' ? '🔴 REAL TRADING' : '📄 PAPER TRADING';
        const msg = `
<b>🤖 Bot Started</b>

Mode: <b>${modeStr}</b>
Initial Balance: <b>${balance.toFixed(4)} SOL</b>
Network: <b>Mainnet</b>
Positions Limit: <b>${initialConfig.maxOpenPositions}</b>
Trailing Stop: <b>${initialConfig.trailingStopPct}%</b>

<i>Bot is now monitoring new tokens...</i>
`;
        await this.sendMessage(msg);
    }
}

export const telegramNotifier = new TelegramNotifier();
