import { runCli, type RunOptions } from './exec.js';
import { expectArray, expectObject, expectString, toNumber } from './validate.js';

/**
 * Νέο, ΑΝΕΞΑΡΤΗΤΟ path από `holders.ts` — εκείνο καλύπτει `token holders --tag <ένα tag>`
 * (weight 5, φιλτραρισμένο server-side σε ΕΝΑ tag). Το check εδώ (proposal #5 — βλ.
 * gmgn-holder-analysis skill) χρειάζεται το ΑΝΤΙΘΕΤΟ σχήμα: ΧΩΡΙΣ `--tag`, top-100
 * holders, με ΟΛΑ τα raw πεδία (`addr_type`, `amount_percentage`, `maker_token_tags`) ώστε
 * να υπολογιστεί το float_share και να χαρτογραφηθούν τα risk tags πάνω σε κάθε holder.
 * Ίδιο route (`token holders`, weight 5) αλλά διαφορετική κλήση/σχήμα response ⇒ ξεχωριστό
 * function, όχι επέκταση του `fetchTokenHolders` με optional tag (θα σήμαινε δύο ασύνδετα
 * return type πίσω από την ίδια υπογραφή).
 *
 * Μεταφέρει ΜΟΝΟ το κομμάτι risk-wallet-percentage του Python script
 * (`.agents/skills/gmgn-holder-analysis/analyze.py`, γραμμές ~104-192) — ΟΧΙ ολόκληρο το
 * rating cascade (dev holding, airdrop %, linked-funding coherence). Ρητή επιλογή χρήστη
 * 2026-09-20: "Νέο, απλό TypeScript check μόνο με τα νούμερα που χρειαζόμαστε".
 *
 * ΔΕΝ είναι ακόμα συνδεδεμένο σε κανένα collector loop. Πριν μπει στο `gmgnSmartMoney.ts`
 * ως pre-entry filter (ή έστω ως καταγραφή πλάι στο σήμα, όπως το `is_open_or_close`),
 * χρειάζεται ρητή απόφαση χρήστη: ένα `token holders` call εδώ είναι weight 5 ΑΝΑ σήμα —
 * πολύ πιο ακριβό από το weight-1-ΣΥΝΟΛΙΚΑ-ανά-κύκλο σχεδιασμό του ίδιου του
 * gmgn_smartmoney καναλιού (βλ. CLAUDE.md, "Verified CLI contract" → weights).
 */

const RISK_TAGS = ['bundler', 'rat_trader', 'sniper'] as const;

/** `float_share` κάτω από αυτό ⇒ η ανάλυση θεωρείται αναξιόπιστη (division-by-near-zero
 * noise) — ίδιο κατώφλι/σκεπτικό με το Python `FLOAT_MIN` (βλ. πάνω σχόλιο του αρχείου
 * πηγής: ένα dust wallet υπολογίστηκε λανθασμένα ως "100% του float"). */
export const FLOAT_MIN = 0.02;

export type HolderAddrType = 0 | 1 | 2; // 0=normal wallet, 1=burn/dead, 2=DEX/pool

export interface RawTokenHolder {
  address: string;
  addrType: HolderAddrType;
  amountPercentage: number; // κλάσμα 0..1, ΟΧΙ ήδη ×100
  makerTokenTags: readonly string[];
}

export interface FetchAllTokenHoldersOptions extends RunOptions {
  tokenAddress: string;
  chain?: string;
  limit?: number;
}

/** `token holders --chain <chain> --address <addr> --limit <n>`, ΧΩΡΙΣ `--tag` — full,
 * untagged top-N holders. Weight 5, ίδιο με το tagged call. */
export function buildAllHoldersArgs(options: FetchAllTokenHoldersOptions): string[] {
  const args = [
    'token',
    'holders',
    '--chain',
    options.chain ?? 'sol',
    '--address',
    options.tokenAddress,
    '--limit',
    String(options.limit ?? 100),
  ];
  return args;
}

export async function fetchAllTokenHolders(
  options: FetchAllTokenHoldersOptions,
): Promise<RawTokenHolder[]> {
  const raw = await runCli('token holders', buildAllHoldersArgs(options), options);
  return parseAllHoldersResponse(raw);
}

export function parseAllHoldersResponse(raw: unknown): RawTokenHolder[] {
  const root = expectObject(raw, 'response');
  const list = expectArray(root['list'] ?? [], 'list');
  return list.map((item, index) => parseRawHolder(item, `list[${index}]`));
}

function parseRawHolder(item: unknown, path: string): RawTokenHolder {
  const row = expectObject(item, path);
  const addrTypeRaw = row['addr_type'];
  const addrType: HolderAddrType =
    addrTypeRaw === 1 || addrTypeRaw === 2 ? addrTypeRaw : 0; // default 0, ίδιο με Python `h.get('addr_type', 0)`
  const makerTokenTags = Array.isArray(row['maker_token_tags'])
    ? row['maker_token_tags'].filter((t): t is string => typeof t === 'string')
    : [];
  return {
    address: expectString(row['address'], `${path}.address`),
    addrType,
    amountPercentage: toNumber(row['amount_percentage'] ?? 0, `${path}.amount_percentage`),
    makerTokenTags,
  };
}

