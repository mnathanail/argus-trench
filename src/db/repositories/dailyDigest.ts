import { db, type Queryable } from '../tx.js';
import { toNum } from '../rows.js';

export interface BestWorstTrade {
  tokenAddress: string;
  pnlPct: number;
  exitReason: string | null;
}

export interface ManualExitTrade {
  id: number;
  tokenAddress: string;
  actualEntryAmountSol: number | null;
}

/**
 * ΜΟΝΟ mode='live' — ρητή απόφαση χρήστη 2026-09-16: "δεν με ενδιαφέρει τι έχει γίνει
 * στα χαρτιά ... θέλω να ξέρω ακριβώς τι έχει γίνει με τα πραγματικά χρήματα". Τα paper/
 * log_only trades συνεχίζουν να καταγράφονται κανονικά (για δεδομένα/ανάλυση), απλά δεν
 * εμφανίζονται πια σε αυτή τη συγκεκριμένη αναφορά.
 */
export interface DailyDigestData {
  openedToday: number;
  closedToday: number;
  winsToday: number;
  lossesToday: number;
  /** Πραγματικό SOL κέρδος/ζημιά — άθροισμα του πραγματικού pnl_sol (βλ.
   * actual_entry/exit_amount_sol, migration 0011), ΟΧΙ ποσοστιαία παραδοχή. */
  profitSolToday: number;
  /** Πραγματικό SOL που ξοδεύτηκε σε νέες θέσεις σήμερα — actual_entry_amount_sol,
   * ΟΧΙ το ονομαστικό, προγραμματισμένο μέγεθος (LIVE_POSITION_SIZE_SOL). */
  deployedSolToday: number;
  bestToday: BestWorstTrade | null;
  worstToday: BestWorstTrade | null;
  openAll: number;
  closedAll: number;
  profitSolAll: number;
  /** Trades που περιμένουν χειροκίνητη προσοχή ΤΩΡΑ (needs_manual_exit=true) — ό,τι κι
   * αν συνέβη σήμερα ή παλιότερα, πρέπει να φαίνεται πάντα σε αυτή την αναφορά μέχρι να
   * λυθεί, ώστε να μην ξεχαστεί μια ανοιχτή, πραγματική θέση σε πρόβλημα. */
  needsManualExit: ManualExitTrade[];
}

export async function getDailyDigestData(
  dayStart: Date,
  dayEnd: Date,
  conn?: Queryable,
): Promise<DailyDigestData> {
  const c = db(conn);

  const todayCounts = await c.query<{
    opened_today: string;
    closed_today: string;
    wins_today: string;
    losses_today: string;
    profit_sol_today: string;
    deployed_sol_today: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE entry_at >= $1 AND entry_at < $2) AS opened_today,
       COUNT(*) FILTER (WHERE exit_at >= $1 AND exit_at < $2) AS closed_today,
       COUNT(*) FILTER (WHERE exit_at >= $1 AND exit_at < $2 AND pnl_sol > 0) AS wins_today,
       COUNT(*) FILTER (WHERE exit_at >= $1 AND exit_at < $2 AND pnl_sol <= 0) AS losses_today,
       COALESCE(SUM(pnl_sol) FILTER (WHERE exit_at >= $1 AND exit_at < $2), 0) AS profit_sol_today,
       COALESCE(SUM(actual_entry_amount_sol) FILTER (WHERE entry_at >= $1 AND entry_at < $2), 0) AS deployed_sol_today
     FROM paper_trades
     WHERE mode = 'live'`,
    [dayStart, dayEnd],
  );

  const best = await c.query<{ token_address: string; pnl_pct: string; exit_reason: string | null }>(
    `SELECT token_address, pnl_pct, exit_reason FROM paper_trades
      WHERE mode = 'live' AND exit_at >= $1 AND exit_at < $2 AND pnl_pct IS NOT NULL
      ORDER BY pnl_pct DESC LIMIT 1`,
    [dayStart, dayEnd],
  );
  const worst = await c.query<{ token_address: string; pnl_pct: string; exit_reason: string | null }>(
    `SELECT token_address, pnl_pct, exit_reason FROM paper_trades
      WHERE mode = 'live' AND exit_at >= $1 AND exit_at < $2 AND pnl_pct IS NOT NULL
      ORDER BY pnl_pct ASC LIMIT 1`,
    [dayStart, dayEnd],
  );

  const allTime = await c.query<{ open_all: string; closed_all: string; profit_sol_all: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open') AS open_all,
       COUNT(*) FILTER (WHERE status = 'closed') AS closed_all,
       COALESCE(SUM(pnl_sol) FILTER (WHERE status = 'closed'), 0) AS profit_sol_all
     FROM paper_trades
     WHERE mode = 'live'`,
  );

  const manualExit = await c.query<{ id: string; token_address: string; actual_entry_amount_sol: string | null }>(
    `SELECT id, token_address, actual_entry_amount_sol FROM paper_trades
      WHERE mode = 'live' AND needs_manual_exit = true
      ORDER BY entry_at ASC`,
  );

  const tc = todayCounts.rows[0];
  const at = allTime.rows[0];
  if (tc === undefined || at === undefined) {
    throw new Error('getDailyDigestData: αναπάντεχα άδειο resultset σε aggregate query');
  }

  return {
    openedToday: toNum(tc.opened_today),
    closedToday: toNum(tc.closed_today),
    winsToday: toNum(tc.wins_today),
    lossesToday: toNum(tc.losses_today),
    profitSolToday: toNum(tc.profit_sol_today),
    deployedSolToday: toNum(tc.deployed_sol_today),
    bestToday: best.rows[0]
      ? {
          tokenAddress: best.rows[0].token_address,
          pnlPct: toNum(best.rows[0].pnl_pct),
          exitReason: best.rows[0].exit_reason,
        }
      : null,
    worstToday: worst.rows[0]
      ? {
          tokenAddress: worst.rows[0].token_address,
          pnlPct: toNum(worst.rows[0].pnl_pct),
          exitReason: worst.rows[0].exit_reason,
        }
      : null,
    openAll: toNum(at.open_all),
    closedAll: toNum(at.closed_all),
    profitSolAll: toNum(at.profit_sol_all),
    needsManualExit: manualExit.rows.map((r) => ({
      id: toNum(r.id),
      tokenAddress: r.token_address,
      actualEntryAmountSol: r.actual_entry_amount_sol === null ? null : toNum(r.actual_entry_amount_sol),
    })),
  };
}
