import { db, type Queryable } from '../tx.js';
import { requireRow, toNum, toNumOrNull } from '../rows.js';
import type { Chain, ExitReason, TradeMode, TradeStatus } from '../types.js';

export interface NewPaperTrade {
  decisionLogId: number;
  tokenAddress: string;
  chain?: Chain;
  mode: TradeMode;
  intendedSizePct: number;
  bankrollAtEntry: number;
  simulatedEntryPrice: number;
  simulatedEntryAmountSol: number;
  /**
   * Τίμιο paper trading μοντελοποιεί καθυστέρηση και slippage — δεν υποθέτει instant
   * fill στην τιμή που είδαμε. Χωρίς αυτά, η Φάση 3 παράγει αισιόδοξα ψεύτικα νούμερα.
   */
  assumedSlippagePct: number;
  assumedLatencyMs: number;
  /** Το exit plan όπως μπήκε ΤΗ ΣΤΙΓΜΗ του entry, όχι όπως το θυμόμαστε μετά. Πάντα array
   * από order objects (π.χ. [{order_type:'profit_stop',...}, {...}]), ποτέ bare object. */
  conditionOrders?: readonly Record<string, unknown>[] | null;
  /** Πραγματικό SOL που πραγματικά ξοδεύτηκε (balance-diff, όχι υπόθεση) — ΜΟΝΟ για
   * mode='live'. undefined/NULL για paper/log_only, όπου δεν υπάρχει καμία πραγματική
   * συναλλαγή να μετρηθεί. Αντικαθιστά την ανάγκη για assumed_fees_pct σε live trades —
   * το πραγματικό pnl_sol υπολογίζεται απευθείας από αυτό, βλ. realtimeExitHandler.ts. */
  actualEntryAmountSol?: number;
  /** 2026-09-28 (migration 0019) — χρόνοι/τιμές της εισόδου, βλ. realtimeEntryHandler.ts. */
  entryTiming?: Record<string, unknown> | null;
  /** Η ΠΡΑΓΜΑΤΙΚΗ στιγμή της on-chain αγοράς (π.χ. buy.timestamp), ΟΧΙ πότε το
   * επεξεργαστήκαμε — undefined πέφτει σε now() (προεπιλογή, π.χ. αν δεν υπάρχει
   * διαθέσιμο ιστορικό timestamp). Κρίσιμο για catch-up batches: ένα wallet-activity
   * cycle που μόλις ξεμπλόκαρε μπορεί να γράψει δεκάδες signals μέσα σε δευτερόλεπτα
   * για αγορές που στην πραγματικότητα έγιναν σε διάστημα ημερών — entryAt=now() θα
   * τους έδινε πλασματικό, ταυτόσημο entry_at και θα καθυστερούσε λάθος το 24ωρο
   * timeout τους. Επιβεβαιωμένο real incident 2026-09-05.
   */
  entryAt?: Date;
}

/** Native GMGN strategy order id + health, γραμμένο ΜΕΤΑ το openTrade (χρειάζεται το
 * trade id να υπάρχει πρώτα) — βλ. `attachLiveNativeOrder` στο liveEntryExecution.ts. */
export interface NativeOrderState {
  liveStrategyOrderId: string | null;
  nativeOrderActive: boolean;
}

export interface PaperTrade {
  id: number;
  decisionLogId: number;
  tokenAddress: string;
  chain: string;
  mode: TradeMode;
  intendedSizePct: number | null;
  bankrollAtEntry: number | null;
  simulatedEntryPrice: number | null;
  entryAt: Date;
  status: TradeStatus;
  exitReason: ExitReason | null;
  simulatedExitPrice: number | null;
  exitAt: Date | null;
  pnlSol: number | null;
  pnlPct: number | null;
  pnlNetPct: number | null;
  /** Πότε το exit-resolver το εξέτασε τελευταία φορά — οδηγεί το rotation, βλ.
   * `selectOpenTradesForCheck`. ΔΙΑΦΟΡΕΤΙΚΟ από `entryAt` (πότε ανοίχτηκε). */
  lastCheckedAt: Date | null;
  actualEntryAmountSol: number | null;
  actualExitAmountSol: number | null;
  needsManualExit: boolean;
  exitAttemptStartedAt: Date | null;
  liveStrategyOrderId: string | null;
  nativeOrderActive: boolean;
  /** 2026-09-30: `entry_timing_json IS NOT NULL` — γράφεται ΜΟΝΟ από το realtime path
   * (από 28/9), άρα οι τιμές είναι σε SOL. Δεύτερη, ανεξάρτητη ένδειξη πέρα από το
   * `source_channel` του decision_log (που ένας discovery κύκλος μπορούσε να σβήσει — #6779). */
  hasEntryTiming?: boolean;
}

interface TradeRow {
  id: string;
  decision_log_id: string;
  token_address: string;
  chain: string;
  mode: TradeMode;
  intended_size_pct: string | null;
  bankroll_at_entry: string | null;
  simulated_entry_price: string | null;
  entry_at: Date;
  status: TradeStatus;
  exit_reason: ExitReason | null;
  simulated_exit_price: string | null;
  exit_at: Date | null;
  pnl_sol: string | null;
  pnl_pct: string | null;
  pnl_net_pct: string | null;
  last_checked_at: Date | null;
  actual_entry_amount_sol: string | null;
  actual_exit_amount_sol: string | null;
  needs_manual_exit: boolean;
  exit_attempt_started_at: Date | null;
  live_strategy_order_id: string | null;
  native_order_active: boolean;
  has_entry_timing?: boolean;
}

const COLUMNS = `id, decision_log_id, token_address, chain, mode, intended_size_pct,
                 bankroll_at_entry, simulated_entry_price, entry_at, status, exit_reason,
                 simulated_exit_price, exit_at, pnl_sol, pnl_pct, pnl_net_pct,
                 last_checked_at, actual_entry_amount_sol, actual_exit_amount_sol,
                 needs_manual_exit, exit_attempt_started_at, live_strategy_order_id,
                 native_order_active, (entry_timing_json IS NOT NULL) AS has_entry_timing`;

