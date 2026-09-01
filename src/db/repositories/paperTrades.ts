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
}

const COLUMNS = `id, decision_log_id, token_address, chain, mode, intended_size_pct,
                 bankroll_at_entry, simulated_entry_price, entry_at, status, exit_reason,
                 simulated_exit_price, exit_at, pnl_sol, pnl_pct, pnl_net_pct,
                 last_checked_at`;

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
  };
}

export async function openTrade(input: NewPaperTrade, conn?: Queryable): Promise<number> {
  const { rows } = await db(conn).query<{ id: string }>(
    `INSERT INTO paper_trades (
       decision_log_id, token_address, chain, mode, intended_size_pct, bankroll_at_entry,
       simulated_entry_price, simulated_entry_amount_sol, assumed_slippage_pct,
       assumed_latency_ms, condition_orders_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
    ],
  );
  return toNum(requireRow(rows, 'openTrade').id);
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
        SET status = 'closed', exit_at = now(), exit_reason = $2,
            exit_trigger_detail_json = $3, simulated_exit_price = $4,
            pnl_sol = $5, pnl_pct = $6, assumed_fees_pct = $7, pnl_net_pct = $8
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
export async function selectOpenTradesForCheck(
  limit: number,
  conn?: Queryable,
): Promise<PaperTrade[]> {
  const { rows } = await db(conn).query<TradeRow>(
    `SELECT ${COLUMNS} FROM paper_trades
      WHERE status = 'open'
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
    entry_at: Date;
    simulated_entry_price: string | null;
    simulated_entry_amount_sol: string | null;
    status: TradeStatus;
    exit_reason: ExitReason | null;
    exit_at: Date | null;
    pnl_pct: string | null;
  }>(
    `SELECT t.id, t.token_address, d.trigger_wallet_address, t.entry_at,
            t.simulated_entry_price, t.simulated_entry_amount_sol,
            t.status, t.exit_reason, t.exit_at, t.pnl_pct
       FROM paper_trades t
       JOIN decision_log d ON d.id = t.decision_log_id
      ORDER BY t.entry_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    id: toNum(row.id),
    tokenAddress: row.token_address,
    triggerWalletAddress: row.trigger_wallet_address,
    entryAt: row.entry_at,
    simulatedEntryPrice: toNumOrNull(row.simulated_entry_price),
    simulatedEntryAmountSol: toNumOrNull(row.simulated_entry_amount_sol),
    status: row.status,
    exitReason: row.exit_reason,
    exitAt: row.exit_at,
    pnlPct: toNumOrNull(row.pnl_pct),
  }));
}
