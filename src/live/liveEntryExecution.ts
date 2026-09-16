import { fetchLiveSolWallet, getLiveSolBalance } from '../gmgn/portfolio.js';
import { executeLiveBuy } from '../gmgn/swap.js';
import { decideTradeMode } from '../decision/tradeMode.js';
import { checkLiveRiskGate } from '../decision/liveRiskGate.js';
import { LIVE_POSITION_SIZE_SOL } from '../decision/paperTradingConfig.js';
import { recordExecutionError } from '../db/repositories/tradeExecutionErrors.js';
import type { TradeMode } from '../db/types.js';

export interface LiveEntryOutcome {
  mode: TradeMode; // 'live' μόνο σε πραγματική, επιβεβαιωμένη επιτυχία — αλλιώς 'log_only'
  /** Πραγματικό SOL που ξοδεύτηκε (balance-diff) — μόνο όταν mode==='live'. */
  actualEntryAmountSol: number | null;
  /** Πραγματική εκτελεσμένη τιμή — μόνο όταν mode==='live'. Ο caller πέφτει στην
   * τιμή από το ίδιο το websocket event όταν αυτό είναι null. */
  entryPrice: number | null;
}

const LOG_ONLY_OUTCOME: LiveEntryOutcome = { mode: 'log_only', actualEntryAmountSol: null, entryPrice: null };

/**
 * Αποφασίζει live-ή-paper ΚΑΙ εκτελεί, με πλήρη πτώση σε 'log_only' σε ΚΑΘΕ αποτυχία —
 * ανεπαρκές κεφάλαιο, μπλοκαρισμένο risk gate (kill-switch/daily cap), ή το ίδιο το swap
 * να αποτύχει. Καμία εξαίρεση διαφεύγει ποτέ από εδώ προς τον caller.
 *
 * ΣΗΜΑΝΤΙΚΟ για τη σειρά κλήσης: αυτό ΠΡΕΠΕΙ να καλείται ΑΦΟΥ το decision_log row έχει
 * ήδη γίνει claim (βλ. handleRealtimeEntryEvent) — ποτέ πριν. Αν κάναμε το swap πρώτα
 * και το claim απέτυχε μετά (π.χ. race με άλλο σήμα), θα καταλήγαμε με πραγματικά
 * ξοδεμένα χρήματα και ΚΑΝΕΝΑ trade row να τα καταγράφει — σιωπηλά χαμένη θέση.
 *
 * Καταγράφει κάθε αποτυχία του ΙΔΙΟΥ του swap στο trade_execution_errors (`paperTradeId:
 * null` — η αποτυχία συνέβη πριν υπάρξει καν trade row, ο caller θα δημιουργήσει ένα
 * log_only row αμέσως μετά, γι' αυτό η αποτυχία δεν συνδέεται άμεσα με trade id εδώ).
 */
export async function attemptLiveEntry(tokenAddress: string): Promise<LiveEntryOutcome> {
  let wallet;
  try {
    wallet = await fetchLiveSolWallet();
  } catch {
    return LOG_ONLY_OUTCOME; // δεν μπορέσαμε καν να διαβάσουμε το υπόλοιπο — ασφαλές fallback
  }

  const balance = wallet.balances.find((b) => b.symbol === 'SOL')?.balance ?? 0;
  if (decideTradeMode(balance, LIVE_POSITION_SIZE_SOL) !== 'live') return LOG_ONLY_OUTCOME;

  const risk = await checkLiveRiskGate();
  if (!risk.allowed) return LOG_ONLY_OUTCOME;

  try {
    const result = await executeLiveBuy(wallet.address, tokenAddress, LIVE_POSITION_SIZE_SOL);
    const balanceAfter = await getLiveSolBalance();
    return {
      mode: 'live',
      actualEntryAmountSol: balance - balanceAfter,
      entryPrice: result.executedPrice,
    };
  } catch (error) {
    await recordExecutionError({
      paperTradeId: null,
      tokenAddress,
      action: 'buy',
      amountSol: LIVE_POSITION_SIZE_SOL,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorDetail: error,
    });
    return LOG_ONLY_OUTCOME;
  }
}
