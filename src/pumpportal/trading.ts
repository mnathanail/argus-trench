import { delay } from '../util/delay.js';

/**
 * PumpPortal Lightning Trading API — ΞΕΧΩΡΙΣΤΟ από το websocket data feed
 * (src/realtime/pumpportalConnection.ts). Ίδια εταιρεία, ίδιο domain, εντελώς
 * διαφορετική ανησυχία: εδώ μιλάμε για HTTP POST κλήσεις που στέλνουν πραγματικά χρήματα,
 * όχι WebSocket subscriptions για δεδομένα.
 *
 * ΓΙΑΤΙ Lightning ΚΑΙ ΟΧΙ Local API: το Local API απαιτεί να υπογράφουμε ΕΜΕΙΣ με
 * πραγματικό Solana private key — αλλά το δικό μας GMGN_PRIVATE_KEY είναι ΜΟΝΟ για
 * υπογραφή αιτημάτων προς το GMGN API, ΟΧΙ το πραγματικό κλειδί του on-chain wallet. Το
 * Lightning API (PumpPortal δημιουργεί ΚΑΙ κρατάει το δικό του wallet για εμάς) είναι
 * πιο άμεσα συγκρίσιμο με το ήδη υπάρχον μοντέλο εμπιστοσύνης που έχουμε με το GMGN.
 *
 * ΚΡΙΣΙΜΟ, επιβεβαιωμένο πραγματικό incident 2026-09-14: οι ΠΡΩΤΕΣ δύο πραγματικές
 * δοκιμές (buy + sell) ΑΠΕΤΥΧΑΝ στο chain (status: Failed στο Solscan) — αλλά το
 * PumpPortal's `/api/trade` είχε ήδη επιστρέψει ένα κανονικό `{signature}`, που ο
 * παλιός κώδικας εδώ το θεωρούσε λανθασμένα "επιτυχία". Ένα signature σημαίνει ΜΟΝΟ
 * "υποβλήθηκε στο δίκτυο", ΟΧΙ "πέτυχε" — ΑΚΡΙΒΩΣ το ίδιο μάθημα που το επίσημο GMGN
 * SKILL.md προειδοποιούσε ρητά ("no longer submit = report success"), απλά δεν είχε
 * εφαρμοστεί εδώ. Τώρα κάνουμε ρητό confirmation polling μέσω Solana RPC
 * (`getSignatureStatuses`) πριν αναφέρουμε οτιδήποτε ως πραγματική επιτυχία.
 */

const BASE_URL = 'https://pumpportal.fun/api';
const TRADE_FEE_PCT = 0.005; // 0.5% — ρητά αναφερόμενο σε όλες τις πηγές τεκμηρίωσης

/** Δημόσιο, default Solana RPC — αναξιόπιστο/rate-limited για βαριά χρήση, αλλά αρκετό
 * για το ρητό confirmation polling εδώ. Override με SOLANA_RPC_URL αν χρειαστεί ποτέ
 * πιο αξιόπιστο πάροχο (π.χ. Helius) — ξεχωριστή, μελλοντική βελτίωση. */
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

const CONFIRM_POLL_ATTEMPTS = 15;
const CONFIRM_POLL_INTERVAL_MS = 2_000;

export interface PumpPortalWallet {
  apiKey: string;
  walletPublicKey: string;
  privateKey: string;
}

export class PumpPortalTradeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'PumpPortalTradeError';
  }
}

/** Η on-chain συναλλαγή ρητά ΑΠΕΤΥΧΕ (err !== null στο getSignatureStatuses) — ο caller
 * ΔΕΝ πρέπει να θεωρήσει ότι έγινε το trade. */
export class PumpPortalTradeFailedError extends Error {
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message);
    this.name = 'PumpPortalTradeFailedError';
  }
}

/**
 * ΜΙΑ φορά, χειροκίνητα — δημιουργεί ΝΕΟ wallet+apiKey. ΔΕΝ το καλούμε ποτέ αυτόματα.
 */
export async function createPumpPortalWallet(): Promise<PumpPortalWallet> {
  const response = await fetch(`${BASE_URL}/create-wallet`, { method: 'POST' });
  const text = await response.text();
  if (!response.ok) {
    throw new PumpPortalTradeError(`create-wallet failed: HTTP ${response.status}`, response.status, text);
  }
  const parsed: unknown = JSON.parse(text);
  const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (
    typeof obj['apiKey'] !== 'string' ||
    typeof obj['walletPublicKey'] !== 'string' ||
    typeof obj['privateKey'] !== 'string'
  ) {
    throw new PumpPortalTradeError('create-wallet: unexpected response shape', response.status, text);
  }
  return { apiKey: obj['apiKey'], walletPublicKey: obj['walletPublicKey'], privateKey: obj['privateKey'] };
}

export interface TradeResult {
  signature: string;
  /** true ΜΟΝΟ όταν το confirmation polling το επιβεβαίωσε ρητά ως επιτυχές. */
  confirmed: true;
}

