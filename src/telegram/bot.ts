import { config } from '../config.js';
import { fetchWalletStats } from '../gmgn/walletStats.js';
import { insertScore, recentScores } from '../db/repositories/walletScoreHistory.js';
import {
  getWallet,
  listActiveWallets,
  setWalletActive,
  updateWalletScore,
  upsertWallet,
} from '../db/repositories/watchlistWallets.js';
import { TelegramClient, type TelegramUpdate } from './api.js';
import { handleCommand, type CommandDeps } from './commands.js';

export function createCommandDeps(): CommandDeps {
  return {
    fetchStats: (address) => fetchWalletStats({ wallet: address }),
    upsertWallet: (input) => upsertWallet(input),
    getWallet: (address) => getWallet(address),
    setWalletActive: (address, active) => setWalletActive(address, active),
    updateWalletScore: (address, score) => updateWalletScore(address, score),
    insertScore: (input) => insertScore(input),
    recentScores: (address, limit) => recentScores(address, limit),
    listActiveWallets: () => listActiveWallets(),
  };
}

export interface AuthorizationResult {
  allowed: boolean;
  reason: string;
}

/**
 * Κενή allowlist σημαίνει **κανείς**, όχι όλοι.
 *
 * Το bot username είναι ανακαλύψιμο και οποιοσδήποτε μπορεί να του γράψει. Τα `/watch` /
 * `/unwatch` γράφουν στη watchlist που τροφοδοτεί τα entry signals, άρα ένα ανοιχτό bot
 * είναι μονοπάτι για να βάλει τρίτος τα δικά του wallets στη στρατηγική μας. Fail closed.
 */
export function authorize(chatId: number, allowed: readonly number[]): AuthorizationResult {
  if (allowed.length === 0) {
    return { allowed: false, reason: 'TELEGRAM_CHAT_ID is not set — refusing all commands' };
  }
  return allowed.includes(chatId)
    ? { allowed: true, reason: 'ok' }
    : { allowed: false, reason: `chat ${chatId} is not in the allowlist` };
}

export interface BotOptions {
  client: TelegramClient;
  deps: CommandDeps;
  allowedChatIds: readonly number[];
  signal?: AbortSignal;
  /** Ένεση για tests· default είναι ο πραγματικός logger. */
  log?: (message: string) => void;
}

export async function handleUpdate(update: TelegramUpdate, options: BotOptions): Promise<void> {
  const message = update.message;
  const text = message?.text;
  if (message === undefined || text === undefined) return;

  const chatId = message.chat.id;
  const auth = authorize(chatId, options.allowedChatIds);
  if (!auth.allowed) {
    // Δεν απαντάμε τίποτα σε μη εξουσιοδοτημένο chat: μια απάντηση επιβεβαιώνει ότι το
    // bot είναι ζωντανό και ποιος το έχει. Το καταγράφουμε όμως.
    options.log?.(`[telegram] rejected: ${auth.reason}`);
    return;
  }

  let reply: string;
  try {
    reply = await handleCommand(text, options.deps);
  } catch (error) {
    // Ένα σφάλμα σε μία εντολή δεν πρέπει να ρίξει το polling loop.
    const detail = error instanceof Error ? error.message : String(error);
    options.log?.(`[telegram] command failed: ${detail}`);
    reply = `❌ Κάτι πήγε λάθος: ${detail}`;
  }
  await options.client.sendMessage(chatId, reply, options.signal);
}

/**
 * Long-polling loop. Το offset προχωράει ΠΡΙΝ την επεξεργασία, ώστε ένα update που ρίχνει
 * τον handler να μη ξαναδιαβαστεί επ' άπειρον σε κάθε κύκλο (poison message).
 */
export async function runBot(options: BotOptions): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message));
  // Συνάρτηση και όχι απευθείας έλεγχος: η τιμή αλλάζει κατά τη διάρκεια των await, οπότε
  // ένα inline `signal?.aborted !== true` θα το «πάγωνε» ο compiler ως narrowed type.
  const aborted = (): boolean => options.signal?.aborted === true;
  let offset = 0;
  let backoffMs = 1_000;

  while (!aborted()) {
    try {
      const updates = await options.client.getUpdates(offset, 25, options.signal);
      backoffMs = 1_000;
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update, { ...options, log });
      }
    } catch (error) {
      if (aborted()) return;
      const detail = error instanceof Error ? error.message : String(error);
      log(`[telegram] poll failed, retrying in ${backoffMs}ms: ${detail}`);
      await sleep(backoffMs, options.signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function createBotFromEnv(signal?: AbortSignal): BotOptions {
  const token = config.telegramBotToken();
  if (token === undefined) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }
  return {
    client: new TelegramClient({ token }),
    deps: createCommandDeps(),
    allowedChatIds: config.telegramAllowedChatIds(),
    ...(signal ? { signal } : {}),
  };
}
