import type { WalletStats } from '../gmgn/walletStats.js';
import type { WatchlistWallet } from '../db/repositories/watchlistWallets.js';
import type { WalletScoreEntry } from '../db/repositories/walletScoreHistory.js';
import type { TradeSummary } from '../db/repositories/paperTrades.js';

/**
 * Οι εντολές του manual wallet watching. Καθαρά συναρτήσεις πάνω σε injected deps, ώστε
 * να τεστάρονται χωρίς Telegram και χωρίς βάση.
 *
 * Το `/watch` προσθέτει με `source='manual'`, `active=true` ΑΜΕΣΩΣ, χωρίς να περάσει το
 * threshold του auto-discovery — εμπιστευόμαστε την κρίση του χρήστη (CLAUDE.md). Το
 * threshold χρησιμοποιείται εδώ **μόνο** ως συμβουλευτική προειδοποίηση· τίποτα δεν
 * απενεργοποιείται αυτόματα.
 *
 * Το `/unwatch`, `/score` και `/list`/`/watchlist` δεν περιορίζονται σε manual wallets:
 * λειτουργούν σε ΟΠΟΙΟΔΗΠΟΤΕ wallet του `watchlist_wallets`. Το `/unwatch` συγκεκριμένα
 * είναι χειροκίνητο veto πάνω σε ΟΠΟΙΟ wallet — ακόμα και ένα auto-discovered που πέρασε
 * το algorithmic threshold μπορεί να απενεργοποιηθεί χειροκίνητα.
 */

/** Το ίδιο floor με το auto-discovery, αλλά advisory-only για manual wallets. */
export const ADVISORY_WIN_RATE_FLOOR = 0.5;
export const ADVISORY_TOKEN_COUNT_FLOOR = 15;

export interface CommandDeps {
  fetchStats(address: string): Promise<WalletStats>;
  upsertWallet(input: {
    address: string;
    source: 'manual';
    active: boolean;
  }): Promise<WatchlistWallet>;
  getWallet(address: string): Promise<WatchlistWallet | null>;
  setWalletActive(address: string, active: boolean): Promise<boolean>;
  updateWalletScore(
    address: string,
    score: { winRate: number | null; pnlMultiplier: number | null; tradeCount: number | null },
  ): Promise<WatchlistWallet | null>;
  insertScore(input: {
    walletAddress: string;
    winRate: number | null;
    pnlMultiplier: number | null;
    tradeCount: number | null;
  }): Promise<void>;
  recentScores(address: string, limit: number): Promise<WalletScoreEntry[]>;
  listActiveWallets(): Promise<WatchlistWallet[]>;
  listRecentTrades(limit: number): Promise<TradeSummary[]>;
}

const HELP = [
  'ArgusTrench — wallet watching',
  '',
  '/watch <address>     πρόσθεσε wallet στη watchlist (ενεργό αμέσως)',
  '/unwatch <address>   απενεργοποίησε wallet (οποιοδήποτε source — χειροκίνητο veto)',
  '/score <address>     τρέχον score + τάση από το ιστορικό',
  '/watchlist           όλα τα ενεργά wallets: source + τρέχον score',
  '/list                alias του /watchlist',
  '/trades              τελευταία signal_logged trades (log_only, Φάση 1)',
  '/help                αυτό το μήνυμα',
].join('\n');

