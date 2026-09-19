import {
  listAllOpenLiveTrades,
  markNeedsManualExit,
  type OpenLiveTrade,
} from '../db/repositories/paperTrades.js';
import { recordExecutionError } from '../db/repositories/tradeExecutionErrors.js';
import { fetchLiveSolWallet } from '../gmgn/portfolio.js';
import { fetchTokenBalance } from '../gmgn/tokenBalance.js';
import { rethrowIfRateLimited } from '../gmgn/errors.js';
import { LIVE_TRADE_WATCHDOG_LOOP_PACING_MS } from './intervals.js';
import { delay } from '../util/delay.js';
import { short } from '../telegram/commands.js';

/**
 * Γενικό watchdog πάνω σε ΟΛΑ τα ανοιχτά `mode='live'` trades (2026-09-17, incident
 * #1193 — τρίτο, ανεξάρτητο δίχτυ ασφαλείας της ίδιας μέρας, βλ. intervals.ts για το
 * πλήρες σκεπτικό). Σε αντίθεση με τον `liveStrategyReconciler` (μόνο
 * `native_order_active=true`), αυτό καλύπτει ΚΑΘΕ ανοιχτό live trade — η ΜΟΝΗ γενική
 * προστασία που δεν εξαρτάται ούτε από το PumpPortal websocket feed (χωρίς
 * heartbeat/staleness ανίχνευση ακόμα) ούτε από ένα ενεργό native GMGN order.
 *
 * Φιλοσοφία, ΙΔΙΑ με τον reconciler — απόλυτος κανόνας μετά το #1193: ΔΙΑΒΑΖΕΙ μόνο
 * πραγματική on-chain κατάσταση, ΠΟΤΕ δεν υπολογίζει ή γράφει simulated/υποθετικό pnl.
 * Αν το on-chain token balance του live wallet είναι 0 για ένα trade που ακόμα δείχνει
 * `open` στη βάση μας ΚΑΙ δεν έχει ποτέ καταγραφεί πραγματική πώληση
 * (`actualExitAmountSol` — αυτό το query δεν το διαβάζει καν, βλ. `markNeedsManualExit`),
 * σημαίνει ότι η θέση έκλεισε αλλού (χειροκίνητα από τον χρήστη, ή από ένα native order
 * που ο reconciler δεν έχει προλάβει ακόμα να συμφιλιώσει) — δεν το βλέπουμε ξανά,
 * σημαδεύεται `needs_manual_exit` για χειροκίνητη επιβεβαίωση, ΠΟΤΕ αυτόματο κλείσιμο
 * με μαντεμένο αποτέλεσμα.
 *
 * ΑΥΣΤΗΡΑ scoped σε `mode='live'` (το ίδιο το `listAllOpenLiveTrades` query το εγγυάται)
 * — δεν αγγίζει ΠΟΤΕ `mode='paper'`/`'log_only'` trades. Αυτό διατηρεί ρητά άθικτο το
 * fallback-σε-paper-όταν-δεν-επαρκεί-το-κεφάλαιο (`decideTradeMode`,
 * decision/tradeMode.ts) — ένα paper trade ΔΕΝ έχει ποτέ πραγματικό on-chain balance να
 * ελεγχθεί, και δεν πρέπει ποτέ να προσπαθήσουμε.
 */
export interface LiveTradeWatchdogResult {
  checked: number;
  flaggedForManualExit: number;
  failures: number;
  alerts: string[];
}

