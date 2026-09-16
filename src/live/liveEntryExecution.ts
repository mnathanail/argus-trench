import { fetchLiveSolWallet, getLiveSolBalance } from '../gmgn/portfolio.js';
import { executeLiveBuy } from '../gmgn/swap.js';
import { decideTradeMode } from '../decision/tradeMode.js';
import { checkLiveRiskGate } from '../decision/liveRiskGate.js';
import { LIVE_POSITION_SIZE_SOL } from '../decision/paperTradingConfig.js';
import { recordExecutionError } from '../db/repositories/tradeExecutionErrors.js';
import { reserveLiveCapital, releaseLiveCapital } from '../db/repositories/liveTradingState.js';
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
 * ανεπαρκές κεφάλαιο, μπλοκαρισμένο risk gate (kill-switch/daily cap), κράτηση
 * κεφαλαίου που απέτυχε (βλ. παρακάτω), ή το ίδιο το swap να αποτύχει. Καμία εξαίρεση
 * διαφεύγει ποτέ από εδώ προς τον caller.
 *
 * ΣΗΜΑΝΤΙΚΟ για τη σειρά κλήσης: αυτό ΠΡΕΠΕΙ να καλείται ΑΦΟΥ το decision_log row έχει
 * ήδη γίνει claim (βλ. handleRealtimeEntryEvent) — ποτέ πριν. Αν κάναμε το swap πρώτα
 * και το claim απέτυχε μετά (π.χ. race με άλλο σήμα), θα καταλήγαμε με πραγματικά
 * ξοδεμένα χρήματα και ΚΑΝΕΝΑ trade row να τα καταγράφει — σιωπηλά χαμένη θέση.
 *
 * ΞΕΧΩΡΙΣΤΟ ρίσκο, εντοπίστηκε 2026-09-15 πριν προλάβει να συμβεί στην πράξη: δύο
 * σήματα σε ΔΙΑΦΟΡΕΤΙΚΑ tokens, μέσα σε λίγα δευτερόλεπτα το ένα από το άλλο, θα
 * μπορούσαν και τα δύο να δουν το ΙΔΙΟ, ακόμα-αναλλοίωτο on-chain balance (το πρώτο
 * swap δεν έχει προλάβει να settle ακόμα) και να προχωρήσουν και τα δύο σε live buy —
 * δεσμεύοντας μαζί παραπάνω κεφάλαιο απ' όσο πραγματικά υπάρχει. Το
 * `reserveLiveCapital` (ατομικό DB statement, βλ. εκεί) το αποκλείει: ό,τι δει το
 * δεύτερο σήμα, η κράτηση θα αποτύχει αν δεν περισσεύει πραγματικά αρκετό κεφάλαιο.
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

  const reserved = await reserveLiveCapital(balance, LIVE_POSITION_SIZE_SOL);
  if (!reserved) return LOG_ONLY_OUTCOME; // ένα σχεδόν-ταυτόχρονο σήμα μόλις δέσμευσε ό,τι έμενε

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
  } finally {
    // ΠΑΝΤΑ απελευθέρωσε την κράτηση, ό,τι κι αν συνέβη στο swap — αλλιώς το reserved_sol
    // θα «κολλούσε» ψηλά για πάντα, μπλοκάροντας μελλοντικά, εντελώς άσχετα σήματα.
    await releaseLiveCapital(LIVE_POSITION_SIZE_SOL);
  }
}
