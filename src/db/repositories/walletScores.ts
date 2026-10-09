import { db, type Queryable } from '../tx.js';
import { toNum, toNumOrNull } from '../rows.js';
import { CLEAN_SINCE, type ScoringTrade, type WalletScore, type WalletScoreStatus } from '../../decision/walletScore.js';

/** migration 0026 — βλ. decision/walletScore.ts. */

/** Όλα τα κλειστά trades από CLEAN_SINCE (χωρίς πείραμα) με το wallet που έδωσε το σήμα. */
export async function listTradesForScoring(conn?: Queryable): Promise<ScoringTrade[]> {
  const { rows } = await db(conn).query<{ wallet: string; net: string; closed_at: Date; mode: string; slip: string | null }>(
    `SELECT d.trigger_wallet_address AS wallet, p.pnl_net_pct AS net, p.exit_at AS closed_at, p.mode,
            p.entry_timing_json->>'slippage_vs_signal' AS slip
       FROM paper_trades p JOIN decision_log d ON d.id = p.decision_log_id
      WHERE p.status = 'closed' AND p.pnl_net_pct IS NOT NULL AND p.exit_at IS NOT NULL
        AND p.entry_at >= $1 AND d.trigger_wallet_address IS NOT NULL
        AND p.entry_timing_json IS NOT NULL AND NOT (p.entry_timing_json ? 'experiment')`,
    [CLEAN_SINCE],
  );
  return rows.map((r) => ({ wallet: r.wallet, netRet: toNum(r.net), closedAt: r.closed_at, mode: r.mode, liveSlippage: toNumOrNull(r.slip) }));
}

export async function upsertWalletScores(scores: readonly WalletScore[], conn?: Queryable): Promise<void> {
  for (const s of scores) {
    await db(conn).query(
      `INSERT INTO wallet_scores (wallet_address, trades, wins, weight, pnl_sol, mean_ret, sd_ret, lcb_ret, ucb_ret, slippage, status, reason, last_trade_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (wallet_address) DO UPDATE SET
         trades = EXCLUDED.trades, wins = EXCLUDED.wins, weight = EXCLUDED.weight, pnl_sol = EXCLUDED.pnl_sol,
         mean_ret = EXCLUDED.mean_ret, sd_ret = EXCLUDED.sd_ret, lcb_ret = EXCLUDED.lcb_ret, ucb_ret = EXCLUDED.ucb_ret,
         slippage = EXCLUDED.slippage, status = EXCLUDED.status, reason = EXCLUDED.reason,
         last_trade_at = EXCLUDED.last_trade_at, updated_at = now()`,
      [s.wallet, s.trades, s.wins, s.weight, s.pnlSol, s.mean, s.sd, s.lcb, s.ucb, s.slippage, s.status, s.reason, s.lastTradeAt],
    );
  }
}

export interface StoredWalletScore {
  mean: number;
  sd: number;
  lcb: number;
  status: WalletScoreStatus;
  trades: number;
}

export async function getWalletScore(address: string, conn?: Queryable): Promise<StoredWalletScore | null> {
  const { rows } = await db(conn).query<{ mean_ret: string; sd_ret: string; lcb_ret: string; status: WalletScoreStatus; trades: number }>(
    `SELECT mean_ret, sd_ret, lcb_ret, status, trades FROM wallet_scores WHERE wallet_address = $1`,
    [address],
  );
  const r = rows[0];
  return r === undefined
    ? null
    : { mean: toNum(r.mean_ret), sd: toNum(r.sd_ret), lcb: toNum(r.lcb_ret), status: r.status, trades: r.trades };
}

/** Μπλοκαρισμένα από τη βαθμολογία, που είναι ακόμα ενεργά στη watchlist (εκτός mirror). */
export async function deactivateBlockedWallets(conn?: Queryable): Promise<string[]> {
  const { rows } = await db(conn).query<{ address: string }>(
    `UPDATE watchlist_wallets w SET active = false, deactivated_reason = 'scored_out'
       FROM wallet_scores s
      WHERE s.wallet_address = w.address AND s.status = 'blocked' AND w.active AND w.copy_mode <> 'mirror'
      RETURNING w.address`,
  );
  return rows.map((r) => r.address);
}

/** Κάθε αγορά ενός wallet μας: η πρώτη ανά token κρατάει ώρα και βαθμολογία, οι επόμενες μετράνε. */
export async function recordWalletTokenBuy(tokenAddress: string, walletAddress: string, solAmount: number, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `INSERT INTO wallet_token_buys (token_address, wallet_address, sol_total, first_sol, score_mean, score_status)
     SELECT $1, $2, $3, $3, s.mean_ret, s.status
       FROM (SELECT 1) one LEFT JOIN wallet_scores s ON s.wallet_address = $2
     ON CONFLICT (token_address, wallet_address) DO UPDATE
       SET buys = wallet_token_buys.buys + 1, sol_total = wallet_token_buys.sol_total + EXCLUDED.sol_total, last_seen_at = now()`,
    [tokenAddress, walletAddress, solAmount],
  );
}

export interface Consensus {
  /** Διαφορετικά wallets μας που αγόρασαν το token στα τελευταία N λεπτά (μαζί με αυτό του σήματος). */
  wallets: number;
  /** Από αυτά, πόσα έχουν θετική εκτίμηση (mean > 0) τη στιγμή της αγοράς τους. */
  positive: number;
  /** … και πόσα ήταν 'proven'. */
  proven: number;
}

export async function tokenConsensus(tokenAddress: string, minutes: number, conn?: Queryable): Promise<Consensus> {
  const { rows } = await db(conn).query<{ wallets: string; positive: string; proven: string }>(
    `SELECT count(*) AS wallets,
            count(*) FILTER (WHERE score_mean > 0) AS positive,
            count(*) FILTER (WHERE score_status = 'proven') AS proven
       FROM wallet_token_buys
      WHERE token_address = $1 AND first_seen_at > now() - make_interval(mins => $2)`,
    [tokenAddress, minutes],
  );
  const r = rows[0]!;
  return { wallets: toNum(r.wallets), positive: toNum(r.positive), proven: toNum(r.proven) };
}
