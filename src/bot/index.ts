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
