import { fetchLiveSolWallet, getLiveSolBalance } from '../gmgn/portfolio.js';
import { executeLiveBuy } from '../gmgn/swap.js';
import { getStrategyOrder } from '../gmgn/strategyOrders.js';
import { decideTradeMode } from '../decision/tradeMode.js';
import { checkLiveRiskGate } from '../decision/liveRiskGate.js';
import { LIVE_POSITION_SIZE_SOL, liveExitConditionOrders } from '../decision/paperTradingConfig.js';
import { recordExecutionError } from '../db/repositories/tradeExecutionErrors.js';
import { reserveLiveCapital, releaseLiveCapital } from '../db/repositories/liveTradingState.js';
import type { TradeMode } from '../db/types.js';

export interface LiveEntryOutcome {
  /**
   * 'live' ΜΟΝΟ σε πραγματική, επιβεβαιωμένη επιτυχία. 'paper' σε ΚΑΘΕ άλλη περίπτωση —
   * ανεπαρκές κεφάλαιο, kill-switch/daily cap, χαμένη κράτηση κεφαλαίου, αποτυχημένο swap
   * ή αδύνατη ανάγνωση του wallet (αλλαγή 2026-09-27, βλ. PAPER_OUTCOME).
   */
  mode: TradeMode;
  /** Πραγματικό SOL που ξοδεύτηκε (balance-diff) — μόνο όταν mode==='live'. */
  actualEntryAmountSol: number | null;
  /** Πραγματική εκτελεσμένη τιμή — μόνο όταν mode==='live'. Ο caller πέφτει στην
   * τιμή από το ίδιο το websocket event όταν αυτό είναι null. */
  entryPrice: number | null;
  /** Το `strategy_order_id` του native GMGN trailing-stop/stop-loss order, ΜΟΝΟ όταν
   * `nativeOrderVerified===true` (βλ. εκεί) — αλλιώς null, ο caller δεν το εμπιστεύεται. */
  liveStrategyOrderId: string | null;
  /** true ΜΟΝΟ όταν επιβεβαιώσαμε (`order strategy list`, αμέσως μετά το buy) ότι το
   * native strategy είναι πράγματι `running` ΚΑΙ κανένα υπο-order δεν είναι `failed`.
   * false σε ΚΑΘΕ άλλη περίπτωση (δεν ζητήθηκε, απέτυχε η δημιουργία, ή η δημιουργία
   * "πέτυχε" αλλά η επιβεβαίωση δεν το βρήκε υγιές) — τότε το δικό μας realtime tracking
   * (checkTick) παραμένει ο ΜΟΝΑΔΙΚΟΣ μηχανισμός προστασίας, ΑΚΡΙΒΩΣ όπως πριν. */
  nativeOrderVerified: boolean;
  /** ΔΙΟΡΘΩΣΗ 2026-09-18: true ΜΟΝΟ όταν αυτή η προσπάθεια ήταν αυτή που μόλις ενεργοποίησε
   * το kill-switch (LIVE_KILL_SWITCH_CONSEC_LOSSES συνεχόμενες ζημιές) — βλ.
   * RiskGateResult.justHalted. Ο caller
   * (handleRealtimeEntryEvent/main.ts) το χρησιμοποιεί για proactive Telegram alert, ώστε
   * ο χρήστης να το μάθει ΑΜΕΣΩΣ αντί μόνο από το επόμενο (πιθανώς μπαγιάτικο) daily
   * digest — πραγματικό εύρημα 2026-09-17/18, ο χρήστης μπερδεύτηκε με στιγμιότυπο digest. */
  killSwitchJustTriggered: boolean;
}

