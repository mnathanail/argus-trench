import { listActiveWallets } from '../db/repositories/watchlistWallets.js';
import { HeliusLogsListener } from '../solana/heliusLogsListener.js';
import { getParsedTransactionWithRetry, heliusRpcUrl, heliusWsUrl, type ParsedTransaction } from '../solana/heliusRpc.js';
import { parseWalletTrade, PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } from '../mirror/heliusTrade.js';
import { PUMP_TOKEN_SUPPLY, type PumpPortalTradeEvent } from './pumpportalEvents.js';
import { isRealtimeSignalWallet } from './walletSubscriptionSync.js';

/**
 * 2026-10-07 (ρητή απόφαση χρήστη) — ΔΕΥΤΕΡΗ πηγή σημάτων για τη watchlist, μέσω Helius.
 *
 * wallet-buys-check: για δύο από τα καλύτερα wallets μας (HFXWWmQH, u1c81Pop) το PumpPortal
 * ΔΕΝ έστειλε 8/10 και 21/26 από τις αγορές τους (π.χ. CLAUDIA 11–12×), ενώ δέχεται κανονικά
 * όλες τις συνδρομές· μόνο το 7% των top_trader wallets έδωσε έστω ένα event σε 48h. Αγοράζουν
 * μέσω Axiom/Photon/Padre — το PumpPortal δεν τα βλέπει (ίδιο με τον chriskogias).
 *
 * Εδώ: logsSubscribe(mentions: wallet) → ΜΟΝΟ αν τα logs δείχνουν αγορά στο Pump.fun ή στο
 * PumpSwap (`isPumpBuyLog`, δωρεάν φιλτράρισμα — τα websocket δεν χρεώνονται στο free plan)
 * → getTransaction (1 credit/κλήση) → parseWalletTrade (υπόλοιπα, όποιο router κι αν
 * χρησιμοποιήθηκε) → τιμή pool ΜΕΤΑ το trade (`withPoolPrice`) → ίδιο handleRealtimeEntryEvent.
 *
 * Όριο credits (free plan 1M/μήνα): ημερήσιο `HELIUS_DAILY_CREDIT_BUDGET` (default 25.000) και
 * ανά wallet `HELIUS_WALLET_DAILY_FETCHES` (default 150) — μετά δεν γίνεται κανένα fetch ως τα
 * μεσάνυχτα UTC. Το PumpPortal μένει: ό,τι φτάσει πρώτο από τις δύο πηγές κερδίζει
 * (`SignatureDedupe`, κοινό με το PumpPortal entry path).
 */

export const PUMP_CURVE_VIRTUAL_SOL = 30;
/**
 * vTokens = token account της curve + 73M. Το token account της curve κρατάει ΟΛΟ το supply στη
 * δημιουργία (1B), όχι μόνο τα real reserves (793.1M) — τα 206.9M που μένουν πάνε στο pool στο
 * graduation. Άρα virtual = account − 206.9M + 279.9M = account + 73M (1.073B − 1B).
 * 2026-10-08: ήταν 279.9M → τιμή εισόδου 16–40% χαμηλότερη από την πραγματική για κάθε σήμα Helius
 * στη curve, ενώ τα ticks (decodeBondingCurve) έδιναν τη σωστή → ψεύτικο άλμα αμέσως μετά την είσοδο.
 */
export const PUMP_CURVE_VIRTUAL_TOKEN_OFFSET = 73_000_000;
const LAMPORTS = 1e9;

/** true όταν τα logs δείχνουν αγορά σε Pump.fun curve ή PumpSwap (ή είναι κομμένα και το πρόγραμμα υπάρχει). */
export function isPumpBuyLog(logs: readonly string[]): boolean {
  const pumpProgram = logs.some((l) => l.includes(PUMP_PROGRAM) || l.includes(PUMP_AMM_PROGRAM));
  if (!pumpProgram) return false;
  if (logs.some((l) => l.startsWith('Program log: Instruction: Buy'))) return true;
  return logs.some((l) => l.includes('Log truncated'));
}

/** Κοινό dedupe υπογραφών ανάμεσα σε PumpPortal και Helius για το entry path. */
export class SignatureDedupe {
  private readonly seen = new Set<string>();
  constructor(private readonly max = 20_000) {}
  has(signature: string): boolean {
    return this.seen.has(signature);
  }
  /** true = πρώτη φορά (προχώρα), false = το έχει ήδη επεξεργαστεί η άλλη πηγή. */
  claim(signature: string): boolean {
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    if (this.seen.size > this.max) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    return true;
  }
}

