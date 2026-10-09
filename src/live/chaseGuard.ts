import { parseWalletTrade } from '../mirror/heliusTrade.js';
import { base64Data, decodeBondingCurve } from '../realtime/heliusPriceFeed.js';
import { getMultipleAccounts, getParsedTransactionWithRetry, heliusRpcUrl, type AccountInfoLite, type ParsedTransaction } from '../solana/heliusRpc.js';

/**
 * 2026-10-09 — μετά τα πρώτα 4 live trades (όλα χαμένα): οι αγορές μας γέμιζαν πολύ πάνω από την
 * τιμή του σήματος (#8882 +16.6%· #8888 κατά προσέγγιση +45% — trailing από κορυφή 1.81× έκλεισε
 * −11%). Τα proven wallets αγοράζουν μεγάλα ποσά και τα αντιγράφουν κι άλλοι, οπότε μέσα στα ~3″
 * μέχρι τη δική μας αγορά η καμπύλη έχει ήδη τρέξει. Το `--slippage 15` προστατεύει μόνο από
 * το quote του GMGN ως την επιβεβαίωση — όχι από ό,τι έγινε ΠΡΙΝ το quote.
 *
 * 1) `measurePriceRun`: ακριβώς πριν τη live αγορά διαβάζουμε την τωρινή κατάσταση της bonding
 *    curve (1 credit Helius) και τη συγκρίνουμε με την τιμή του σήματος. Αν έχει ήδη τρέξει πάνω από
 *    MAX_ENTRY_PRICE_RUN → paper (`price_ran_paper`): δεν κυνηγάμε.
 * 2) `onchainFillPrice`: όταν το GMGN δεν δίνει τιμή εκτέλεσης (το `report` υπάρχει μόνο σε
 *    status successful — 3 από τα 4 πρώτα trades δεν το είχαν), η πραγματική τιμή βγαίνει από την
 *    ίδια τη συναλλαγή αγοράς (SOL προς την καμπύλη / tokens που πήραμε). Χωρίς αυτήν το stop και το
 *    trailing μετριούνταν από την τιμή σήματος + 3%, όχι από ό,τι πληρώσαμε.
 */

export const MAX_ENTRY_PRICE_RUN = 0.1;

/** true = η τιμή δεν έχει τρέξει πάνω από το όριο από το σήμα ως τώρα. null (άγνωστο) = όχι live. */
export function priceRunAllowsLive(run: number | null): boolean {
  return run !== null && Number.isFinite(run) && run <= MAX_ENTRY_PRICE_RUN;
}

export interface ChaseRpc {
  accounts: (addresses: readonly string[], encoding: 'base64') => Promise<(AccountInfoLite | null)[]>;
  transaction: (signature: string) => Promise<ParsedTransaction | null>;
}

export function heliusChaseRpc(apiKey: string): ChaseRpc {
  const url = heliusRpcUrl(apiKey);
  return {
    accounts: (addresses, encoding) => getMultipleAccounts(url, addresses, encoding),
    // σύντομες αναμονές: τρέχει πριν το INSERT του trade, μέσα στο entry lock του token
    transaction: (signature) => getParsedTransactionWithRetry(url, signature, [0, 500, 1_000, 2_000]),
  };
}

/** Τωρινή τιμή καμπύλης / τιμή σήματος − 1 (0.25 = έτρεξε +25%). null αν δεν διαβάζεται. */
export async function measurePriceRun(rpc: ChaseRpc, bondingCurve: string, signalPrice: number): Promise<number | null> {
  if (!(signalPrice > 0)) return null;
  const [account] = await rpc.accounts([bondingCurve], 'base64');
  const buf = account === null || account === undefined ? null : base64Data(account.data);
  const curve = buf === null ? null : decodeBondingCurve(buf);
  if (curve === null || curve.complete) return null; // ολοκληρωμένη καμπύλη = όχι πια τιμή καμπύλης
  return curve.virtualSolReserves / curve.virtualTokenReserves / signalPrice - 1;
}

/** Μέση τιμή εκτέλεσης της ΔΙΚΗΣ μας αγοράς από την on-chain συναλλαγή (SOL ανά token). */
export async function onchainFillPrice(rpc: ChaseRpc, txHash: string, wallet: string): Promise<number | null> {
  const tx = await rpc.transaction(txHash);
  if (tx === null) return null;
  const parsed = parseWalletTrade(tx, wallet);
  if (!parsed.ok || parsed.event.txType !== 'buy' || !(parsed.event.tokenAmount > 0) || !(parsed.event.solAmount > 0)) return null;
  return parsed.event.solAmount / parsed.event.tokenAmount;
}
