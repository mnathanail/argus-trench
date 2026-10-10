/**
 * 2026-10-09 (ρητή απόφαση χρήστη) — «έξυπνη» βαθμολογία wallets με ΔΙΚΑ ΜΑΣ αποτελέσματα αντιγραφής.
 *
 *  1. Bayesian εκτίμηση της απόδοσης ανά trade: κάθε wallet ξεκινά από ένα σκεπτικό prior (μέσος 0,
 *     ισχύς PRIOR_STRENGTH «ψεύτικα» trades) και πλησιάζει τα δικά του αποτελέσματα όσο μαζεύει trades.
 *     → μέσος (mean), αβεβαιότητα (sd), κάτω όριο 80% (lcb), άνω όριο 90% (ucb).
 *  2. Thompson sampling στο live: σε κάθε σήμα ένα τυχαίο δείγμα ~ N(mean, sd)· live αν > 0. Τα σίγουρα
 *     καλά wallets περνούν σχεδόν πάντα, τα αβέβαια παίρνουν που και που ευκαιρία, τα κακά σταματούν.
 *  3. Χρονική απόσβεση: κάθε trade χάνει το μισό βάρος του κάθε HALF_LIFE_DAYS.
 *  4. Copyability: τα paper αποτελέσματα «φορτώνονται» με το κόστος της πραγματικής εισόδου μας
 *     (slippage έναντι σήματος, από τα live trades όταν υπάρχουν — αλλιώς DEFAULT_SLIPPAGE). Τα live
 *     trades μετράνε ως έχουν (είναι ήδη πραγματικά).
 *
 * Μόνο καθαρά δεδομένα (από CLEAN_SINCE — μετά τις διορθώσεις τιμής του Helius), χωρίς πείραμα.
 */

export const CLEAN_SINCE = new Date('2026-10-08T12:30:00Z');
export const HALF_LIFE_DAYS = 2.5;
export const PRIOR_STRENGTH = 8;
export const PRIOR_MEAN = 0;
/** Οι αποδόσεις κόβονται εδώ για την εκτίμηση: ένα 50× δεν πρέπει να κάνει μόνο του ένα wallet «σίγουρο». */
export const RET_MIN = -1;
export const RET_MAX = 2;
/** Κάτω όριο για την τυπική απόκλιση ΜΙΑΣ απόδοσης: στα memecoins ένα trade πάει από −40% ως +200%. */
export const MIN_SD = 0.5;
export const Z_LCB = 0.84; // 80% μονόπλευρο
export const Z_BLOCK = 1.28; // 90% σίγουροι ότι είναι αρνητικό
/** Πόσο (σταθμισμένο) δείγμα χρειάζεται πριν ένα wallet μπλοκαριστεί. */
export const BLOCK_MIN_WEIGHT = 12;
/** Κάτω από τόσα κλειστά trades: καθόλου live (μόνο paper μέχρι να υπάρχει κάποια εικόνα). */
export const MIN_TRADES_FOR_LIVE = 3;
/** «proven» θέλει τουλάχιστον τόσα trades — ένα τυχερό trade δεν αρκεί, όσο μεγάλο κι αν είναι. */
export const MIN_TRADES_FOR_PROVEN = 5;
/** Υποθετικό extra κόστος εισόδου live vs σήμα, όσο δεν έχουμε αρκετά live trades. */
export const DEFAULT_SLIPPAGE = 0.05;
export const MIN_LIVE_FOR_GLOBAL_SLIP = 5;
export const MIN_LIVE_FOR_WALLET_SLIP = 3;

export interface ScoringTrade {
  wallet: string;
  /** pnl_net_pct (0.25 = +25%, μετά τα fees). */
  netRet: number;
  closedAt: Date;
  mode: string;
  /** Μόνο live: εκτελεσμένη τιμή / τιμή σήματος − 1. */
  liveSlippage: number | null;
  /** 2026-10-10: paper που άνοιξε στην τωρινή τιμή καμπύλης (ρεαλιστικό) — όχι επιπλέον κόστος εισόδου. */
  realisticEntry?: boolean;
}