/** Ημερήσιο όριο κλήσεων getTransaction (= credits), συνολικά και ανά wallet. */
export class HeliusCreditBudget {
  private day = '';
  private used = 0;
  private readonly perWallet = new Map<string, number>();
  private exhaustedNotified = false;
  constructor(
    private readonly dailyLimit: number,
    private readonly perWalletLimit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private roll(): void {
    const d = this.now().toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
      this.perWallet.clear();
      this.exhaustedNotified = false;
    }
  }

  /** Καταναλώνει 1 credit αν επιτρέπεται. */
  tryConsume(wallet: string): boolean {
    this.roll();
    if (this.used >= this.dailyLimit) return false;
    const w = this.perWallet.get(wallet) ?? 0;
    if (w >= this.perWalletLimit) return false;
    this.used += 1;
    this.perWallet.set(wallet, w + 1);
    return true;
  }

  /** true ΜΙΑ φορά τη μέρα, όταν τελειώσει το συνολικό όριο (για Telegram). */
  shouldNotifyExhausted(): boolean {
    this.roll();
    if (this.used < this.dailyLimit || this.exhaustedNotified) return false;
    this.exhaustedNotified = true;
    return true;
  }

  usage(): { day: string; used: number; limit: number; walletsAtCap: number } {
    this.roll();
    let atCap = 0;
    for (const n of this.perWallet.values()) if (n >= this.perWalletLimit) atCap += 1;
    return { day: this.day, used: this.used, limit: this.dailyLimit, walletsAtCap: atCap };
  }
}

function uiAmount(b: { uiTokenAmount: { amount: string; decimals: number } }): number {
  return Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;
}

/**
 * Τιμή του pool ΜΕΤΑ το trade, από τα υπόλοιπα της ίδιας συναλλαγής — ίδια σημασία με αυτό
 * που στέλνει το PumpPortal (vSol/vTokens στη curve, marketCapSol στο PumpSwap), ώστε το entry
 * path (on-demand gate μόνο σε curve tokens, priceFromTradeEvent) να δουλεύει ίδια.
 *  - curve: αντισυμβαλλόμενος = ο owner του token account του mint που έδωσε τα περισσότερα
 *    tokens (bonding curve)· vTokens = token account + 73M, vSol = lamports/1e9 + 30.
 *  - PumpSwap: ίδιος owner (pool)· τιμή = wSOL του pool / tokens του pool.
 * Αν δεν βρεθεί ή βγει παράλογη (εκτός 0.7×–2× της μέσης τιμής του trade), χρησιμοποιείται η
 * μέση τιμή (`price_fallback`).
 */