/**
 * ΑΛΛΑΓΗ 2026-09-27 (ρητή απόφαση χρήστη): `'paper'` σημαίνει πλέον "θέλαμε live, αλλά
 * για ΟΠΟΙΟΝΔΗΠΟΤΕ λόγο δεν έγινε" — ανεπαρκές κεφάλαιο, kill-switch/daily cap, χαμένη
 * κράτηση κεφαλαίου σε race, αποτυχημένο swap, ή αδυναμία ανάγνωσης του wallet. Πριν,
 * μόνο το ανεπαρκές κεφάλαιο έδινε `'paper'` και όλα τα υπόλοιπα `'log_only'`. Το
 * `'log_only'` δεν παράγεται πια από αυτό το path (και τα GMGN smartmoney / wallet
 * polling κανάλια σταμάτησαν να ανοίγουν trades την ίδια μέρα) — έτσι τα paper trades
 * είναι ακριβώς "τα live που δεν έγιναν", άμεσα συγκρίσιμα με τα πραγματικά.
 * Ο λόγος αποτυχίας (πέρα από το κεφάλαιο) καταγράφεται ήδη στο trade_execution_errors
 * ή στο kill-switch state, οπότε δεν χάνεται πληροφορία με το ενιαίο mode.
 */
const PAPER_OUTCOME: LiveEntryOutcome = {
  mode: 'paper',
  actualEntryAmountSol: null,
  entryPrice: null,
  liveStrategyOrderId: null,
  nativeOrderVerified: false,
  killSwitchJustTriggered: false,
};

/**
 * Καθαρή, τεσταρίσιμη επιλογή του fallback outcome όταν δεν προσπαθούμε (ή δεν
 * καταφέρνουμε) live entry — εξαγόμενη ξεχωριστά από το `attemptLiveEntry` ΑΚΡΙΒΩΣ για
 * να μπορεί να τεσταριστεί χωρίς πραγματικό DB/CLI, μετά το πραγματικό εύρημα 2026-09-17
 * (βλ. σχόλιο στο PAPER_OUTCOME): πριν, αυτή η επιλογή ζούσε ανώνυμα μέσα σε
 * `if (...) return LOG_ONLY_OUTCOME`, χωρίς κανένα test να την κλειδώνει, και το bug
 * ήταν αόρατο μέχρι να το δει ο χρήστης στην παραγωγή.
 *
 * Από 2026-09-27 ΚΑΘΕ reason δίνει `'paper'` (βλ. PAPER_OUTCOME). Το `reason` παραμένει
 * ως παράμετρος για το `killSwitchJustTriggered`: μόνο το `risk_gate_blocked` μπορεί ποτέ
 * να το θέσει true, οι υπόλοιποι λόγοι το αγνοούν ρητά.
 */
export type LiveFallbackReason =
  /** Graduated token ενώ LIVE_ON_GRADUATED_TOKENS=false — σκόπιμα paper, δοκιμαστική περίοδος. */
  | 'graduated_paper_only'
  | 'wallet_unavailable'
  | 'insufficient_capital'
  | 'risk_gate_blocked'
  | 'reservation_lost'
  | 'swap_failed';

export function fallbackOutcomeFor(reason: LiveFallbackReason, killSwitchJustTriggered = false): LiveEntryOutcome {
  // ΜΟΝΟ το risk_gate_blocked περνάει ποτέ killSwitchJustTriggered=true στην πράξη (μόνο
  // εκεί καλείται το checkLiveRiskGate) — αλλά ελέγχουμε ρητά το reason εδώ, όχι μόνο το
  // flag, ώστε ένα μελλοντικό λάθος στον caller να μην μπορεί ποτέ να στείλει το alert
  // κάτω από λάθος λόγο αποτυχίας (π.χ. reservation_lost/swap_failed).
  const shouldFlag = reason === 'risk_gate_blocked' && killSwitchJustTriggered;
  return shouldFlag ? { ...PAPER_OUTCOME, killSwitchJustTriggered: true } : PAPER_OUTCOME;
}

