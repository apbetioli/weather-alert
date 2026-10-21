import { Bot } from 'grammy';
import { env } from '../config/env';
import { registerBotHandlers } from './handlers';

export function createBot(): Bot | null {
  if (!env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN === 'your_telegram_bot_token_here') {
    console.warn(
      '⚠️  [Telegram Bot] TELEGRAM_BOT_TOKEN is not set in .env. Bot polling skipped.\n' +
        '👉 To enable live Telegram alerts, open @BotFather in Telegram, create a bot, and paste the token into .env.'
    );
    return null;
  }

  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Universal Fallback Transformer: Guarantees that no notification is ever dropped due to formatting syntax errors
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (err: any) {
      if (
        method === 'sendMessage' &&
        err?.error_code === 400 &&
        typeof err?.description === 'string' &&
        err.description.includes("can't parse entities")
      ) {
        console.warn(
          `⚠️ [Telegram API Transformer] Parse error intercepted: "${err.description}". Retrying as plain text to guarantee delivery.`
        );
        const fallbackPayload = { ...(payload as any) };
        delete fallbackPayload.parse_mode;
        delete fallbackPayload.entities;
        if (typeof fallbackPayload.text === 'string') {
          // Strip formatting tags so plain text is clean
          fallbackPayload.text = fallbackPayload.text
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
        }
        return await prev(method, fallbackPayload, signal);
      }
      throw err;
    }
  });

  registerBotHandlers(bot);

  // Catch bot errors gracefully
  bot.catch((err) => {
    console.error(`❌ [Telegram Bot Error]:`, err);
  });

  return bot;
}

export async function startBot(bot: Bot) {
  console.log('🤖 Starting Telegram Bot via Long Polling...');
  // Using long polling: no public webhook, no ngrok required!
  bot.start({
    onStart: (botInfo) => {
      console.log(`✅ Telegram Bot @${botInfo.username} is running and listening for locations!`);
    },
  });
}