function toJsonParam(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function mapTrade(row: TradeRow): PaperTrade {
  return {
    id: toNum(row.id),
    decisionLogId: toNum(row.decision_log_id),
    tokenAddress: row.token_address,
    chain: row.chain,
    mode: row.mode,
    intendedSizePct: toNumOrNull(row.intended_size_pct),
    bankrollAtEntry: toNumOrNull(row.bankroll_at_entry),
    simulatedEntryPrice: toNumOrNull(row.simulated_entry_price),
    entryAt: row.entry_at,
    status: row.status,
    exitReason: row.exit_reason,
    simulatedExitPrice: toNumOrNull(row.simulated_exit_price),
    exitAt: row.exit_at,
    pnlSol: toNumOrNull(row.pnl_sol),
    pnlPct: toNumOrNull(row.pnl_pct),
    pnlNetPct: toNumOrNull(row.pnl_net_pct),
    lastCheckedAt: row.last_checked_at,
    actualEntryAmountSol: toNumOrNull(row.actual_entry_amount_sol),
    actualExitAmountSol: toNumOrNull(row.actual_exit_amount_sol),
    needsManualExit: row.needs_manual_exit,
    exitAttemptStartedAt: row.exit_attempt_started_at,
    liveStrategyOrderId: row.live_strategy_order_id,
    nativeOrderActive: row.native_order_active,
    hasEntryTiming: row.has_entry_timing === true,
  };
}

export async function openTrade(input: NewPaperTrade, conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ id: string }>(
    `INSERT INTO paper_trades (
       decision_log_id, token_address, chain, mode, intended_size_pct, bankroll_at_entry,
       simulated_entry_price, simulated_entry_amount_sol, assumed_slippage_pct,
       assumed_latency_ms, condition_orders_json, entry_at, actual_entry_amount_sol,
       entry_timing_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      input.decisionLogId,
      input.tokenAddress,
      input.chain ?? 'sol',
      input.mode,
      input.intendedSizePct,
      input.bankrollAtEntry,
      input.simulatedEntryPrice,
      input.simulatedEntryAmountSol,
      input.assumedSlippagePct,
      input.assumedLatencyMs,
      toJsonParam(input.conditionOrders),
      input.entryAt ?? new Date(),
      input.actualEntryAmountSol ?? null,
      input.entryTiming ? JSON.stringify(input.entryTiming) : null,
    ],
  );
  return toNum(requireRow(rows, 'openTrade').id);
}

/** Γράφει το αποτέλεσμα της απόπειρας attach+verify ενός native GMGN strategy order —
 * καλείται μία φορά, αμέσως μετά το openTrade (βλ. liveEntryExecution.ts). */
export async function setNativeOrderState(id: number, state: NativeOrderState, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `UPDATE paper_trades SET live_strategy_order_id = $2, native_order_active = $3 WHERE id = $1`,
    [id, state.liveStrategyOrderId, state.nativeOrderActive],
  );
}

/** Το reconciler γυρίζει native_order_active σε false όταν το strategy απέτυχε/σταμάτησε
 * χωρίς να κλείσει τη θέση — από εκεί και πέρα αναλαμβάνει πλήρως το δικό μας tracking
 * (decideForTick παύει να το αγνοεί). Ο ίδιος ο `live_strategy_order_id` ΜΕΝΕΙ (ιστορικό,
 * χρήσιμο για debugging) — μόνο το "ενεργό" flag αλλάζει. */
export async function deactivateNativeOrder(id: number, conn?: Queryable): Promise<void> {
  await db(conn).query(`UPDATE paper_trades SET native_order_active = false WHERE id = $1`, [id]);
}

export interface LiveTradeWithNativeOrder {
  id: number;
  tokenAddress: string;
  liveStrategyOrderId: string;
  entryAt: Date;
  bankrollAtEntry: number | null;
  intendedSizePct: number | null;
  actualEntryAmountSol: number | null;
  /** 2026-09-29 — για τιμή εξόδου = entry × πραγματικό ratio (βλ. live/ownSellRatio.ts). */
  simulatedEntryPrice: number | null;
}

/** Ανοιχτά `mode='live'` trades που έχουν ενεργό native order — τα μόνα που ο live
 * strategy reconciler χρειάζεται να ελέγξει (βλ. collectors/liveStrategyReconciler.ts).
 * Καθαρό DB read — το reconciler φέρνει το trading wallet address μία φορά για όλο το
 * batch (gmgn/portfolio.ts), όχι δουλειά του repository layer. */
export async function listOpenLiveTradesWithNativeOrder(conn?: Queryable): Promise<LiveTradeWithNativeOrder[]> {
  const { rows } = await db(conn).query<{
    id: string;
    token_address: string;
    live_strategy_order_id: string;
    entry_at: Date;
    bankroll_at_entry: string | null;
    intended_size_pct: string | null;
    actual_entry_amount_sol: string | null;
    simulated_entry_price: string | null;
  }>(
    `SELECT id, token_address, live_strategy_order_id, entry_at, bankroll_at_entry, intended_size_pct,
            actual_entry_amount_sol, simulated_entry_price
       FROM paper_trades
      WHERE status = 'open' AND mode = 'live' AND native_order_active = true
        AND live_strategy_order_id IS NOT NULL`,
  );
  return rows.map((row) => ({
    id: toNum(row.id),
    tokenAddress: row.token_address,
    liveStrategyOrderId: row.live_strategy_order_id,
    entryAt: row.entry_at,
    bankrollAtEntry: toNumOrNull(row.bankroll_at_entry),
    intendedSizePct: toNumOrNull(row.intended_size_pct),
    actualEntryAmountSol: toNumOrNull(row.actual_entry_amount_sol),
    simulatedEntryPrice: toNumOrNull(row.simulated_entry_price),
  }));
}

export interface OpenLiveTrade {
  id: number;
  tokenAddress: string;
  entryAt: Date;
  actualEntryAmountSol: number | null;
  needsManualExit: boolean;
  nativeOrderActive: boolean;
}

/**
 * ΟΛΑ τα ανοιχτά `mode='live'` trades, ΑΝΕΞΑΡΤΗΤΑ από `native_order_active` — σε αντίθεση
 * με `listOpenLiveTradesWithNativeOrder` πιο πάνω. Χρειάζεται για το γενικό on-chain
 * watchdog (`collectors/liveTradeWatchdog.ts`, 2026-09-17, incident #1193): μετά το
 * σημερινό fix του `selectOpenTradesForCheck` (πλέον αγνοεί mode='live' εντελώς), ΚΑΝΕΝΑ
 * περιοδικό δίχτυ ασφαλείας δεν κάλυπτε live trades ΧΩΡΙΣ ενεργό native order — μόνο το
 * realtime websocket path (χωρίς heartbeat/staleness ανίχνευση ακόμα) και ο
 * liveStrategyReconciler (μόνο native_order_active=true). Αυτό το query είναι το σύνολο
 * πάνω στο οποίο τρέχει το νέο, γενικό watchdog — δεν αγγίζει καθόλου `mode='paper'`/
 * `'log_only'` trades (αυτά συνεχίζουν κανονικά μέσω selectOpenTradesForCheck).
 */
export async function listAllOpenLiveTrades(conn?: Queryable): Promise<OpenLiveTrade[]> {
  const { rows } = await db(conn).query<{
    id: string;
    token_address: string;
    entry_at: Date;
    actual_entry_amount_sol: string | null;
    needs_manual_exit: boolean;
    native_order_active: boolean;
  }>(
    `SELECT id, token_address, entry_at, actual_entry_amount_sol, needs_manual_exit, native_order_active
       FROM paper_trades
      WHERE status = 'open' AND mode = 'live'`,
  );
  return rows.map((row) => ({
    id: toNum(row.id),
    tokenAddress: row.token_address,
    entryAt: row.entry_at,
    actualEntryAmountSol: toNumOrNull(row.actual_entry_amount_sol),
    needsManualExit: row.needs_manual_exit,
    nativeOrderActive: row.native_order_active,
  }));
}

export interface CloseTradeInput {
  exitReason: ExitReason;
  /** π.χ. ποιο wallet παρήγαγε το exit_signal. */
  exitTriggerDetail?: Record<string, unknown> | null;
  simulatedExitPrice: number;
  /** null όταν exitReason='no_market_data' — άγνωστο αποτέλεσμα, όχι μηδενικό. */
  pnlSol: number | null;
  pnlPct: number | null;
  assumedFeesPct: number;
  pnlNetPct: number | null;
  /** Πραγματικό SOL που πραγματικά εισπράχθηκε (balance-diff) — ΜΟΝΟ για mode='live'. */
  actualExitAmountSol?: number;
  /** Πραγματική στιγμή εξόδου όταν είναι γνωστή (π.χ. on-chain sell tx) — αλλιώς now(). */
  exitAt?: Date;
}

/**
 * Κλείνει ΜΟΝΟ ένα trade που είναι ακόμα `open`. Το `WHERE status = 'open'` κάνει την
 * κλήση idempotent: ένα διπλό exit-signal δεν ξαναγράφει το exit price ή το P&L.
 */
export async function closeTrade(
  id: number,
  input: CloseTradeInput,
  conn?: Queryable,
): Promise<boolean> {
  const result = await db(conn).query(
    `UPDATE paper_trades
        SET status = 'closed', exit_at = COALESCE($10, now()), exit_reason = $2,
            exit_trigger_detail_json = $3, simulated_exit_price = $4,
            pnl_sol = $5, pnl_pct = $6, assumed_fees_pct = $7, pnl_net_pct = $8,
            actual_exit_amount_sol = $9, needs_manual_exit = false,
            exit_attempt_started_at = NULL
      WHERE id = $1 AND status = 'open'`,
    [
      id,
      input.exitReason,
      toJsonParam(input.exitTriggerDetail),
      input.simulatedExitPrice,
      input.pnlSol,
      input.pnlPct,
      input.assumedFeesPct,
      input.pnlNetPct,
      input.actualExitAmountSol ?? null,
      input.exitAt ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * `limit` προαιρετικό — όταν δίνεται, τα παλαιότερα (κοντύτερα στο timeout, άρα πιο
 * επείγοντα να ελεγχθούν) πρώτα. Χωρίς αυτό, το exit-resolver χτυπάει ΟΛΑ τα ανοιχτά
 * trades σε ένα κύκλο· με πολλά ταυτόχρονα ανοιχτά (14-40+), αυτό βάζει υπερβολικό
 * φορτίο στο ήδη ευαίσθητο `/v1/user/wallet_activity` endpoint (επιβεβαιωμένο real
 * incident 2026-09-01, 8+ ώρες σταθερό 429 σε αυτό ειδικά, ενώ το wallet_stats endpoint
 * δούλευε άψογα παράλληλα — άρα per-endpoint όριο, όχι γενικό budget).
 */
export async function listOpenTrades(limit?: number, conn?: Queryable): Promise<PaperTrade[]> {
  const { rows } = await db(conn).query<TradeRow>(
    limit === undefined
      ? `SELECT ${COLUMNS} FROM paper_trades WHERE status = 'open' ORDER BY entry_at`
      : `SELECT ${COLUMNS} FROM paper_trades WHERE status = 'open' ORDER BY entry_at LIMIT $1`,
    limit === undefined ? [] : [limit],
  );
  return rows.map(mapTrade);
}

/**
 * Τα `limit` ανοιχτά trades που ΔΕΝ έχουν ελεγχθεί εδώ και περισσότερο καιρό —
 * `NULLS FIRST` σημαίνει ότι ένα ποτέ-μη-ελεγμένο trade έχει πάντα προτεραιότητα.
 *
 * ΟΧΙ `ORDER BY entry_at` (αυτό κάνει το `listOpenTrades`): επιβεβαιωμένο real incident
 * 2026-09-01, αν οι παλαιότερες θέσεις δεν είναι ακόμα κλείσιμες, ο ίδιος πυρήνας
 * "κολλημένων" trades επιλέγεται σε ΚΑΘΕ κύκλο — `open=51 closed=0` για 8 ώρες, ίδια 5
 * tokens κάθε φορά. Ίδιο pattern με `selectWalletsForActivityCheck` (migration 0005):
 * self-healing, καμία κατάσταση διεργασίας να χαθεί σε restart.
 */
/**
 * ΜΟΝΟ paper/log_only — ΠΟΤΕ mode='live' (κρίσιμη διόρθωση 2026-09-17, πραγματικό
 * incident): αυτό το periodic, GMGN-kline-based resolver υπολογίζει pnl με καθαρή
 * ΠΡΟΣΟΜΟΙΩΣΗ (computePnl, ποσοστιαία) — ΔΕΝ εκτελεί ποτέ πραγματικό swap. Πριν αυτή τη
 * διόρθωση, ΔΕΝ φιλτράριζε καθόλου με βάση το mode: ένα live trade που έφτανε εδώ
 * (π.χ. αν το realtime exit-handler δεν πρόλαβε πρώτο) κλεινόταν στη βάση μας με
 * φανταστικό, υποθετικό κέρδος — ΧΩΡΙΣ να πουληθεί ποτέ πραγματικά το token. Η
 * πραγματική θέση έμενε ανοιχτή on-chain, εντελώς εκτός παρακολούθησης, ενώ η βάση μας
 * έλεγε "closed". Επιβεβαιωμένο σε πραγματικό trade (#1193): DB έδειχνε +6431% κέρδος
 * (actual_exit_amount_sol=NULL — ποτέ δεν καταγράφηκε πραγματική πώληση), ενώ το ίδιο
 * το GMGN έδειχνε την πραγματική θέση ακόμα ανοιχτή, σε -52.5%. Τα live trades ΠΡΕΠΕΙ
 * να κλείνουν ΑΠΟΚΛΕΙΣΤΙΚΑ μέσω του realtimeExitHandler's πραγματικού swap path.
 */
export async function selectOpenTradesForCheck(
  limit: number,
  conn?: Queryable,
): Promise<PaperTrade[]> {
  const { rows } = await db(conn).query<TradeRow>(
    `SELECT ${COLUMNS} FROM paper_trades
      WHERE status = 'open' AND mode != 'live'
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  return rows.map(mapTrade);
}

/** Σφραγίζει ότι μόλις εξετάστηκε — ανεξάρτητα αν έκλεισε ή παρέμεινε ανοιχτό, γιατί το
 * rotation αφορά "πότε το είδαμε", όχι "τι βρήκαμε". */
export async function markTradeChecked(id: number, conn?: Queryable): Promise<void> {
  await db(conn).query(`UPDATE paper_trades SET last_checked_at = now() WHERE id = $1`, [id]);
}

/** Τροφοδοτεί το concurrent-positions cap. Το cap ζει στο decision engine, όχι εδώ. */
export async function countOpenTrades(conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ count: string }>(
    `SELECT count(*) AS count FROM paper_trades WHERE status = 'open'`,
  );
  return toNum(requireRow(rows, 'countOpenTrades').count);
}