/** Solana base58: 32–44 χαρακτήρες, χωρίς 0 O I l. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isLikelySolanaAddress(value: string): boolean {
  return SOLANA_ADDRESS.test(value);
}

export async function handleCommand(text: string, deps: CommandDeps): Promise<string> {
  const parts = text.trim().split(/\s+/);
  // Δουλεύει και με /watch@BotName, όπως στέλνει το Telegram σε groups.
  const command = (parts[0] ?? '').toLowerCase().split('@')[0];
  const argument = parts[1];

  switch (command) {
    case '/start':
    case '/help':
      return HELP;
    case '/watch':
      return withAddress(argument, (address) => watch(address, deps));
    case '/unwatch':
      return withAddress(argument, (address) => unwatch(address, deps));
    case '/score':
      return withAddress(argument, (address) => score(address, deps));
    case '/watchlist':
    case '/list':
      return watchlist(deps);
    case '/trades':
      return trades(deps);
    default:
      return `Άγνωστη εντολή: ${command || '(κενό)'}\n\n${HELP}`;
  }
}

async function withAddress(
  argument: string | undefined,
  handler: (address: string) => Promise<string>,
): Promise<string> {
  if (argument === undefined) return 'Λείπει το address. Παράδειγμα: /watch <address>';
  if (!isLikelySolanaAddress(argument)) {
    return `Δε μοιάζει με Solana address: ${argument}`;
  }
  return handler(argument);
}

async function watch(address: string, deps: CommandDeps): Promise<string> {
  // Πρώτα το upsert: αν το GMGN είναι κάτω, το wallet πρέπει ΠΑΡΑ ΤΑΥΤΑ να μπει στη
  // λίστα. Το scoring είναι πληροφορία, όχι προϋπόθεση.
  await deps.upsertWallet({ address, source: 'manual', active: true });

  let stats: WalletStats;
  try {
    stats = await deps.fetchStats(address);
  } catch (error) {
    return [
      `✅ Προστέθηκε (ενεργό): ${address}`,
      `⚠️ Το scoring απέτυχε: ${errorText(error)}`,
      'Θα ξανα-σκοραριστεί στον επόμενο κύκλο.',
    ].join('\n');
  }

  await persistScore(address, stats, deps);
  return [`✅ Προστέθηκε (ενεργό): ${address}`, formatStats(stats), advisory(stats)]
    .filter((line) => line !== '')
    .join('\n');
}

/** Χειροκίνητο veto — δουλεύει σε ΟΠΟΙΟΔΗΠΟΤΕ wallet, ανεξαρτήτως source. */
async function unwatch(address: string, deps: CommandDeps): Promise<string> {
  const existed = await deps.setWalletActive(address, false);
  return existed
    ? `🚫 Απενεργοποιήθηκε: ${address}\n(το ιστορικό score παραμένει)`
    : `Δεν βρέθηκε στη watchlist: ${address}`;
}

async function score(address: string, deps: CommandDeps): Promise<string> {
  const known = await deps.getWallet(address);
  let stats: WalletStats;
  try {
    stats = await deps.fetchStats(address);
  } catch (error) {
    return `⚠️ Δεν μπόρεσα να πάρω score για ${address}: ${errorText(error)}`;
  }

  // Το ιστορικό ΠΡΙΝ γράψουμε τη νέα μέτρηση, ώστε η "προηγούμενη" να είναι όντως η προηγούμενη.
  const history = known ? await deps.recentScores(address, 5) : [];
  if (known) await persistScore(address, stats, deps);

  const lines = [
    `📊 ${address}`,
    known ? `watchlist: ${known.active ? 'ενεργό' : 'ανενεργό'} (${known.source})` : 'watchlist: δεν είναι στη λίστα',
    formatStats(stats),
  ];

  const previous = history[0];
  if (previous?.winRate != null && stats.winRate != null) {
    const delta = stats.winRate - previous.winRate;
    const arrow = delta > 0.001 ? '↑' : delta < -0.001 ? '↓' : '→';
    lines.push(
      `τάση win rate: ${arrow} ${(delta * 100).toFixed(1)} pp από ${formatPercent(previous.winRate)} (${history.length} μετρήσεις στο ιστορικό)`,
    );
  }

  const note = advisory(stats);
  if (note !== '') lines.push(note);
  return lines.join('\n');
}

/**
 * Λιστάρει ΟΛΑ τα active wallets, οποιουδήποτε source, με το τελευταίο τους score — ώστε
 * να ξέρεις τι υπάρχει πριν αποφασίσεις `/unwatch` σε κάτι (π.χ. ένα auto-discovered
 * wallet που πέρασε το algorithmic threshold αλλά θέλεις να το βγάλεις χειροκίνητα).
 */