/**
 * Poll `getSignatureStatuses` μέχρι το signature φτάσει σε `confirmed`/`finalized`
 * commitment — ΠΟΤΕ δεν αναφέρει επιτυχία μόνο επειδή υποβλήθηκε. Πετάει
 * `PumpPortalTradeFailedError` αν το chain ρητά λέει ότι απέτυχε (err !== null).
 * Πετάει απλό Error αν δεν καταφέραμε να επιβεβαιώσουμε ΚΑΘΟΛΟΥ μέσα στο χρονικό
 * παράθυρο — αυτό ΔΕΝ σημαίνει αποτυχία, σημαίνει "δεν ξέρουμε ακόμα, έλεγξε χειροκίνητα".
 */
async function confirmSignature(signature: string): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL;
  for (let attempt = 0; attempt < CONFIRM_POLL_ATTEMPTS; attempt++) {
    await delay(CONFIRM_POLL_INTERVAL_MS);
    let data: unknown;
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: true }],
        }),
      });
      data = await response.json();
    } catch {
      continue; // παροδικό δικτυακό σφάλμα στο ίδιο το poll — ξαναδοκίμασε
    }
    const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    const result = typeof obj['result'] === 'object' && obj['result'] !== null ? (obj['result'] as Record<string, unknown>) : null;
    const values = Array.isArray(result?.['value']) ? (result['value'] as unknown[]) : null;
    const status = values?.[0];
    if (status === null || status === undefined) continue; // ακόμα δεν φαίνεται καθόλου
    const statusObj = typeof status === 'object' ? (status as Record<string, unknown>) : {};
    const confirmationStatus = statusObj['confirmationStatus'];
    if (confirmationStatus !== 'confirmed' && confirmationStatus !== 'finalized') continue;
    if (statusObj['err'] !== null && statusObj['err'] !== undefined) {
      throw new PumpPortalTradeFailedError(
        `Η συναλλαγή απέτυχε on-chain: ${JSON.stringify(statusObj['err'])}`,
        signature,
      );
    }
    return; // confirmed, err===null — πραγματική επιτυχία
  }
  throw new Error(
    `Δεν επιβεβαιώθηκε μέσα σε ${(CONFIRM_POLL_ATTEMPTS * CONFIRM_POLL_INTERVAL_MS) / 1000}s — ΑΓΝΩΣΤΗ κατάσταση (όχι απαραίτητα αποτυχία), έλεγξε χειροκίνητα: https://solscan.io/tx/${signature}`,
  );
}

async function trade(
  apiKey: string,
  action: 'buy' | 'sell',
  mint: string,
  amount: number | string,
  denominatedInSol: boolean,
  slippagePct: number,
  pool: string,
): Promise<TradeResult> {
  const response = await fetch(`${BASE_URL}/trade?api-key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      mint,
      amount,
      denominatedInSol: denominatedInSol ? 'true' : 'false',
      slippage: slippagePct,
      priorityFee: 0.00001,
      pool,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new PumpPortalTradeError(`${action} failed: HTTP ${response.status}`, response.status, text);
  }
  const parsed: unknown = JSON.parse(text);
  const obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (typeof obj['signature'] !== 'string') {
    throw new PumpPortalTradeError(`${action}: unexpected response shape (no signature)`, response.status, text);
  }
  const signature = obj['signature'];
  await confirmSignature(signature); // πετάει αν αποτύχει ή δεν επιβεβαιωθεί καθόλου
  return { signature, confirmed: true };
}

/**
 * Αγορά — ποσό σε SOL. `pool: 'pump'` ρητά, ΟΧΙ 'auto' — πραγματικό incident 2026-09-14:
 * το 'auto' απέτυχε με "Pool account not found" σε ένα φρέσκο, ήδη gated token μας. Τα
 * δικά μας tokens είναι σχεδόν πάντα ακόμα στο bonding curve (έτσι δουλεύει όλο το
 * σύστημα ανίχνευσης) — το ρητό 'pump' είναι πιο άμεσο, πιθανότατα πιο αξιόπιστο από το
 * αυτόματο detection για ΑΚΡΙΒΩΣ αυτή την περίπτωση.
 */
export async function pumpPortalBuy(
  apiKey: string,
  mint: string,
  amountSol: number,
  slippagePct = 15,
  pool = 'pump',
): Promise<TradeResult> {
  return trade(apiKey, 'buy', mint, amountSol, true, slippagePct, pool);
}

/** Πώληση — ΟΛΟΚΛΗΡΗ η θέση. Ίδιο `pool: 'pump'` default — αν ένα trade έχει «αποφοιτήσει»
 * ανάμεσα σε entry/exit (σπάνιο στο δικό μας 24ωρο παράθυρο), ο caller μπορεί να περάσει
 * ρητά διαφορετικό pool. */
export async function pumpPortalSellAll(
  apiKey: string,
  mint: string,
  slippagePct = 20,
  pool = 'pump',
): Promise<TradeResult> {
  return trade(apiKey, 'sell', mint, '100%', false, slippagePct, pool);
}

export { TRADE_FEE_PCT };