/**
 * Ανοιχτά trades ΜΟΝΟ `live`/`paper` — για το open-trades cap των entry paths.
 *
 * 2026-09-27: τα `log_only` trades (GMGN smartmoney, ~30-60/ώρα, 24ωρο timeout) μετρούσαν
 * στο ίδιο cap (WALLET_ACTIVITY_MAX_OPEN_TRADES_BEFORE_PAUSE) με το realtime/live entry
 * path — ένας όγκος log_only trades μπορούσε να κόψει ΠΡΑΓΜΑΤΙΚΑ live entries με
 * `open_trades_cap`. Από την ίδια μέρα κανένα κανάλι δεν ανοίγει πια log_only, αλλά τα ήδη
 * ανοιχτά κλείνουν σταδιακά (έως 24h) — δεν πρέπει να μπλοκάρουν το live στο μεταξύ.
 */
export async function countOpenLiveOrPaperTrades(conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ count: string }>(
    `SELECT count(*) AS count FROM paper_trades WHERE status = 'open' AND mode IN ('live', 'paper')`,
  );
  return toNum(requireRow(rows, 'countOpenLiveOrPaperTrades').count);
}

/**
 * Πόσα ΑΛΛΑ ανοιχτά trades χρειάζονται ακόμα αυτό το token — για το realtime websocket
 * να ξέρει αν είναι ασφαλές να κάνει unsubscribe μετά το κλείσιμο ΕΝΟΣ trade (μπορεί να
 * υπάρχει κι άλλο, ξεχωριστό, ακόμα ανοιχτό στο ίδιο token).
 */
