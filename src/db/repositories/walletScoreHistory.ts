import { db, type Queryable } from '../tx.js';
import { toNum, toNumOrNull } from '../rows.js';

export interface WalletScoreEntry {
  id: number;
  walletAddress: string;
  recordedAt: Date;
  winRate: number | null;
  pnlMultiplier: number | null;
  tradeCount: number | null;
}

interface ScoreRow {
  id: string;
  wallet_address: string;
  recorded_at: Date;
  win_rate: string | null;
  pnl_multiplier: string | null;
  trade_count: number | null;
}

function mapScore(row: ScoreRow): WalletScoreEntry {
  return {
    id: toNum(row.id),
    walletAddress: row.wallet_address,
    recordedAt: row.recorded_at,
    winRate: toNumOrNull(row.win_rate),
    pnlMultiplier: toNumOrNull(row.pnl_multiplier),
    tradeCount: row.trade_count,
  };
}

export interface NewWalletScore {
  walletAddress: string;
  winRate: number | null;
  pnlMultiplier: number | null;
  tradeCount: number | null;
}

/**
 * Append-only. Κρατάμε ιστορικό ώστε το `/score` να δείχνει **τάση** και όχι στιγμιότυπο —
 * ένα wallet που πέφτει από 0.7 σε 0.55 είναι διαφορετική περίπτωση από ένα σταθερό 0.55.
 */
export async function insertScore(
  input: NewWalletScore,
  conn?: Queryable,
): Promise<void> {
  await db(conn).query(
    `INSERT INTO wallet_score_history (wallet_address, win_rate, pnl_multiplier, trade_count)
     VALUES ($1,$2,$3,$4)`,
    [input.walletAddress, input.winRate, input.pnlMultiplier, input.tradeCount],
  );
}

/** Batch insert — το `portfolio profits` γυρίζει έως 100 wallets σε ένα call. */
export async function insertScores(
  inputs: readonly NewWalletScore[],
  conn?: Queryable,
): Promise<void> {
  if (inputs.length === 0) return;
  await db(conn).query(
    `INSERT INTO wallet_score_history (wallet_address, win_rate, pnl_multiplier, trade_count)
     SELECT * FROM UNNEST($1::text[], $2::numeric[], $3::numeric[], $4::integer[])`,
    [
      inputs.map((i) => i.walletAddress),
      inputs.map((i) => i.winRate),
      inputs.map((i) => i.pnlMultiplier),
      inputs.map((i) => i.tradeCount),
    ],
  );
}

/** Πιο πρόσφατα πρώτα — για το trend display του `/score`. */
export async function recentScores(
  walletAddress: string,
  limit = 10,
  conn?: Queryable,
): Promise<WalletScoreEntry[]> {
  const { rows } = await db(conn).query<ScoreRow>(
    `SELECT id, wallet_address, recorded_at, win_rate, pnl_multiplier, trade_count
       FROM wallet_score_history
      WHERE wallet_address = $1
      ORDER BY recorded_at DESC
      LIMIT $2`,
    [walletAddress, limit],
  );
  return rows.map(mapScore);
}