/** Πόσο περιμένουμε πριν το πρώτο verify poll — το strategy order χρειάζεται λίγο χρόνο
 * να εμφανιστεί στο `order strategy list` μετά τη δημιουργία του (ίδιο σκεπτικό με το
 * POLL_INTERVAL_MS του swap.ts, αλλά πιο σύντομο — ΔΕΝ μπλοκάρουμε το πλήρες entry flow
 * για πολύ ώρα, το καλύτερο fallback (δικό μας tracking) είναι ήδη διαθέσιμο αμέσως). */
const NATIVE_ORDER_VERIFY_DELAY_MS = 4_000;

/**
 * Αμέσως μετά από ένα επιτυχημένο buy με `--condition-orders`, επιβεβαιώνει ότι το
 * native strategy όντως "έπιασε" — η δημιουργία του είναι best-effort (βλ. SKILL.md),
 * άρα ΔΕΝ αρκεί να δούμε `strategy_order_id` στο swap response. Ποτέ δεν πετάει — μια
 * αποτυχία εδώ σημαίνει απλά "δεν επιβεβαιώθηκε", ο caller πέφτει στο δικό μας tracking.
 */
async function verifyNativeOrder(
  walletAddress: string,
  tokenAddress: string,
  strategyOrderId: string,
): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, NATIVE_ORDER_VERIFY_DELAY_MS));
  try {
    const strategy = await getStrategyOrder(walletAddress, tokenAddress, strategyOrderId);
    if (strategy === null) return false;
    if (strategy.strategyStatus !== 'running') return false;
    if (strategy.conditionOrders.length === 0) return false;
    return strategy.conditionOrders.every((sub) => sub.status !== 'failed');
  } catch {
    return false; // π.χ. rate limit — μην μπλοκάρεις το entry flow, απλά fallback
  }
}

/**
 * Αποφασίζει live-ή-paper ΚΑΙ εκτελεί, με πλήρη πτώση σε 'paper' σε ΚΑΘΕ αποτυχία —
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
 * paper row αμέσως μετά, γι' αυτό η αποτυχία δεν συνδέεται άμεσα με trade id εδώ).
 */