export async function countOpenTradesForToken(tokenAddress: string, conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ count: string }>(
    `SELECT count(*) AS count FROM paper_trades WHERE status = 'open' AND token_address = $1`,
    [tokenAddress],
  );
  return toNum(requireRow(rows, 'countOpenTradesForToken').count);
}

/** 2026-10-06 — όπως countOpenTradesForToken, αλλά χωρίς τα paper ΠΕΙΡΑΜΑΤΙΚΑ trades
 * (`entry_timing_json ? 'experiment'`): αυτά δεν μπλοκάρουν ποτέ κανονική είσοδο. */
export async function countOpenNonExperimentTradesForToken(tokenAddress: string, conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ count: string }>(
    `SELECT count(*) AS count FROM paper_trades
      WHERE status = 'open' AND token_address = $1
        AND NOT (COALESCE(entry_timing_json, '{}'::jsonb) ? 'experiment')`,
    [tokenAddress],
  );
  return toNum(requireRow(rows, 'countOpenNonExperimentTradesForToken').count);
}

export interface OpenTradeSubscriptionTarget {
  tokenAddress: string;
  triggerWalletAddress: string | null;
}

/**
 * Distinct (token, trigger wallet) ζευγάρια για ΟΛΑ τα ανοιχτά trades — χρησιμοποιείται
 * ΜΟΝΟ στο startup του realtime websocket, για να ξαναφτιάξει τις συνδρομές που
 * υπήρχαν πριν το τελευταίο restart (η σύνδεση ξεκινάει πάντα με μηδέν subscriptions,
 * ασχέτως τι υπήρχε στη βάση).
 */
export async function listOpenTradesWithWallet(
  conn?: Queryable,
): Promise<OpenTradeSubscriptionTarget[]> {
  const { rows } = await db(conn).query<{
    token_address: string;
    trigger_wallet_address: string | null;
  }>(
    `SELECT DISTINCT pt.token_address, dl.trigger_wallet_address
       FROM paper_trades pt
       JOIN decision_log dl ON dl.id = pt.decision_log_id
      WHERE pt.status = 'open'
         -- 2026-09-28: και ανοιχτά shadows (<24h), ώστε μετά από restart να συνεχίσουν να
         -- παίρνουν ticks ακόμα κι αν το πραγματικό trade έχει κλείσει.
         OR (pt.shadow_tracked AND pt.shadow_exit_at IS NULL AND pt.entry_at > now() - interval '24 hours')
         OR (pt.nosig_tracked AND pt.nosig_exit_at IS NULL AND pt.entry_at > now() - interval '24 hours')`
  );
  return rows.map((row) => ({
    tokenAddress: row.token_address,
    triggerWalletAddress: row.trigger_wallet_address,
  }));
}

export async function getTrade(id: number, conn?: Queryable): Promise<PaperTrade | null> {
  const { rows } = await db(conn).query<TradeRow>(
    `SELECT ${COLUMNS} FROM paper_trades WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? null : mapTrade(row);
}

export interface TradeSummary {
  id: number;
  tokenAddress: string;
  triggerWalletAddress: string | null;
  /** Το watchlist_wallets.name του trigger wallet, αν υπάρχει — βλ. migration 0008. */
  triggerWalletName: string | null;
  entryAt: Date;
  simulatedEntryPrice: number | null;
  simulatedEntryAmountSol: number | null;
  status: TradeStatus;
  exitReason: ExitReason | null;
  exitAt: Date | null;
  pnlPct: number | null;
}

/**
 * Για το `/trades` command — τι ήταν ένα signal, χωρίς να ανοίγεις τη βάση χειροκίνητα.
 * JOIN με `decision_log` για το trigger wallet, που δε ζει στο `paper_trades` (μία πηγή
 * αλήθειας — βλ. `getDecisionById`).
 */
export async function listRecentTrades(limit: number, conn?: Queryable): Promise<TradeSummary[]> {
  const { rows } = await db(conn).query<{
    id: string;
    token_address: string;
    trigger_wallet_address: string | null;
    trigger_wallet_name: string | null;
    entry_at: Date;
    simulated_entry_price: string | null;
    simulated_entry_amount_sol: string | null;
    status: TradeStatus;
    exit_reason: ExitReason | null;
    exit_at: Date | null;
    pnl_pct: string | null;
  }>(
    `SELECT t.id, t.token_address, d.trigger_wallet_address, w.name AS trigger_wallet_name,
            t.entry_at, t.simulated_entry_price, t.simulated_entry_amount_sol,
            t.status, t.exit_reason, t.exit_at, t.pnl_pct
       FROM paper_trades t
       JOIN decision_log d ON d.id = t.decision_log_id
       LEFT JOIN watchlist_wallets w ON w.address = d.trigger_wallet_address
      -- COALESCE(exit_at, entry_at): το πιο πρόσφατο ΓΕΓΟΝΟΣ, όχι πάντα το entry. Έτσι
      -- ένα trade που μόλις έκλεισε (ίσως ανοίχτηκε ώρες πριν) εμφανίζεται πρώτο — αυτό
      -- ζητήθηκε ρητά: μετά από ειδοποίηση "N trades έκλεισαν", το /trades πρέπει να
      -- δείχνει ΑΚΡΙΒΩΣ αυτά πρώτα, όχι να τα θάβει πίσω από νεότερα ανοίγματα.
      ORDER BY COALESCE(t.exit_at, t.entry_at) DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: toNum(row.id),
    tokenAddress: row.token_address,
    triggerWalletAddress: row.trigger_wallet_address,
    triggerWalletName: row.trigger_wallet_name,
    entryAt: row.entry_at,
    simulatedEntryPrice: toNumOrNull(row.simulated_entry_price),
    simulatedEntryAmountSol: toNumOrNull(row.simulated_entry_amount_sol),
    status: row.status,
    exitReason: row.exit_reason,
    exitAt: row.exit_at,
    pnlPct: toNumOrNull(row.pnl_pct),
  }));
}

