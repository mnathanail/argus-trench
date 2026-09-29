import { setNativeOrderState } from '../db/repositories/paperTrades.js';
import { recordExecutionError } from '../db/repositories/tradeExecutionErrors.js';
import { findStrategyForToken, type StrategyOrderInfo } from '../gmgn/strategyOrders.js';

/**
 * 2026-09-29 — σύνδεση του native GMGN strategy με το live trade ΜΕΤΑ το entry.
 *
 * Πραγματικό εύρημα: το swap επιστρέφει `status: submitted` χωρίς `strategy_order_id`,
 * αλλά το strategy (trailing +50%/−25%, stop-loss −50%) δημιουργείται κανονικά λίγο μετά.
 * Εμείς το θεωρούσαμε ανύπαρκτο → native_order_active=false → ο reconciler δεν κοίταζε
 * ποτέ αυτά τα trades → όταν το GMGN πουλούσε (stop-loss), η βάση μας έμενε «ανοιχτή».
 *
 * Τρέχει ΜΕΤΑ το INSERT του trade, στο παρασκήνιο: δεν καθυστερεί την παρακολούθηση
 * εξόδων. Ποτέ δεν πετάει. Το native_order_active γίνεται true ακόμα κι αν το strategy
 * έχει ήδη κλείσει — έτσι το παραλαμβάνει ο reconciler και καταγράφει την έξοδο.
 */

export interface AttachDeps {
  find: (wallet: string, token: string, sinceMs: number) => Promise<StrategyOrderInfo | null>;
  save: (tradeId: number, orderId: string) => Promise<void>;
  reportMissing: (tradeId: number, token: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export const NATIVE_ATTACH_ATTEMPTS = 6;
export const NATIVE_ATTACH_INTERVAL_MS = 2_000;

const defaultDeps: AttachDeps = {
  find: (wallet, token, sinceMs) => findStrategyForToken(wallet, token, sinceMs),
  save: (tradeId, orderId) => setNativeOrderState(tradeId, { liveStrategyOrderId: orderId, nativeOrderActive: true }),
  reportMissing: async (tradeId, token) => {
    await recordExecutionError({
      paperTradeId: tradeId,
      tokenAddress: token,
      action: 'buy',
      amountSol: null,
      errorMessage:
        `Κανένα native GMGN strategy δεν βρέθηκε στο order strategy list μέσα σε ` +
        `${(NATIVE_ATTACH_ATTEMPTS * NATIVE_ATTACH_INTERVAL_MS) / 1000}″ μετά το buy — η θέση ` +
        'προστατεύεται μόνο από το δικό μας realtime tracking.',
    });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
};

export async function attachNativeStrategy(
  tradeId: number,
  walletAddress: string,
  tokenAddress: string,
  sinceMs: number,
  deps: AttachDeps = defaultDeps,
): Promise<StrategyOrderInfo | null> {
  const tag = `[native-attach] trade=${tradeId} mint=${tokenAddress.slice(0, 8)}`;
  for (let attempt = 1; attempt <= NATIVE_ATTACH_ATTEMPTS; attempt++) {
    try {
      const strategy = await deps.find(walletAddress, tokenAddress, sinceMs);
      if (strategy !== null) {
        await deps.save(tradeId, strategy.orderId);
        deps.log(`${tag} βρέθηκε ${strategy.orderId} (status=${strategy.status}/${strategy.strategyStatus}, προσπάθεια ${attempt})`);
        return strategy;
      }
    } catch (error) {
      deps.log(`${tag} προσπάθεια ${attempt} απέτυχε: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < NATIVE_ATTACH_ATTEMPTS) await deps.sleep(NATIVE_ATTACH_INTERVAL_MS);
  }
  deps.log(`${tag} ⚠️ κανένα native strategy`);
  await deps.reportMissing(tradeId, tokenAddress).catch(() => undefined);
  return null;
}