export async function attemptLiveEntry(tokenAddress: string): Promise<LiveEntryOutcome> {
  let wallet;
  try {
    wallet = await fetchLiveSolWallet();
  } catch (error) {
    // ΔΙΟΡΘΩΣΗ 2026-09-18 (πραγματικό εύρημα): πριν, αυτό το catch ήταν ΕΝΤΕΛΩΣ σιωπηλό —
    // ούτε log, ούτε trade_execution_errors row, τίποτα. Αν το `portfolio info` αρχίσει
    // να αποτυγχάνει (429 παρατεταμένο, ληγμένο API key/session, αλλαγή στο wallet
    // binding, ό,τι δήποτε), ΚΑΘΕ σήμα καταλήγει σιωπηλά μη-live επ' αόριστον — καμία
    // ένδειξη στο kill-switch (ποτέ δεν φτάνει ως εκεί), καμία στο trade_execution_errors
    // (αυτό το catch είναι ΠΡΙΝ φτάσει εκεί). Ο χρήστης το ανακάλυψε μόνο επειδή παρατήρησε
    // ότι δεν έβλεπε πια νέα trades στο ίδιο το GMGN UI, ώρες αργότερα — ΧΩΡΙΣ αυτή τη
    // διόρθωση δεν υπάρχει κανένα ερώτημα στη βάση που να το αποκαλύπτει άμεσα.
    console.error(`[live-entry] fetchLiveSolWallet απέτυχε — fallback σε paper: ${error instanceof Error ? error.message : String(error)}`);
    await recordExecutionError({
      paperTradeId: null,
      tokenAddress,
      action: 'buy',
      amountSol: null,
      errorMessage: `δεν διαβάστηκε το live SOL wallet (portfolio info) — ${error instanceof Error ? error.message : String(error)}`,
      errorDetail: error,
    });
    return fallbackOutcomeFor('wallet_unavailable'); // δεν διαβάστηκε καν το υπόλοιπο — ασφαλές fallback
  }

  const balance = wallet.balances.find((b) => b.symbol === 'SOL')?.balance ?? 0;
  if (decideTradeMode(balance, LIVE_POSITION_SIZE_SOL) !== 'live') {
    return fallbackOutcomeFor('insufficient_capital');
  }

  const risk = await checkLiveRiskGate();
  if (!risk.allowed) return fallbackOutcomeFor('risk_gate_blocked', risk.justHalted);

  const reserved = await reserveLiveCapital(balance, LIVE_POSITION_SIZE_SOL);
  // ένα σχεδόν-ταυτόχρονο σήμα μόλις δέσμευσε ό,τι έμενε
  if (!reserved) return fallbackOutcomeFor('reservation_lost');

  try {
    const result = await executeLiveBuy(
      wallet.address,
      tokenAddress,
      LIVE_POSITION_SIZE_SOL,
      {},
      liveExitConditionOrders(),
    );
    const balanceAfter = await getLiveSolBalance();
    const nativeOrderVerified =
      result.strategyOrderId !== null && (await verifyNativeOrder(wallet.address, tokenAddress, result.strategyOrderId));
    if (result.strategyOrderId === null) {
      // 2026-09-28: ζητήσαμε --condition-orders αλλά το GMGN δεν δημιούργησε strategy — η
      // θέση ΔΕΝ έχει server-side stop-loss/trailing, μόνο το δικό μας realtime tracking.
      // Κρατάμε ολόκληρο το swap response για να φανεί ΓΙΑΤΙ (πριν: καμία καταγραφή).
      console.warn(`[live-entry] ⚠️ κανένα native strategy order για ${tokenAddress} — το swap response δεν είχε strategy_order_id`);
      await recordExecutionError({
        paperTradeId: null,
        tokenAddress,
        action: 'buy',
        amountSol: LIVE_POSITION_SIZE_SOL,
        errorMessage: 'Το buy πέτυχε, αλλά ΔΕΝ δημιουργήθηκε native strategy order (κανένα strategy_order_id στο swap response) — η θέση δεν έχει server-side stop-loss/trailing.',
        errorDetail: { swapResponse: result.swapResponse, conditionOrders: liveExitConditionOrders() },
      });
    }
    if (result.strategyOrderId !== null && !nativeOrderVerified) {
      // Η δημιουργία "πέτυχε" (είχαμε strategy_order_id) αλλά δεν επιβεβαιώθηκε υγιής —
      // ΔΕΝ είναι σφάλμα του ίδιου του buy (η θέση ανοίχτηκε κανονικά), αλλά αξίζει
      // καταγραφή: το δικό μας tracking είναι η μόνη προστασία εδώ, χρήσιμο να ξέρουμε
      // ότι το native attach δεν έπιασε γι' αυτό το trade συγκεκριμένα.
      await recordExecutionError({
        paperTradeId: null,
        tokenAddress,
        action: 'buy',
        amountSol: LIVE_POSITION_SIZE_SOL,
        errorMessage: `native strategy order ${result.strategyOrderId} δεν επιβεβαιώθηκε υγιές μετά το entry — fallback στο δικό μας realtime tracking`,
      });
    }
    return {
      mode: 'live',
      actualEntryAmountSol: balance - balanceAfter,
      entryPrice: result.executedPrice,
      liveStrategyOrderId: nativeOrderVerified ? result.strategyOrderId : null,
      nativeOrderVerified,
      killSwitchJustTriggered: false, // επιτυχές live trade — δεν πυροδότησε τίποτα
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
    return fallbackOutcomeFor('swap_failed');
  } finally {
    // ΠΑΝΤΑ απελευθέρωσε την κράτηση, ό,τι κι αν συνέβη στο swap — αλλιώς το reserved_sol
    // θα «κολλούσε» ψηλά για πάντα, μπλοκάροντας μελλοντικά, εντελώς άσχετα σήματα.
    await releaseLiveCapital(LIVE_POSITION_SIZE_SOL);
  }
}
