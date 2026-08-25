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
  /** Το exit plan όπως μπήκε ΤΗ ΣΤΙΓΜΗ του entry, όχι όπως το θυμόμαστε μετά. */
  conditionOrders?: Record<string, unknown> | null;
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
}

const COLUMNS = `id, decision_log_id, token_address, chain, mode, intended_size_pct,
                 bankroll_at_entry, simulated_entry_price, entry_at, status, exit_reason,
                 simulated_exit_price, exit_at, pnl_sol, pnl_pct, pnl_net_pct`;

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
      input.conditionOrders ?? null,
    ],
  );
  return toNum(requireRow(rows, 'openTrade').id);
}

export interface CloseTradeInput {
  exitReason: ExitReason;
  /** π.χ. ποιο wallet παρήγαγε το exit_signal. */
  exitTriggerDetail?: Record<string, unknown> | null;
  simulatedExitPrice: number;
  pnlSol: number;
  pnlPct: number;
  assumedFeesPct: number;
  pnlNetPct: number;
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
      input.exitTriggerDetail ?? null,
      input.simulatedExitPrice,
      input.pnlSol,
      input.pnlPct,
      input.assumedFeesPct,
      input.pnlNetPct,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listOpenTrades(conn?: Queryable): Promise<PaperTrade[]> {
  const { rows } = await db(conn).query<TradeRow>(
    `SELECT ${COLUMNS} FROM paper_trades WHERE status = 'open' ORDER BY entry_at`,
  );
  return rows.map(mapTrade);
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