async function checkOneTrade(
  trade: OpenLiveTrade,
  walletAddress: string,
): Promise<{ flagged: boolean; alert: string | null }> {
  // Ήδη σημαδεμένο — άλλος μηχανισμός (realtime handler, reconciler) το είδε πρώτο.
  // Τίποτα νέο να κάνουμε, αποφεύγει διπλό alert σε κάθε κύκλο μέχρι να λυθεί χειροκίνητα.
  if (trade.needsManualExit) return { flagged: false, alert: null };

  let balance: number;
  try {
    balance = await fetchTokenBalance(walletAddress, trade.tokenAddress);
  } catch (error) {
    // ΔΙΟΡΘΩΣΗ 2026-09-19 (πραγματικό εύρημα, incident: trade #1225 — +400%+ θέση, GMGN
    // την έδειξε κλειστή, εμείς ακόμα open): πριν, ΚΑΘΕ αποτυχία του `fetchTokenBalance`
    // εδώ ανέβαινε ως γενικό exception μέχρι το `catch` του `runLiveTradeWatchdogCycle`,
    // που απλά κάνει `result.failures += 1` — ΧΩΡΙΣ console.error, χωρίς
    // trade_execution_errors row, τίποτα. Στα production logs αυτού του incident, το
    // `[live-trade-watchdog] ... failures=1` εμφανιζόταν σε ΣΧΕΔΟΝ ΚΑΘΕ κύκλο των 5
    // λεπτών, ΚΑΘ' ΟΛΗ τη διάρκεια ζωής του trade #1225 — δηλαδή ο μοναδικός μηχανισμός
    // που θα μπορούσε να ανιχνεύσει «η θέση έκλεισε αλλού, on-chain balance=0» πιθανότατα
    // απέτυχε σιωπηλά σε ΚΑΘΕ προσπάθεια, γι' αυτό το trade ποτέ δε σημαδεύτηκε
    // `needs_manual_exit`. Ύποπτος #1: το `parseTokenBalance()` στο `gmgn/tokenBalance.ts`
    // δεν έχει ποτέ επιβεβαιωθεί έναντι πραγματικού response σχήματος σε αυτό το
    // sandbox — ένα απρόσμενο field name θα πετούσε `GmgnResponseError` σε κάθε call.
    // Ίδιο pattern με το silent `fetchLiveSolWallet()` bug (commit ab12fdb) — εδώ ίδιο
    // fix: καταγραφή ΠΡΙΝ το rethrow, ώστε το επόμενο επεισόδιο να δείχνει αμέσως ΤΙ
    // trade και ΓΙΑΤΙ, αντί για ένα αδιάφορο αθροιστικό `failures=N`.
    rethrowIfRateLimited(error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(
      `[live-trade-watchdog] fetchTokenBalance απέτυχε για trade #${trade.id} ` +
        `(${short(trade.tokenAddress)}): ${errorMessage}`,
    );
    await recordExecutionError({
      paperTradeId: trade.id,
      tokenAddress: trade.tokenAddress,
      action: 'sell',
      amountSol: null,
      errorMessage: `live-trade-watchdog: fetchTokenBalance απέτυχε — ${errorMessage}`,
      errorDetail: error,
    });
    throw error; // ίδια συμπεριφορά προς τα έξω (μετράει στο failures=N), τώρα με ίχνος
  }
  if (balance > 0) return { flagged: false, alert: null }; // η θέση υπάρχει ακόμα on-chain — υγιές

  // balance === 0 αλλά η βάση μας ακόμα δείχνει open: η θέση έκλεισε αλλού, ΧΩΡΙΣ ΠΟΤΕ να
  // καταγραφεί πραγματική πώληση εδώ. ΔΕΝ μαντεύουμε pnl — μόνο σημαδεύουμε για χειροκίνητο
  // έλεγχο, ίδιο ακριβώς σκεπτικό με το failLiveClose() στο realtimeExitHandler.ts.
  await recordExecutionError({
    paperTradeId: trade.id,
    tokenAddress: trade.tokenAddress,
    action: 'sell',
    amountSol: trade.actualEntryAmountSol,
    errorMessage:
      'Live trade watchdog: on-chain token balance = 0 αλλά το trade δείχνει ακόμα open στη ' +
      'βάση μας, χωρίς ποτέ να καταγραφεί πραγματική πώληση — η θέση πιθανόν έκλεισε αλλού ' +
      '(χειροκίνητα, ή native order που δεν έχει συμφιλιωθεί ακόμα). Καμία αυτόματη ενέργεια.',
  });
  await markNeedsManualExit(trade.id);

  return {
    flagged: true,
    alert:
      `🕵️ watchdog: trade #${trade.id} (${short(trade.tokenAddress)}) δείχνει ακόμα open αλλά ` +
      `το on-chain balance είναι 0 — σημαδεύτηκε needs_manual_exit, δες /trades`,
  };
}

export async function runLiveTradeWatchdogCycle(): Promise<LiveTradeWatchdogResult> {
  const trades = await listAllOpenLiveTrades();
  const result: LiveTradeWatchdogResult = { checked: 0, flaggedForManualExit: 0, failures: 0, alerts: [] };
  if (trades.length === 0) return result;

  let walletAddress: string;
  try {
    walletAddress = (await fetchLiveSolWallet()).address;
  } catch (error) {
    // Ίδιο σκεπτικό με το per-trade catch παραπάνω: πριν, αυτό ήταν εξίσου σιωπηλό —
    // αν το `portfolio info` αρχίσει να αποτυγχάνει, ΟΛΟΚΛΗΡΟΣ ο κύκλος ακυρώνεται
    // επ' αόριστον χωρίς κανένα ίχνος πέρα από το αθροιστικό `failures=trades.length`.
    rethrowIfRateLimited(error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[live-trade-watchdog] fetchLiveSolWallet απέτυχε — παραλείπεται όλος ο κύκλος: ${errorMessage}`);
    result.failures = trades.length;
    return result;
  }

  for (const trade of trades) {
    result.checked += 1;
    try {
      const { flagged, alert } = await checkOneTrade(trade, walletAddress);
      if (flagged) result.flaggedForManualExit += 1;
      if (alert !== null) result.alerts.push(alert);
    } catch (error) {
      rethrowIfRateLimited(error);
      result.failures += 1;
    }
    await delay(LIVE_TRADE_WATCHDOG_LOOP_PACING_MS);
  }

  return result;
}
