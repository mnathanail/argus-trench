import { db, type Queryable } from '../tx.js';
import { toNum } from '../rows.js';

/**
 * "Σήμερα" = ημερολογιακή μέρα ΑΘΗΝΑΣ, όχι UTC — standard Postgres idiom:
 * `now() AT TIME ZONE 'Europe/Athens'` δίνει το τοπικό wall-clock (ως naive timestamp),
 * `date_trunc('day', ...)` το κόβει σε μεσάνυχτα, και το δεύτερο `AT TIME ZONE` το
 * ξαναγυρίζει σε πραγματικό timestamptz ερμηνεύοντας το ως τοπική ώρα Αθήνας. Σωστό και
 * τις μέρες αλλαγής ώρας — το tzdata του ίδιου του Postgres το ξέρει ήδη.
 */
const ATHENS_DAY_START_SQL = `date_trunc('day', now() AT TIME ZONE 'Europe/Athens') AT TIME ZONE 'Europe/Athens'`;

export interface BestWorstTrade {
  tokenAddress: string;
  pnlPct: number;
  exitReason: string | null;
}

export interface DailyDigestData {
  openedToday: number;
  closedToday: number;
  winsToday: number;
  lossesToday: number;
  profitSolToday: number;
  profitPctToday: number;
  deployedSolToday: number;
  bestToday: BestWorstTrade | null;
  worstToday: BestWorstTrade | null;
  openAll: number;
  closedAll: number;
  profitSolAll: number;
  profitPctAll: number;
  walletsActive: number;
  walletsAutoDeactivated: number;
}

/**
 * Πολλά απλά queries αντί για ένα γιγάντιο CTE — τρέχει μία φορά τη μέρα, η απλότητα και
 * η ευκολία επαλήθευσης αξίζουν παραπάνω από την απόδοση εδώ.
 */
export async function getDailyDigestData(conn?: Queryable): Promise<DailyDigestData> {
  const c = db(conn);

  const todayCounts = await c.query<{
    opened_today: string;
    closed_today: string;
    wins_today: string;
    losses_today: string;
    profit_sol_today: string;
    profit_pct_today: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE entry_at >= ${ATHENS_DAY_START_SQL}) AS opened_today,
       COUNT(*) FILTER (WHERE exit_at >= ${ATHENS_DAY_START_SQL}) AS closed_today,
       COUNT(*) FILTER (WHERE exit_at >= ${ATHENS_DAY_START_SQL} AND pnl_pct > 0) AS wins_today,
       COUNT(*) FILTER (WHERE exit_at >= ${ATHENS_DAY_START_SQL} AND pnl_pct <= 0) AS losses_today,
       COALESCE(SUM(pnl_sol) FILTER (WHERE exit_at >= ${ATHENS_DAY_START_SQL}), 0) AS profit_sol_today,
       COALESCE(SUM(pnl_pct) FILTER (WHERE exit_at >= ${ATHENS_DAY_START_SQL}), 0) AS profit_pct_today
     FROM paper_trades`,
  );

  const deployed = await c.query<{ deployed_sol_today: string }>(
    `SELECT COALESCE(SUM(simulated_entry_amount_sol) FILTER (WHERE entry_at >= ${ATHENS_DAY_START_SQL}), 0) AS deployed_sol_today
       FROM paper_trades`,
  );

  const best = await c.query<{ token_address: string; pnl_pct: string; exit_reason: string | null }>(
    `SELECT token_address, pnl_pct, exit_reason FROM paper_trades
      WHERE exit_at >= ${ATHENS_DAY_START_SQL} AND pnl_pct IS NOT NULL
      ORDER BY pnl_pct DESC LIMIT 1`,
  );
  const worst = await c.query<{ token_address: string; pnl_pct: string; exit_reason: string | null }>(
    `SELECT token_address, pnl_pct, exit_reason FROM paper_trades
      WHERE exit_at >= ${ATHENS_DAY_START_SQL} AND pnl_pct IS NOT NULL
      ORDER BY pnl_pct ASC LIMIT 1`,
  );

  const allTime = await c.query<{
    open_all: string;
    closed_all: string;
    profit_sol_all: string;
    profit_pct_all: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open') AS open_all,
       COUNT(*) FILTER (WHERE status = 'closed') AS closed_all,
       COALESCE(SUM(pnl_sol) FILTER (WHERE status = 'closed'), 0) AS profit_sol_all,
       COALESCE(SUM(pnl_pct) FILTER (WHERE status = 'closed'), 0) AS profit_pct_all
     FROM paper_trades`,
  );

  const wallets = await c.query<{ active: boolean; deactivated_reason: string | null; count: string }>(
    `SELECT active, deactivated_reason, COUNT(*) as count
       FROM watchlist_wallets
      GROUP BY active, deactivated_reason`,
  );
  const walletsActive = wallets.rows
    .filter((r) => r.active)
    .reduce((sum, r) => sum + toNum(r.count), 0);
  const walletsAutoDeactivated = wallets.rows
    .filter((r) => !r.active && r.deactivated_reason === 'below_threshold')
    .reduce((sum, r) => sum + toNum(r.count), 0);

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
    profitPctToday: toNum(tc.profit_pct_today),
    deployedSolToday: toNum(deployed.rows[0]?.deployed_sol_today ?? '0'),
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
    profitPctAll: toNum(at.profit_pct_all),
    walletsActive,
    walletsAutoDeactivated,
  };
}
