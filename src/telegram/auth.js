import { TELEGRAM_CHAT_ID } from '../config.js';

/** Only the configured alert chat may control the bot. */
export function isAuthorizedChat(chatId) {
  if (!TELEGRAM_CHAT_ID) return true;
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

export function unauthorizedMessage() {
  return 'Unauthorized chat. Commands only work from TELEGRAM_CHAT_ID.';
}