export function withPoolPrice(
  tx: ParsedTransaction,
  event: PumpPortalTradeEvent,
): { event: PumpPortalTradeEvent; priceFallback: boolean; nonSolQuote?: boolean } {
  const avg = event.tokenAmount > 0 ? event.solAmount / event.tokenAmount : null;
  const meta = tx.meta;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  let owner: string | null = null;
  let ownerPostTokens = 0;
  if (meta !== null && avg !== null) {
    let best = 0;
    for (const post of meta.postTokenBalances ?? []) {
      if (post.mint !== event.mint || post.owner === undefined || post.owner === event.traderPublicKey) continue;
      const pre = (meta.preTokenBalances ?? []).find((p) => p.accountIndex === post.accountIndex);
      const delta = (pre === undefined ? 0 : uiAmount(pre)) - uiAmount(post); // αγορά: το pool έδωσε tokens
      if (delta > best) {
        best = delta;
        owner = post.owner;
        ownerPostTokens = uiAmount(post);
      }
    }
  }
  let lastSpot: number | null = null;
  const sane = (spot: number): boolean => {
    lastSpot = spot;
    return avg !== null && spot >= avg * 0.7 && spot <= avg * 2;
  };

  if (event.pool === 'pump' && owner !== null && meta !== null) {
    const idx = keys.indexOf(owner);
    // 2026-10-08: νέες curves του Pump.fun (Token-2022) με quote ΑΛΛΟ από SOL — η curve δεν παίρνει
    // lamports στην αγορά (π.χ. HQbAXd3b: curve 0.001 SOL, realSol 0.957). Όλες οι τιμές μας είναι σε
    // SOL, άρα αυτά δεν τα αγγίζουμε (έδιναν κορυφές 7–9k SOL mcap σε tokens με ATH ~$10–50k).
    if (idx >= 0) {
      const gained = ((meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0)) / LAMPORTS;
      if (gained < event.solAmount * 0.5) return { event, priceFallback: false, nonSolQuote: true };
    }
    if (idx >= 0) {
      const vSol = (meta.postBalances[idx] ?? 0) / LAMPORTS + PUMP_CURVE_VIRTUAL_SOL;
      const vTokens = ownerPostTokens + PUMP_CURVE_VIRTUAL_TOKEN_OFFSET;
      const spot = vSol / vTokens;
      if (sane(spot)) {
        return {
          event: { ...event, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens, marketCapSol: spot * PUMP_TOKEN_SUPPLY, bondingCurve: owner },
          priceFallback: false,
        };
      }
    }
  }
  if (event.pool === 'pump-amm' && owner !== null && meta !== null) {
    const quote = (meta.postTokenBalances ?? []).find((b) => b.mint === WSOL_MINT && b.owner === owner);
    if (quote === undefined) return { event, priceFallback: false, nonSolQuote: true }; // pool χωρίς wSOL = άλλο quote
    if (quote !== undefined && ownerPostTokens > 0) {
      const spot = uiAmount(quote) / ownerPostTokens;
      if (sane(spot)) return { event: { ...event, marketCapSol: spot * PUMP_TOKEN_SUPPLY }, priceFallback: false };
    }
  }
  if (avg === null) return { event, priceFallback: true };
  // 2026-10-07: ~40% των σημάτων έπεφταν εδώ την πρώτη μέρα — καταγραφή για διάγνωση.
  logPriceFallback(event, owner, lastSpot, avg);
  if (event.pool === 'pump') {
    return {
      event: {
        ...event,
        vSolInBondingCurve: avg * PUMP_TOKEN_SUPPLY,
        vTokensInBondingCurve: PUMP_TOKEN_SUPPLY,
        marketCapSol: avg * PUMP_TOKEN_SUPPLY,
        ...(owner !== null ? { bondingCurve: owner } : {}),
      },
      priceFallback: true,
    };
  }
  return { event: { ...event, marketCapSol: avg * PUMP_TOKEN_SUPPLY }, priceFallback: true };
}

let priceFallbackLogs = 0;
const PRICE_FALLBACK_LOG_LIMIT = 30;
function logPriceFallback(event: PumpPortalTradeEvent, owner: string | null, spot: number | null, avg: number): void {
  if (priceFallbackLogs >= PRICE_FALLBACK_LOG_LIMIT) return;
  priceFallbackLogs += 1;
  console.log(
    `[helius-signal] price_fallback ${event.signature.slice(0, 10)} mint=${event.mint.slice(0, 8)} pool=${event.pool} ` +
      `owner=${owner === null ? '—' : owner.slice(0, 8)} spot/avg=${spot === null ? '—' : (spot / avg).toFixed(3)} ` +
      `sol=${event.solAmount.toFixed(4)} tokens=${event.tokenAmount.toFixed(0)}`,
  );
}

export type HeliusSignalOutcome =
  | 'not_found'
  | 'not_a_trade'
  | 'not_a_buy'
  | 'other_program'
  | 'duplicate'
  | 'emitted'
  | 'emitted_price_fallback'
  | 'non_sol_quote';

export interface HeliusSignalDeps {
  fetchTx: (wallet: string, signature: string) => Promise<ParsedTransaction | null>;
  dedupe: SignatureDedupe;
  onEvent: (event: PumpPortalTradeEvent) => void;
  nowMs: () => number;
}

