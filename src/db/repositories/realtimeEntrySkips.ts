import { db, type Queryable } from '../tx.js';

/** Βλ. migration 0022. Μία εγγραφή ανά αγορά δικού μας wallet που δεν έγινε trade. */
export interface RealtimeEntrySkip {
  walletAddress: string;
  tokenAddress: string;
  reason: string;
  pool: string | null;
  hasCurveData: boolean;
  solAmount: number | null;
  marketCapSol: number | null;
  detail?: Record<string, unknown> | null;
}

export async function insertRealtimeEntrySkip(skip: RealtimeEntrySkip, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `INSERT INTO realtime_entry_skips
       (wallet_address, token_address, reason, pool, has_curve_data, sol_amount, market_cap_sol, detail_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      skip.walletAddress,
      skip.tokenAddress,
      skip.reason,
      skip.pool,
      skip.hasCurveData,
      skip.solAmount,
      skip.marketCapSol,
      skip.detail ? JSON.stringify(skip.detail) : null,
    ],
  );
}