export interface FloatShareResult {
  /** `1 - burn_pct - dex_pct`, ΠΡΙΝ το floor στο 1e-9 — χρησιμοποιείται για το
   * degenerate-check, όχι για διαιρέσεις. */
  floatRaw: number;
  /** `max(floatRaw, 1e-9)` — ΜΟΝΟ αυτό χρησιμοποιείται ως παρονομαστής. */
  floatShare: number;
  burnPct: number;
  dexPct: number;
}

/** Ακριβής μεταφορά του Python `float_raw`/`float_share` (γραμμές 118-127). Τα
 * `burn`/`dex` holders (addr_type 1/2) ΔΕΝ μπαίνουν στο risk-check — ορίζουν μόνο το
 * flotsam που αφαιρείται από τον παρονομαστή. */
export function computeFloatShare(holders: readonly RawTokenHolder[]): FloatShareResult {
  const burnPct = sumPct(holders.filter((h) => h.addrType === 1));
  const dexPct = sumPct(holders.filter((h) => h.addrType === 2));
  const floatRaw = 1.0 - burnPct - dexPct;
  const floatShare = Math.max(floatRaw, 1e-9);
  return { floatRaw, floatShare, burnPct, dexPct };
}

/** `float_raw < FLOAT_MIN` Ή δεν υπάρχουν καθόλου normal (addr_type=0) holders — και στις
 * δύο περιπτώσεις κάθε `/ floatShare` θα παρήγαγε αριθμό χωρίς νόημα (βλ. σχόλιο Python
 * πηγής). Το caller πρέπει να αγνοήσει το `riskPct` όταν αυτό είναι true, όχι απλά να το
 * εμφανίσει ως 0% ή 100% — ένα "δεν αξιολογείται" είναι διαφορετικό από "καθαρό". */
export function isFloatDegenerate(
  float: Pick<FloatShareResult, 'floatRaw'>,
  normalHolderCount: number,
): boolean {
  return float.floatRaw < FLOAT_MIN || normalHolderCount === 0;
}

export interface RiskWalletResult {
  /** Deduped ποσοστό (επί του float_share, ΟΧΙ επί της συνολικής προσφοράς) που κρατούν
   * wallets με ΕΣΤΩ ΕΝΑ από τα risk tags. `null` όταν `isFloatDegenerate` — δεν πρέπει να
   * ερμηνευτεί ως 0. */
  riskPct: number | null;
  /** Πόσα ΜΟΝΑΔΙΚΑ (deduped) wallets συνεισφέρουν στο riskPct. */
  riskWalletCount: number;
  /** Άθροισμα ανά κατηγορία πριν το dedup — ένα wallet με 2 tags μετράει 2 φορές εδώ,
   * γι' αυτό `riskWalletCount <= bundlerCount + ratTraderCount + sniperCount`. */
  bundlerCount: number;
  ratTraderCount: number;
  sniperCount: number;
}

/**
 * Ακριβής μεταφορά του Python `risk_all`/`risk_pct` (γραμμές 168-186), ΜΟΝΟ το risk-tag
 * κομμάτι (bundler/rat_trader/sniper) — ΧΩΡΙΣ fresh_wallet/wash_trader (αυτά στο Python
 * μπαίνουν στα `RISK_GROUPS` για εμφάνιση αλλά δεν αλλάζουν τη ratedecision εδώ, εκτός
 * σκοπού κατά ρητή επιλογή χρήστη). Μόνο `addr_type === 0` (normal) holders συμμετέχουν —
 * DEX/burn αποκλείονται ήδη επειδή δεν έχουν νόημα ως "risk wallet".
 */
export function computeRiskWalletPct(
  holders: readonly RawTokenHolder[],
  float: FloatShareResult,
): RiskWalletResult {
  const normal = holders.filter((h) => h.addrType === 0);
  const bundlers = normal.filter((h) => h.makerTokenTags.includes('bundler'));
  const ratTraders = normal.filter((h) => h.makerTokenTags.includes('rat_trader'));
  const snipers = normal.filter((h) => h.makerTokenTags.includes('sniper'));

  const riskAddresses = new Set<string>([
    ...bundlers.map((h) => h.address),
    ...ratTraders.map((h) => h.address),
    ...snipers.map((h) => h.address),
  ]);
  const riskHolders = normal.filter((h) => riskAddresses.has(h.address));

  const degenerate = isFloatDegenerate(float, normal.length);
  const riskPct = degenerate ? null : sumPct(riskHolders) / float.floatShare;

  return {
    riskPct,
    riskWalletCount: riskAddresses.size,
    bundlerCount: bundlers.length,
    ratTraderCount: ratTraders.length,
    sniperCount: snipers.length,
  };
}

export const RISK_TAG_LIST = RISK_TAGS;

function sumPct(holders: readonly RawTokenHolder[]): number {
  return holders.reduce((sum, h) => sum + h.amountPercentage, 0);
}