/** Μία υπογραφή που πέρασε το φίλτρο logs → (ίσως) ένα σήμα αγοράς. Εξαγόμενο για tests. */
export async function processHeliusSignal(wallet: string, signature: string, deps: HeliusSignalDeps): Promise<HeliusSignalOutcome> {
  if (deps.dedupe.has(signature)) return 'duplicate';
  const tx = await deps.fetchTx(wallet, signature);
  if (tx === null) return 'not_found';
  const parsed = parseWalletTrade(tx, wallet);
  if (!parsed.ok) return 'not_a_trade';
  if (parsed.event.txType !== 'buy') return 'not_a_buy';
  if (parsed.program === 'other') return 'other_program';
  const { event, priceFallback, nonSolQuote } = withPoolPrice(tx, parsed.event);
  if (nonSolQuote === true) return 'non_sol_quote';
  const lagSec = parsed.blockTime === null ? null : Math.round((deps.nowMs() / 1000 - parsed.blockTime) * 10) / 10;
  // ΔΙΟΡΘΩΣΗ 2026-10-07: εδώ μόνο έλεγχος — το claim το κάνει το entry path (runEntryForSignal).
  // Πριν το κάναμε ΚΑΙ εδώ, οπότε το entry path έβρισκε την υπογραφή «ήδη επεξεργασμένη» και
  // πετούσε ΚΑΘΕ σήμα του Helius (946 σήματα, 0 trades / 0 skips την πρώτη μέρα).
  if (deps.dedupe.has(signature)) return 'duplicate';
  deps.onEvent({ ...event, signalSource: 'helius', signalLagSec: lagSec });
  return priceFallback ? 'emitted_price_fallback' : 'emitted';
}

export interface HeliusSignalSourceOptions {
  apiKey: string;
  dedupe: SignatureDedupe;
  onEvent: (event: PumpPortalTradeEvent) => void;
  onBudgetExhausted: (usage: ReturnType<HeliusCreditBudget['usage']>) => void;
  dailyCreditBudget: number;
  walletDailyFetches: number;
}

export interface HeliusSignalSource {
  close: () => void;
  stats: () => Record<string, number> & { walletsSubscribed: number };
}

const WALLET_REFRESH_MS = 60_000;
const STATS_LOG_MS = 60 * 60_000;

async function signalWallets(): Promise<string[]> {
  const active = await listActiveWallets();
  return active.filter((w) => w.copyMode === 'signal' && isRealtimeSignalWallet(w)).map((w) => w.address);
}

export async function startHeliusSignalSource(options: HeliusSignalSourceOptions): Promise<HeliusSignalSource> {
  const rpcUrl = heliusRpcUrl(options.apiKey);
  const budget = new HeliusCreditBudget(options.dailyCreditBudget, options.walletDailyFetches);
  const counts: Record<string, number> = { notifications: 0, filtered_out: 0 };
  const bump = (k: string): void => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  const deps: HeliusSignalDeps = {
    fetchTx: (wallet, sig) =>
      getParsedTransactionWithRetry(rpcUrl, sig, [400, 800, 1_500, 3_000], undefined, () => {
        if (budget.tryConsume(wallet)) return true;
        bump('budget_blocked_calls');
        if (budget.shouldNotifyExhausted()) options.onBudgetExhausted(budget.usage());
        return false;
      }),
    dedupe: options.dedupe,
    onEvent: options.onEvent,
    nowMs: () => Date.now(),
  };
  const listener = new HeliusLogsListener({
    wsUrl: heliusWsUrl(options.apiKey),
    log: (line) => console.log(line.replace('[helius]', '[helius-signal]')),
    onSignature: (wallet, signature, _receivedAt, logs) => {
      bump('notifications');
      if (!isPumpBuyLog(logs)) {
        bump('filtered_out');
        return;
      }
      processHeliusSignal(wallet, signature, deps)
        .then((outcome) => bump(outcome))
        .catch((error) => {
          bump('errors');
          console.error(`[helius-signal] ${signature.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
        });
    },
  });
  listener.setWallets(await signalWallets());
  listener.connect();
  const refresh = setInterval(() => {
    signalWallets()
      .then((wallets) => listener.setWallets(wallets))
      .catch((error) => console.error(`[helius-signal] refresh wallets: ${error instanceof Error ? error.message : String(error)}`));
  }, WALLET_REFRESH_MS);
  refresh.unref();
  const statsLog = setInterval(() => {
    const u = budget.usage();
    console.log(
      `[helius-signal] ${u.day} credits ${u.used}/${u.limit} wallets_στο_όριο=${u.walletsAtCap} ` +
        `subscribed=${listener.activeSubscriptions} counts=${JSON.stringify(counts)}`,
    );
  }, STATS_LOG_MS);
  statsLog.unref();
  return {
    close: () => {
      clearInterval(refresh);
      clearInterval(statsLog);
      listener.close();
    },
    stats: () => ({ ...counts, creditsUsedToday: budget.usage().used, walletsSubscribed: listener.activeSubscriptions }),
  };
}
