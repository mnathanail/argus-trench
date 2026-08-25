import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name} (βλ. .env.example)`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export const config = {
  databaseUrl: () => required('DATABASE_URL'),
  telegramBotToken: () => optional('TELEGRAM_BOT_TOKEN'),
  telegramChatId: () => optional('TELEGRAM_CHAT_ID'),

  /**
   * Το paper/live switch. Μόνο η ρητή τιμή '1' ενεργοποιεί αυτόματες συναλλαγές —
   * κάθε άλλη τιμή (ή unset) σημαίνει log-only/paper. Δε γίνεται truthy-coercion
   * επίτηδες: ένα "false"/"0"/"no" δεν πρέπει να ανοίγει live trading κατά λάθος.
   */
  automatedTradesAllowed: () => process.env.GMGN_ALLOW_AUTOMATED_TRADES === '1',
} as const;
