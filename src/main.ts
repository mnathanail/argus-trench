import { closePool } from './db/pool.js';
import { createBotFromEnv, runBot } from './telegram/bot.js';

/**
 * Entrypoint. Ένα process για όλα (απόφαση 2026-08-25) — προς το παρόν μόνο το Telegram
 * bot· οι collector loops του layer 1-2 θα μπουν στον ίδιο scheduler.
 */
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[main] ${signal} — shutting down`);
    controller.abort();
  });
}

const bot = createBotFromEnv(controller.signal);
const me = await bot.client.getMe();
console.log(`[main] telegram bot @${me.username ?? me.id} connected`);

if (bot.allowedChatIds.length === 0) {
  // Δεν σκάμε: το bot τρέχει και απορρίπτει τα πάντα. Αυτό είναι πιο χρήσιμο από crash,
  // γιατί επιτρέπει να βρεις το chat id σου από τα logs στέλνοντας ένα μήνυμα.
  console.warn(
    '[main] TELEGRAM_CHAT_ID is empty — every command will be refused. ' +
      'Send a message to the bot and read the rejected chat id from the log below.',
  );
}

try {
  await runBot(bot);
} finally {
  await closePool();
  console.log('[main] stopped');
}