async function watchlist(deps: CommandDeps): Promise<string> {
  const wallets = await deps.listActiveWallets();
  if (wallets.length === 0) return 'Η watchlist είναι κενή.';
  const rows = wallets.map((w) => {
    const win = w.winRate == null ? '—' : formatPercent(w.winRate);
    const pnl = w.pnlMultiplier == null ? '—' : formatPercent(w.pnlMultiplier, true);
    const positions = w.tradeCount ?? '—';
    return `• ${w.address} — ${w.source} | win ${win} | pnl ${pnl} | ${positions} θέσεις`;
  });
  return [`Ενεργά wallets (${wallets.length}):`, ...rows].join('\n');
}

/**
 * Τι ήταν ένα signal, χωρίς να ανοίγεις τη βάση χειροκίνητα: token, πότε, ποιο wallet
 * το πυροδότησε, simulated entry, και τρέχουσα κατάσταση (open, ή closed + pnl).
 */
async function trades(deps: CommandDeps): Promise<string> {
  const recent = await deps.listRecentTrades(10);
  if (recent.length === 0) return 'Κανένα trade ακόμα (Φάση 1: μόνο μετά από signal_logged).';

  const rows = recent.map((t) => {
    const wallet = t.triggerWalletAddress === null ? '—' : short(t.triggerWalletAddress);
    const entryPrice = t.simulatedEntryPrice == null ? '—' : t.simulatedEntryPrice.toPrecision(4);
    const amount = t.simulatedEntryAmountSol == null ? '—' : `${t.simulatedEntryAmountSol.toFixed(3)} SOL`;
    const when = t.entryAt.toISOString().replace('T', ' ').slice(0, 16);

    if (t.status === 'open') {
      return `• ${short(t.tokenAddress)} | ${when} | wallet ${wallet} | entry ${entryPrice} (${amount}) | 🟡 open`;
    }
    const pnl = t.pnlPct == null ? '—' : formatPercent(t.pnlPct, true);
    return `• ${short(t.tokenAddress)} | ${when} | wallet ${wallet} | entry ${entryPrice} (${amount}) | ✅ ${t.exitReason ?? 'closed'} | pnl ${pnl}`;
  });

  return [`Τελευταία ${recent.length} trades (log_only):`, ...rows].join('\n');
}

async function persistScore(address: string, stats: WalletStats, deps: CommandDeps): Promise<void> {
  const score = {
    winRate: stats.winRate,
    // Το schema το λέει pnl_multiplier· η πηγή είναι `realized_profit_pnl`, δηλαδή ratio
    // (0.33 = +33%), όχι πολλαπλασιαστής. Βλ. walletStats.ts.
    pnlMultiplier: stats.realizedPnlRatio,
    // token_num, ΟΧΙ buy+sell — είναι ο παρονομαστής του winRate.
    tradeCount: stats.tokenCount,
  };
  await deps.updateWalletScore(address, score);
  await deps.insertScore({ walletAddress: address, ...score });
}

function formatStats(stats: WalletStats): string {
  return [
    `win rate: ${stats.winRate == null ? '—' : formatPercent(stats.winRate)}`,
    `θέσεις: ${stats.tokenCount ?? '—'}`,
    `realized PnL: ${stats.realizedPnlRatio == null ? '—' : formatPercent(stats.realizedPnlRatio, true)}`,
    `μέσο holding: ${formatDuration(stats.avgHoldingPeriodSec)}`,
  ].join(' | ');
}

/** Προτείνει review, ΔΕΝ απενεργοποιεί — ο χρήστης αποφασίζει για ό,τι πρόσθεσε ο ίδιος. */
function advisory(stats: WalletStats): string {
  const reasons: string[] = [];
  if (stats.winRate != null && stats.winRate < ADVISORY_WIN_RATE_FLOOR) {
    reasons.push(`win rate ${formatPercent(stats.winRate)} < ${formatPercent(ADVISORY_WIN_RATE_FLOOR)}`);
  }
  if (stats.tokenCount != null && stats.tokenCount < ADVISORY_TOKEN_COUNT_FLOOR) {
    reasons.push(`μόνο ${stats.tokenCount} θέσεις (< ${ADVISORY_TOKEN_COUNT_FLOOR}, μικρό δείγμα)`);
  }
  return reasons.length === 0 ? '' : `⚠️ Άξιο review: ${reasons.join(', ')}. Δεν απενεργοποιήθηκε.`;
}

function formatPercent(value: number, signed = false): string {
  const sign = signed && value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