export interface WalletLeaderboardEntry {
  address: string;
  /** Γνωστό όνομα κατόχου (migration 0008), NULL αν δεν το ξέρουμε. */
  name: string | null;
  /** ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #6): πριν, `no_market_data` (pnl_pct=NULL)
   * εξαιρούνταν εντελώς — αλλά αυτά είναι σχεδόν σίγουρες total losses (νεκρό/χωρίς
   * liquidity token), ΟΧΙ "δεν έχουμε ακόμα αποτέλεσμα". Εξαιρώντας τα, το win rate και
   * το μ.ο. pnl_pct διογκώνονταν τεχνητά. Τώρα μετράνε ΚΑΙ αυτά ΚΑΙ στο closedTrades ΚΑΙ
   * ως ζημιά στο winRate/avgPnlPct (βλ. SQL: COALESCE(pnl_pct, -1) στο AVG/SUM, ΔΕΝ
   * μετράνε ποτέ ως win). Το `noMarketDataTrades` παραμένει ξεχωριστό, ρητό bucket —
   * όχι κρυμμένο μέσα στο σύνολο χωρίς εξήγηση. */
  closedTrades: number;
  /** Πόσα από τα closedTrades ήταν `no_market_data` (νεκρό token, καμία τιμή ποτέ) —
   * υπο-σύνολο του closedTrades, ήδη μετρημένο ως ζημιά στα wins/totalPnlPct/avgPnlPct. */
  noMarketDataTrades: number;
  /** Πόσα ακόμα περιμένουν αποτέλεσμα — context, ΔΕΝ μετράει στα παρακάτω νούμερα. */
  openTrades: number;
  wins: number;
  /** Το ΔΙΚΟ ΜΑΣ αθροιστικό αποτέλεσμα σε SOL — εξαρτάται από το τρέχον
   * PAPER_BANKROLL_SOL (ακόμα placeholder τη στιγμή που γράφτηκε αυτό), ΟΧΙ από το
   * πραγματικό PnL του ίδιου του wallet στο GMGN. ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα
   * #6): τώρα μόνο mode IN ('paper','log_only') — πριν ανακάτευε πραγματικό live SOL με
   * υποθετικό paper SOL πάνω σε δύο διαφορετικές βάσεις μεγέθους θέσης. */
  totalProfitSol: number;
  /** Άθροισμα των pnl_pct — η ίδια πληροφορία με το SOL παραπάνω, χωρίς την εξάρτηση
   * από το bankroll assumption. */
  totalPnlPct: number;
  /** Μέσος όρος pnl_pct ανά trade — πόσο "τυπικό" είναι το αποτέλεσμα, λιγότερο
   * επηρεασμένο από το μέγεθος δείγματος απ' ό,τι το total. */
  avgPnlPct: number | null;
}

/**
 * ΔΙΚΟ ΜΑΣ αποτέλεσμα ακολουθώντας το σήμα κάθε wallet — ΟΧΙ το win_rate/pnl_multiplier
 * του ίδιου του wallet στο GMGN (αυτό ήδη υπάρχει στο `/watchlist`). Αυτό απαντάει σε
 * διαφορετική ερώτηση: "πόσο θα είχαμε κερδίσει/χάσει ΕΜΕΙΣ, ακολουθώντας το."
 *
 * Ταξινόμηση κατά total_profit_sol DESC — "ποιο wallet μας έβγαλε τα περισσότερα".
 */
