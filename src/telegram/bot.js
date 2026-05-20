import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

function boolFromEnv(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// Default: polling enabled (commands need updates). Set TELEGRAM_POLLING=false to run send-only.
const polling = boolFromEnv('TELEGRAM_POLLING', true);
export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling });

bot.on('polling_error', (err) => {
  // Common causes: multiple instances polling same token, network flaps, Telegram rate limits.
  console.log(`[telegram] polling_error: ${err?.message || String(err)}`);
});

bot.on('webhook_error', (err) => {
  console.log(`[telegram] webhook_error: ${err?.message || String(err)}`);
});
