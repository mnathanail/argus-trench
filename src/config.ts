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
   * Allowlist των chat ids που επιτρέπεται να δίνουν εντολές.
   *
   * Ένα Telegram bot δέχεται μηνύματα από ΟΠΟΙΟΝΔΗΠΟΤΕ ξέρει το username του, και τα
   * `/watch` / `/unwatch` γράφουν στη watchlist που τροφοδοτεί τα trading signals. Χωρίς
   * allowlist, ένας τρίτος θα μπορούσε να βάλει δικά του wallets στη λίστα μας. Άρα:
   * κενή allowlist = **κανείς**, όχι όλοι.
   */
  telegramAllowedChatIds: (): readonly number[] => {
    const raw = optional('TELEGRAM_CHAT_ID');
    if (raw === undefined) return [];
    return raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((id) => Number.isFinite(id) && id !== 0);
  },

  /**
   * Το paper/live switch. Μόνο η ρητή τιμή '1' ενεργοποιεί αυτόματες συναλλαγές —
   * κάθε άλλη τιμή (ή unset) σημαίνει log-only/paper. Δε γίνεται truthy-coercion
   * επίτηδες: ένα "false"/"0"/"no" δεν πρέπει να ανοίγει live trading κατά λάθος.
   */
  automatedTradesAllowed: () => process.env.GMGN_ALLOW_AUTOMATED_TRADES === '1',
} as const;
