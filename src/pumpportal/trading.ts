/**
 * PumpPortal Lightning Trading API — ΞΕΧΩΡΙΣΤΟ από το websocket data feed
 * (src/realtime/pumpportalConnection.ts). Ίδια εταιρεία, ίδιο domain, εντελώς
 * διαφορετική ανησυχία: εδώ μιλάμε για HTTP POST κλήσεις που στέλνουν πραγματικά χρήματα,
 * όχι WebSocket subscriptions για δεδομένα.
 *
 * ΓΙΑΤΙ Lightning ΚΑΙ ΟΧΙ Local API: το Local API απαιτεί να υπογράφουμε ΕΜΕΙΣ με
 * πραγματικό Solana private key — αλλά το δικό μας GMGN_PRIVATE_KEY είναι ΜΟΝΟ για
 * υπογραφή αιτημάτων προς το GMGN API (τοπική, message-level signature), ΟΧΙ το
 * πραγματικό κλειδί του on-chain wallet — το GMGN δεν μας το δίνει ποτέ. Άρα δεν έχουμε
 * σήμερα κανένα wallet όπου κρατάμε εμείς το πραγματικό private key. Το Lightning API
 * (PumpPortal δημιουργεί ΚΑΙ κρατάει το δικό του wallet για εμάς) είναι πιο άμεσα
 * συγκρίσιμο με το ήδη υπάρχον μοντέλο εμπιστοσύνης που έχουμε με το GMGN.
 *
 * Επιβεβαιωμένο από ΤΡΕΙΣ ανεξάρτητες πηγές τεκμηρίωσης 2026-09-14 (επίσημο
 * thetateman/Trading-API repo, Solana Compass project review, πραγματικό δημοσιευμένο
 * MCP server "pump-portal-mcp-server" στο PyPI) — αλλά ΚΑΜΙΑ δική μας, εμπειρική δοκιμή
 * ακόμα. Γι' αυτό υπάρχει το scripts/create-pumpportal-wallet.ts: δείχνει το ΩΜΟ
 * response πριν χτίσουμε οτιδήποτε πάνω σε υποθέσεις, ίδιο μοτίβο με κάθε άλλη
 * ενσωμάτωση μέχρι τώρα σε αυτό το project.
 */

const BASE_URL = 'https://pumpportal.fun/api';
const TRADE_FEE_PCT = 0.005; // 0.5% — ρητά αναφερόμενο σε όλες τις πηγές τεκμηρίωσης

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

/**
 * ΜΙΑ φορά, χειροκίνητα — δημιουργεί ΝΕΟ wallet+apiKey. ΔΕΝ το καλούμε ποτέ αυτόματα
 * (θα δημιουργούσε ατελείωτα νέα wallets) — μόνο από το verification script.
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
}

async function trade(
  apiKey: string,
  action: 'buy' | 'sell',
  mint: string,
  amount: number | string,
  denominatedInSol: boolean,
  slippagePct: number,
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
      priorityFee: 0.00001, // μικρό, σταθερό — ίδιο σκεπτικό με τα παραδείγματα τεκμηρίωσης
      pool: 'auto',
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
  return { signature: obj['signature'] };
}

/** Αγορά — ποσό σε SOL. */
export async function pumpPortalBuy(apiKey: string, mint: string, amountSol: number, slippagePct = 15): Promise<TradeResult> {
  return trade(apiKey, 'buy', mint, amountSol, true, slippagePct);
}

/** Πώληση — ΟΛΟΚΛΗΡΗ η θέση, ίδιο σκεπτικό με το GMGN's `--percent 100`: αποφεύγει να
 * χρειαστεί να υπολογίσουμε ακριβές ποσό/decimals του token που κρατάμε. */
export async function pumpPortalSellAll(apiKey: string, mint: string, slippagePct = 20): Promise<TradeResult> {
  return trade(apiKey, 'sell', mint, '100%', false, slippagePct);
}

export { TRADE_FEE_PCT };