export type WalletScoreStatus = 'proven' | 'exploring' | 'blocked';

export interface WalletScore {
  wallet: string;
  trades: number;
  wins: number;
  /** Άθροισμα βαρών απόσβεσης (≈ «ενεργά» trades). */
  weight: number;
  /** Άθροισμα κερδών σε SOL για 0.05 SOL/θέση (χωρίς απόσβεση — για ανάγνωση). */
  pnlSol: number;
  mean: number;
  sd: number;
  lcb: number;
  ucb: number;
  slippage: number;
  status: WalletScoreStatus;
  reason: string;
  lastTradeAt: Date | null;
}

const clip = (x: number): number => Math.min(RET_MAX, Math.max(RET_MIN, x));
const decay = (closedAt: Date, now: Date): number => Math.pow(0.5, (now.getTime() - closedAt.getTime()) / 86_400_000 / HALF_LIFE_DAYS);
const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Slippage που υποθέτουμε για τα paper trades ενός wallet. */
export function slippageFor(walletLive: readonly number[], globalLive: readonly number[]): number {
  if (walletLive.length >= MIN_LIVE_FOR_WALLET_SLIP) return Math.max(0, mean(walletLive)!);
  if (globalLive.length >= MIN_LIVE_FOR_GLOBAL_SLIP) return Math.max(0, mean(globalLive)!);
  return DEFAULT_SLIPPAGE;
}

/** Απόδοση όπως θα ήταν σε live: paper → με το κόστος εισόδου, live → ως έχει. */
export function adjustedReturn(t: ScoringTrade, slippage: number): number {
  return t.mode === 'live' || t.realisticEntry === true ? t.netRet : (1 + t.netRet) / (1 + slippage) - 1;
}

export function computeWalletScores(trades: readonly ScoringTrade[], now: Date = new Date()): WalletScore[] {
  const clean = trades.filter((t) => t.closedAt >= CLEAN_SINCE && Number.isFinite(t.netRet));
  const globalLive = clean.filter((t) => t.mode === 'live' && t.liveSlippage !== null).map((t) => t.liveSlippage!);
  const byWallet = new Map<string, ScoringTrade[]>();
  for (const t of clean) byWallet.set(t.wallet, [...(byWallet.get(t.wallet) ?? []), t]);

  // Διασπορά μίας απόδοσης (κοινή για όλους): σταθμισμένη, από όλα τα trades.
  const slipOf = new Map<string, number>();
  for (const [w, ts] of byWallet) {
    slipOf.set(w, slippageFor(ts.filter((t) => t.mode === 'live' && t.liveSlippage !== null).map((t) => t.liveSlippage!), globalLive));
  }
  let sw = 0;
  let swx = 0;
  let swx2 = 0;
  for (const t of clean) {
    const w = decay(t.closedAt, now);
    const x = clip(adjustedReturn(t, slipOf.get(t.wallet)!));
    sw += w;
    swx += w * x;
    swx2 += w * x * x;
  }
  const pooledVar = sw > 0 ? swx2 / sw - (swx / sw) ** 2 : MIN_SD ** 2;
  const sigma = Math.max(MIN_SD, Math.sqrt(Math.max(0, pooledVar)));

  const out: WalletScore[] = [];
  for (const [wallet, ts] of byWallet) {
    const slippage = slipOf.get(wallet)!;
    let weight = 0;
    let weighted = 0;
    for (const t of ts) {
      const w = decay(t.closedAt, now);
      weight += w;
      weighted += w * clip(adjustedReturn(t, slippage));
    }
    const m = (PRIOR_STRENGTH * PRIOR_MEAN + weighted) / (PRIOR_STRENGTH + weight);
    const sd = sigma / Math.sqrt(PRIOR_STRENGTH + weight);
    const lcb = m - Z_LCB * sd;
    const ucb = m + Z_BLOCK * sd;
    let status: WalletScoreStatus = 'exploring';
    let reason = `μέσος ${(m * 100).toFixed(1)}%/trade, κάτω όριο ${(lcb * 100).toFixed(1)}%`;
    if (weight >= BLOCK_MIN_WEIGHT && ucb < 0) {
      status = 'blocked';
      reason = `90% σίγουρα αρνητικό: άνω όριο ${(ucb * 100).toFixed(1)}%/trade σε ${ts.length} trades`;
    } else if (lcb > 0 && ts.length >= MIN_TRADES_FOR_PROVEN) {
      status = 'proven';
    }
    out.push({
      wallet,
      trades: ts.length,
      wins: ts.filter((t) => t.netRet > 0).length,
      weight,
      pnlSol: ts.reduce((a, t) => a + t.netRet * 0.05, 0),
      mean: m,
      sd,
      lcb,
      ucb,
      slippage,
      status,
      reason,
      lastTradeAt: ts.reduce<Date | null>((a, t) => (a === null || t.closedAt > a ? t.closedAt : a), null),
    });
  }
  return out.sort((a, b) => b.mean - a.mean);
}