export async function getWalletLeaderboard(
  limit: number,
  conn?: Queryable,
): Promise<WalletLeaderboardEntry[]> {
  const { rows } = await db(conn).query<{
    address: string;
    name: string | null;
    closed_trades: string;
    no_market_data_trades: string;
    open_trades: string;
    wins: string;
    total_profit_sol: string;
    total_pnl_pct: string;
    avg_pnl_pct: string | null;
  }>(
    // ΔΙΟΡΘΩΣΗ 2026-09-17 (review εύρημα #6):
    //  - `mode IN ('paper','log_only')` — αυτό το leaderboard απαντάει "πόσο θα
    //    είχαμε κερδίσει/χάσει ΕΜΕΙΣ υποθετικά ακολουθώντας το wallet" (βλ. σχόλιο
    //    στο interface πιο πάνω) — mode='live' έχει ΔΙΚΟ ΤΟΥ πραγματικό κεφάλαιο σε
    //    διαφορετική βάση μεγέθους θέσης, δε μπελέκει εδώ.
    //  - COALESCE(pt.pnl_pct, -1) στο wins/SUM/AVG: ένα `no_market_data` trade δεν έχει
    //    ΠΟΤΕ pnl_pct, αλλά είναι σχεδόν σίγουρη ολική ζημιά (νεκρό/χωρίς liquidity
    //    token) — πριν εξαιρούνταν εντελώς, διογκώνοντας τεχνητά win rate/avg pnl.
    //    Το -1 (=-100%) το μετράει ως πλήρη ζημιά χωρίς να χρειάζεται μαντεμένο ποσοστό.
    `SELECT dl.trigger_wallet_address AS address,
            w.name,
            COUNT(*) FILTER (WHERE pt.status = 'closed') AS closed_trades,
            COUNT(*) FILTER (WHERE pt.status = 'closed' AND pt.pnl_pct IS NULL) AS no_market_data_trades,
            COUNT(*) FILTER (WHERE pt.status = 'open') AS open_trades,
            COUNT(*) FILTER (WHERE pt.status = 'closed' AND pt.pnl_pct > 0) AS wins,
            COALESCE(SUM(pt.pnl_sol) FILTER (WHERE pt.status = 'closed'), 0) AS total_profit_sol,
            COALESCE(SUM(COALESCE(pt.pnl_pct, -1)) FILTER (WHERE pt.status = 'closed'), 0) AS total_pnl_pct,
            AVG(COALESCE(pt.pnl_pct, -1)) FILTER (WHERE pt.status = 'closed') AS avg_pnl_pct
       FROM paper_trades pt
       JOIN decision_log dl ON dl.id = pt.decision_log_id
       LEFT JOIN watchlist_wallets w ON w.address = dl.trigger_wallet_address
      WHERE dl.trigger_wallet_address IS NOT NULL
        AND pt.mode IN ('paper', 'log_only')
      GROUP BY dl.trigger_wallet_address, w.name
     HAVING COUNT(*) FILTER (WHERE pt.status = 'closed') > 0
      ORDER BY total_profit_sol DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    address: row.address,
    name: row.name,
    closedTrades: toNum(row.closed_trades),
    noMarketDataTrades: toNum(row.no_market_data_trades),
    openTrades: toNum(row.open_trades),
    wins: toNum(row.wins),
    totalProfitSol: toNum(row.total_profit_sol),
    totalPnlPct: toNum(row.total_pnl_pct),
    avgPnlPct: toNumOrNull(row.avg_pnl_pct),
  }));
}

export interface OpenTradeForTick {
  id: number;
  simulatedEntryPrice: number;
  entryAt: Date;
  bankrollAtEntry: number | null;
  intendedSizePct: number | null;
  peakPriceSinceEntry: number | null;
  trailingActive: boolean;
  triggerWalletAddress: string | null;
  mode: TradeMode;
  actualEntryAmountSol: number | null;
  needsManualExit: boolean;
  exitAttemptStartedAt: Date | null;
  /** true όταν ένα native GMGN strategy order είναι ακόμα συνδεδεμένο σε αυτό το trade
   * — βλ. migration 0013. ΔΕΝ αλλάζει τη λογική του `decideForTick` (ρητή απόφαση
   * χρήστη 2026-09-17, ίδια μέρα με το incident: ο δικός μας tracker παραμένει
   * πρωτεύων, ίδια λογική με το paper trading, ΧΩΡΙΣ εξαίρεση εδώ) — μόνο σηματοδοτεί
   * ότι υπάρχει ακόμα ένα ασφαλιστικό native order να ακυρωθεί πριν από τη δική μας
   * πώληση (executeLiveCloseAndFinalize), και ότι ο live strategy reconciler
   * (collectors/liveStrategyReconciler.ts) πρέπει να το παρακολουθεί. */
  nativeOrderActive: boolean;
  liveStrategyOrderId: string | null;
  /** 2026-10-06: paper πείραμα (`entry_timing_json ? 'experiment'`) — κλείνει χωρίς Telegram. */
  isExperiment?: boolean;
}

/**
 * Μόνο τα IDs ανοιχτών trades πάνω σε ΕΝΑ token — γρήγορο, ΧΩΡΙΣ lock, μόνο για να
 * ξέρουμε ΠΟΙΑ trades θα μπορούσαν να μας ενδιαφέρουν σε ένα εισερχόμενο realtime event.
 * Το πραγματικό, κλειδωμένο fetch γίνεται ανά-trade μέσω `getOpenTradeForTickLocked`,
 * μέσα σε transaction — βλ. εκεί για το γιατί χρειάζεται lock.
 */
export async function listOpenTradeIdsForToken(tokenAddress: string, conn?: Queryable): Promise<number[]> {
  const { rows } = await db(conn).query<{ id: string }>(
    `SELECT id FROM paper_trades WHERE status = 'open' AND token_address = $1
       AND simulated_entry_price IS NOT NULL AND simulated_entry_price > 0`,
    [tokenAddress],
  );
  return rows.map((row) => toNum(row.id));
}

/**
 * ΚΛΕΙΔΩΜΕΝΗ (`FOR UPDATE`) ανάγνωση ΕΝΟΣ trade — ΠΡΕΠΕΙ να καλείται μέσα σε
 * transaction (περνάει το `client`, ΟΧΙ optional). Πραγματικό incident 2026-09-09: ένα
 * δραστήριο token μπορεί να δώσει πολλά ticks μέσα σε δευτερόλεπτα· χωρίς lock, δύο
 * ταυτόχρονα ticks θα μπορούσαν να διαβάσουν το ΙΔΙΟ (μπαγιάτικο) peak/trailing state,
 * και το δεύτερο write θα "έσβηνε" σιωπηλά το πρώτο (lost update) — π.χ. ένα πραγματικό
 * νέο peak να χαθεί, κάνοντας το trailing_stop να πυροδοτήσει σε λάθος σημείο. Το
 * `FOR UPDATE` κάνει το δεύτερο tick να ΠΕΡΙΜΕΝΕΙ μέχρι να τελειώσει το πρώτο transaction,
 * βλέποντας μετά το φρέσκο, ενημερωμένο state — όχι μπαγιάτικο.
 *
 * Επιστρέφει null αν το trade έκλεισε ήδη (periodic exit-resolver, ή προηγούμενο tick)
 * ή δεν πληροί πια τα κριτήρια — ο caller απλά δεν κάνει τίποτα σε αυτή την περίπτωση.
 */
export async function getOpenTradeForTickLocked(
  id: number,
  client: Queryable,
): Promise<OpenTradeForTick | null> {
  const { rows } = await db(client).query<{
    id: string;
    simulated_entry_price: string;
    entry_at: Date;
    bankroll_at_entry: string | null;
    intended_size_pct: string | null;
    peak_price_since_entry: string | null;
    trailing_active: boolean;
    trigger_wallet_address: string | null;
    mode: TradeMode;
    actual_entry_amount_sol: string | null;
    needs_manual_exit: boolean;
    exit_attempt_started_at: Date | null;
    native_order_active: boolean;
    live_strategy_order_id: string | null;
    is_experiment: boolean | null;
  }>(
    `SELECT pt.id, pt.simulated_entry_price, pt.entry_at, pt.bankroll_at_entry,
            pt.intended_size_pct, pt.peak_price_since_entry, pt.trailing_active,
            dl.trigger_wallet_address, pt.mode, pt.actual_entry_amount_sol,
            pt.needs_manual_exit, pt.exit_attempt_started_at, pt.native_order_active,
            pt.live_strategy_order_id,
            COALESCE(pt.entry_timing_json ? 'experiment', false) AS is_experiment
       FROM paper_trades pt
       JOIN decision_log dl ON dl.id = pt.decision_log_id
      WHERE pt.id = $1 AND pt.status = 'open'
        AND pt.simulated_entry_price IS NOT NULL AND pt.simulated_entry_price > 0
      FOR UPDATE OF pt`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: toNum(row.id),
    simulatedEntryPrice: toNum(row.simulated_entry_price),
    entryAt: row.entry_at,
    bankrollAtEntry: toNumOrNull(row.bankroll_at_entry),
    intendedSizePct: toNumOrNull(row.intended_size_pct),
    peakPriceSinceEntry: toNumOrNull(row.peak_price_since_entry),
    trailingActive: row.trailing_active,
    triggerWalletAddress: row.trigger_wallet_address,
    mode: row.mode,
    actualEntryAmountSol: toNumOrNull(row.actual_entry_amount_sol),
    needsManualExit: row.needs_manual_exit,
    exitAttemptStartedAt: row.exit_attempt_started_at,
    nativeOrderActive: row.native_order_active,
    liveStrategyOrderId: row.live_strategy_order_id,
    isExperiment: row.is_experiment === true,
  };
}

/** Γράφει το νέο live state ΜΕΤΑ από ένα tick που δεν έκλεισε τη θέση — ώστε το επόμενο
 * tick να ξεκινήσει από το σωστό σημείο (βλ. tickExit.ts). */
export async function updateTickState(
  id: number,
  peakPriceSinceEntry: number,
  trailingActive: boolean,
  conn?: Queryable,
): Promise<void> {
  await db(conn).query(
    `UPDATE paper_trades SET peak_price_since_entry = $2, trailing_active = $3 WHERE id = $1`,
    [id, peakPriceSinceEntry, trailingActive],
  );
}

/** Σημαδεύει ότι μια πραγματική απόπειρα πώλησης μόλις ξεκίνησε — πριν αφήσουμε το lock
 * (βλ. σχόλιο στο migration 0011). Ένα δεύτερο, ταυτόχρονο tick στο ίδιο ενεργό token
 * το βλέπει αυτό και ΔΕΝ προσπαθεί δική του πώληση, όσο είναι ακόμα πρόσφατο. */
export async function markExitAttemptStarted(id: number, conn?: Queryable): Promise<void> {
  await db(conn).query(`UPDATE paper_trades SET exit_attempt_started_at = now() WHERE id = $1`, [id]);
}

/** Μια πραγματική πώληση απέτυχε — η θέση παραμένει ανοιχτή, χρειάζεται χειροκίνητη
 * προσοχή. Το αυτόματο exit-checking παραλείπει κάθε trade με αυτό ενεργό. */
export async function markNeedsManualExit(id: number, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `UPDATE paper_trades SET needs_manual_exit = true, exit_attempt_started_at = NULL WHERE id = $1`,
    [id],
  );
}

/**
 * Τα `limit` πιο πρόσφατα ΚΛΕΙΣΜΕΝΑ `mode='live'` trades, νεότερο πρώτα — για το
 * kill-switch (μέτρημα συνεχόμενων ζημιών, βλ. liveRiskGate.ts). ΜΟΝΟ `live`, ΟΧΙ
 * `paper`/`log_only` — μια κακή σειρά υποθετικών trades δεν πρέπει ποτέ να σταματήσει
 * πραγματικό trading, ούτε το αντίστροφο έχει νόημα.
 *
 * ΔΙΟΡΘΩΣΗ 2026-09-27, πραγματικό incident: μετά από `/resume_live`, το ΕΠΟΜΕΝΟ
 * `checkLiveRiskGate` ξαναέβρισκε τα ΙΔΙΑ παλιά κλεισμένα trades που είχαν ήδη
 * ενεργοποιήσει το πρώτο halt, και ξανακλείδωνε ΑΜΕΣΩΣ, χωρίς να έχει μεσολαβήσει κανένα
 * νέο live trade — `/resume_live` γινόταν άχρηστο. `sinceExitAt`, όταν δίνεται, αγνοεί
 * trades που έκλεισαν ΠΡΙΝ από αυτή τη στιγμή (το τελευταίο χειροκίνητο resume) — το
 * σερί μετράει ΜΟΝΟ ό,τι έγινε μετά. `undefined`/χωρίς όρισμα = παλιά συμπεριφορά
 * (μέτρα σε όλο το ιστορικό) — χρησιμοποιείται όταν δεν έχει γίνει ποτέ resume ακόμα.
 */
export async function getRecentClosedLiveTrades(
  limit: number,
  sinceExitAt?: Date,
  conn?: Queryable,
): Promise<{ pnlSol: number | null }[]> {
  const { rows } = await db(conn).query<{ pnl_sol: string | null }>(
    `SELECT pnl_sol FROM paper_trades
      WHERE mode = 'live' AND status = 'closed'
        AND ($2::timestamptz IS NULL OR exit_at >= $2)
      ORDER BY exit_at DESC
      LIMIT $1`,
    [limit, sinceExitAt ?? null],
  );
  return rows.map((row) => ({ pnlSol: toNumOrNull(row.pnl_sol) }));
}

/**
 * Άθροισμα ΜΟΝΟ των ζημιών (όχι καθαρό pnl — τα κέρδη δεν "αγοράζουν πίσω" χώρο κάτω
 * από το όριο, ίδιο σκεπτικό με το GMGN reference demo) για `mode='live'` trades που
 * έκλεισαν "σήμερα" σε ώρα Αθήνας — ίδιο boundary convention με το daily digest.
 */
export async function getTodayRealizedLossSol(startOfAthensDay: Date, conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ realized_loss: string }>(
    `SELECT COALESCE(SUM(GREATEST(-pnl_sol, 0)), 0) AS realized_loss
       FROM paper_trades
      WHERE mode = 'live' AND status = 'closed' AND exit_at >= $1`,
    [startOfAthensDay],
  );
  return toNum(requireRow(rows, 'getTodayRealizedLossSol').realized_loss);
}

// --- Shadow δοκιμές (καμία δεν επηρεάζει πραγματική έξοδο) ---
//  '4b'    — 2026-09-28, migration 0017, στήλες shadow_*: trailing με grace + επιβεβαίωση.
//  'nosig' — 2026-09-29, migration 0020, στήλες nosig_*: σημερινή λογική ΧΩΡΙΣ exit_signal.
// Τα ονόματα στηλών βγαίνουν ΜΟΝΟ από αυτόν τον σταθερό πίνακα (όχι από input).

export type ShadowVariant = '4b' | 'nosig';
export const SHADOW_VARIANTS: readonly ShadowVariant[] = ['4b', 'nosig'];
const SHADOW_PREFIX: Readonly<Record<ShadowVariant, 'shadow' | 'nosig'>> = { '4b': 'shadow', nosig: 'nosig' };

/** Ενεργοποιεί ΟΛΕΣ τις shadow καταγραφές για ένα νέο trade (καλείται αμέσως μετά το openTrade). */
export async function enableShadowTracking(id: number, conn?: Queryable): Promise<void> {
  await db(conn).query(`UPDATE paper_trades SET shadow_tracked = true, nosig_tracked = true WHERE id = $1`, [id]);
}

/** IDs με ανοιχτό shadow αυτού του variant σε αυτό το token — είτε το πραγματικό trade είναι ανοιχτό είτε όχι. */
export async function listShadowOpenTradeIdsForToken(
  tokenAddress: string,
  conn?: Queryable,
  variant: ShadowVariant = '4b',
): Promise<number[]> {
  const c = SHADOW_PREFIX[variant];
  const { rows } = await db(conn).query<{ id: string }>(
    `SELECT id FROM paper_trades
      WHERE token_address = $1 AND ${c}_tracked AND ${c}_exit_at IS NULL
        AND simulated_entry_price IS NOT NULL AND simulated_entry_price > 0`,
    [tokenAddress],
  );
  return rows.map((row) => toNum(row.id));
}

export interface ShadowTradeForTick {
  id: number;
  tokenAddress: string;
  status: string;
  entryPrice: number;
  entryAt: Date;
  triggerWalletAddress: string | null;
  peak: number | null;
  trailingActive: boolean;
  breachSince: Date | null;
}

/** ΚΛΕΙΔΩΜΕΝΗ ανάγνωση του shadow state — μέσα σε transaction, ίδιο σκεπτικό με getOpenTradeForTickLocked. */
export async function getShadowTradeLocked(
  id: number,
  client: Queryable,
  variant: ShadowVariant = '4b',
): Promise<ShadowTradeForTick | null> {
  const c = SHADOW_PREFIX[variant];
  const { rows } = await db(client).query<{
    id: string;
    token_address: string;
    status: string;
    simulated_entry_price: string;
    entry_at: Date;
    trigger_wallet_address: string | null;
    peak_price: string | null;
    trailing_active: boolean;
    breach_since: Date | null;
  }>(
    `SELECT pt.id, pt.token_address, pt.status, pt.simulated_entry_price, pt.entry_at,
            dl.trigger_wallet_address, pt.${c}_peak_price AS peak_price,
            pt.${c}_trailing_active AS trailing_active, pt.${c}_breach_since AS breach_since
       FROM paper_trades pt
       JOIN decision_log dl ON dl.id = pt.decision_log_id
      WHERE pt.id = $1 AND pt.${c}_tracked AND pt.${c}_exit_at IS NULL
        AND pt.simulated_entry_price IS NOT NULL AND pt.simulated_entry_price > 0
      FOR UPDATE OF pt`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: toNum(row.id),
    tokenAddress: row.token_address,
    status: row.status,
    entryPrice: toNum(row.simulated_entry_price),
    entryAt: row.entry_at,
    triggerWalletAddress: row.trigger_wallet_address,
    peak: toNumOrNull(row.peak_price),
    trailingActive: row.trailing_active,
    breachSince: row.breach_since,
  };
}

export async function updateShadowState(
  id: number,
  state: { peak: number | null; trailingActive: boolean; breachSince: Date | null },
  conn?: Queryable,
  variant: ShadowVariant = '4b',
): Promise<void> {
  const c = SHADOW_PREFIX[variant];
  await db(conn).query(
    `UPDATE paper_trades
        SET ${c}_peak_price = $2, ${c}_trailing_active = $3, ${c}_breach_since = $4
      WHERE id = $1 AND ${c}_exit_at IS NULL`,
    [id, state.peak, state.trailingActive, state.breachSince],
  );
}

/** Κλείνει το shadow (idempotent — δεν ξαναγράφει ένα ήδη κλεισμένο shadow). */
export async function closeShadow(
  id: number,
  reason: string,
  price: number | null,
  conn?: Queryable,
  variant: ShadowVariant = '4b',
): Promise<boolean> {
  const c = SHADOW_PREFIX[variant];
  const result = await db(conn).query(
    `UPDATE paper_trades
        SET ${c}_exit_reason = $2, ${c}_exit_price = $3, ${c}_exit_at = now()
      WHERE id = $1 AND ${c}_exit_at IS NULL`,
    [id, reason, price],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Πόσα trades χρειάζονται ακόμα ticks γι' αυτό το token: ανοιχτά πραγματικά trades ΚΑΙ
 * ανοιχτά shadows (τα shadows συνεχίζουν μετά την πραγματική έξοδο — γι' αυτό υπάρχουν).
 * Για το unsubscribe· ΟΧΙ για το "ένα trade ανά token" (εκεί μετράει μόνο το πραγματικό).
 */
export async function countTradesNeedingTicksForToken(tokenAddress: string, conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ count: string }>(
    `SELECT count(*) AS count FROM paper_trades
      WHERE token_address = $1
        AND (status = 'open'
             OR (shadow_tracked AND shadow_exit_at IS NULL)
             OR (nosig_tracked AND nosig_exit_at IS NULL))`,
    [tokenAddress],
  );
  return toNum(requireRow(rows, 'countTradesNeedingTicksForToken').count);
}

/**
 * Shadows ανοιχτά πάνω από 24h (π.χ. νεκρό token, κανένα tick πια) → κλείνουν ως
 * 'timeout' ΧΩΡΙΣ τιμή (άγνωστη — τα reports τα μετράνε ως unresolved). Επιστρέφει τα
 * tokens ώστε ο caller να κάνει unsubscribe όσα δεν χρειάζονται πια.
 */
export async function expireStaleShadows(conn?: Queryable): Promise<string[]> {
  const tokens = new Set<string>();
  for (const variant of SHADOW_VARIANTS) {
    const c = SHADOW_PREFIX[variant];
    const { rows } = await db(conn).query<{ token_address: string }>(
      `UPDATE paper_trades
          SET ${c}_exit_reason = 'timeout', ${c}_exit_price = NULL, ${c}_exit_at = now()
        WHERE ${c}_tracked AND ${c}_exit_at IS NULL
          AND entry_at < now() - interval '24 hours'
        RETURNING token_address`,
    );
    for (const r of rows) tokens.add(r.token_address);
  }
  return [...tokens];
}

/** 2026-10-09: ανοιχτές live θέσεις (για το LIVE_MAX_OPEN_POSITIONS). */
export async function countOpenLiveTrades(conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ n: string }>(
    `SELECT count(*) AS n FROM paper_trades WHERE status = 'open' AND mode = 'live'`,
  );
  return toNum(rows[0]?.n ?? '0');
}