/** Τυπική κανονική (Box–Muller) με εξωτερικό rng για tests. */
export function standardNormal(rng: () => number = Math.random): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface LiveDecision {
  allowed: boolean;
  sample: number | null;
  reason: 'no_score' | 'too_few_trades' | 'blocked' | 'sample_positive' | 'sample_negative';
}

/** Thompson sampling: live αν ένα δείγμα από την εκτίμηση του wallet είναι θετικό. */
export function thompsonLive(
  score: Pick<WalletScore, 'mean' | 'sd' | 'status' | 'trades'> | null,
  rng: () => number = Math.random,
): LiveDecision {
  if (score === null) return { allowed: false, sample: null, reason: 'no_score' };
  if (score.status === 'blocked') return { allowed: false, sample: null, reason: 'blocked' };
  if (score.trades < MIN_TRADES_FOR_LIVE) return { allowed: false, sample: null, reason: 'too_few_trades' };
  const sample = score.mean + score.sd * standardNormal(rng);
  return sample > 0 ? { allowed: true, sample, reason: 'sample_positive' } : { allowed: false, sample, reason: 'sample_negative' };
}

/** 2026-10-09: true = το Thompson sampling αποφασίζει ποια σήματα πάνε live. false = όπως πριν. */
export const WALLET_SCORE_LIVE_GATE = true;

/**
 * 2026-10-09 (ρητή απόφαση χρήστη) — όριο mcap εισόδου για ΜΗ proven wallets.
 * Καθαρά δεδομένα (311 on-demand trades): μη proven wallets κάτω από 40 SOL → 45 trades, 0 stops,
 * +8.2%/trade · 40–50 → +1.5%, 55% stops · 50+ → −7.2%/trade, −0.65 SOL σε 179 trades.
 * Τα proven κερδίζουν και πιο ψηλά (50+: +37.8%/trade), οπότε δεν κόβονται. Ο λόγος: μια καμπύλη
 * Pump.fun ξεκινά στα ~28 SOL και δεν πέφτει κάτω από εκεί — όσο πιο νωρίς μπαίνεις, τόσο μικρότερη
 * η χειρότερη ζημιά (κάτω από ~40 SOL το −30% stop δεν μπορεί καν να πιαστεί).
 * Πάνω από το όριο η είσοδος γίνεται paper (συνεχίζουμε να μετράμε), όχι skip.
 */
export const MAX_UNPROVEN_ENTRY_MCAP_SOL = 40;

/** true = το mcap εισόδου επιτρέπει live για ένα wallet με αυτή την κατάσταση. */
export function entryMcapAllowsLive(status: WalletScoreStatus | string | null | undefined, entryMcapSol: number): boolean {
  if (status === 'proven') return true;
  return Number.isFinite(entryMcapSol) && entryMcapSol < MAX_UNPROVEN_ENTRY_MCAP_SOL;
}
