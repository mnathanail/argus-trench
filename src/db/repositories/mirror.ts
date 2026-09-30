import { db, type Queryable } from '../tx.js';
import { toNum, toNumOrNull } from '../rows.js';
import type { MirrorPositionState } from '../../mirror/mirrorDecision.js';

/** migration 0023 — MIRROR route. Όλες οι τιμές σε SOL (PumpPortal), όχι USD. */

interface PositionRow {
  id: string;
  wallet_address: string;
  tokens_held: string;
  sol_in: string;
  sol_out: string;
  target_tokens_est: string | null;
  last_price_sol: string | null;
}

const POSITION_COLUMNS = 'id, wallet_address, tokens_held, sol_in, sol_out, target_tokens_est, last_price_sol';

function mapPosition(row: PositionRow): MirrorPositionState {
  return {
    id: toNum(row.id),
    walletAddress: row.wallet_address,
    tokensHeld: toNum(row.tokens_held),
    solIn: toNum(row.sol_in),
    solOut: toNum(row.sol_out),
    targetTokensEst: toNumOrNull(row.target_tokens_est),
    lastPriceSol: toNumOrNull(row.last_price_sol),
  };
}

/** Η ανοιχτή θέση του token (μία το πολύ — unique index), κλειδωμένη για το τρέχον transaction. */
export async function getOpenMirrorPositionForUpdate(tokenAddress: string, conn?: Queryable): Promise<MirrorPositionState | null> {
  const { rows } = await db(conn).query<PositionRow>(
    `SELECT ${POSITION_COLUMNS} FROM mirror_positions WHERE token_address = $1 AND status = 'open' FOR UPDATE`,
    [tokenAddress],
  );
  return rows[0] === undefined ? null : mapPosition(rows[0]);
}

export async function mirrorEventExists(signature: string, walletAddress: string, conn?: Queryable): Promise<boolean> {
  const { rows } = await db(conn).query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM mirror_events WHERE signature = $1 AND wallet_address = $2) AS exists',
    [signature, walletAddress],
  );
  return rows[0]?.exists === true;
}

export async function openMirrorPosition(
  input: { walletAddress: string; tokenAddress: string; mode: 'paper' | 'live' },
  conn?: Queryable,
): Promise<number> {
  const { rows } = await db(conn).query<{ id: string }>(
    `INSERT INTO mirror_positions (wallet_address, token_address, mode) VALUES ($1, $2, $3) RETURNING id`,
    [input.walletAddress, input.tokenAddress, input.mode],
  );
  return toNum(rows[0]!.id);
}

/** Εφαρμόζει μία αγορά/πώληση στη θέση (αθροιστικά). */
export async function applyMirrorFill(
  input: {
    positionId: number;
    side: 'buy' | 'sell';
    sol: number;
    tokens: number;
    priceSol: number;
    targetTokensEst: number;
  },
  conn?: Queryable,
): Promise<void> {
  const buy = input.side === 'buy';
  await db(conn).query(
    `UPDATE mirror_positions
        SET sol_in            = sol_in + $2,
            sol_out           = sol_out + $3,
            tokens_held       = GREATEST(tokens_held + $4, 0),
            buy_count         = buy_count + $5,
            sell_count        = sell_count + $6,
            target_tokens_est = $7,
            last_price_sol    = $8
      WHERE id = $1`,
    [
      input.positionId,
      buy ? input.sol : 0,
      buy ? 0 : input.sol,
      buy ? input.tokens : -input.tokens,
      buy ? 1 : 0,
      buy ? 0 : 1,
      input.targetTokensEst,
      input.priceSol,
    ],
  );
}

export async function closeMirrorPosition(
  input: { positionId: number; pnlSol: number; pnlPct: number | null; reason: string },
  conn?: Queryable,
): Promise<{ solIn: number; solOut: number; buyCount: number; sellCount: number }> {
  const { rows } = await db(conn).query<{ sol_in: string; sol_out: string; buy_count: number; sell_count: number }>(
    `UPDATE mirror_positions
        SET status = 'closed', closed_at = now(), tokens_held = 0,
            pnl_sol = $2, pnl_pct = $3, close_reason = $4
      WHERE id = $1
      RETURNING sol_in, sol_out, buy_count, sell_count`,
    [input.positionId, input.pnlSol, input.pnlPct, input.reason],
  );
  const r = rows[0]!;
  return { solIn: toNum(r.sol_in), solOut: toNum(r.sol_out), buyCount: r.buy_count, sellCount: r.sell_count };
}

export async function getMirrorPositionTotals(positionId: number, conn?: Queryable): Promise<{ solIn: number; solOut: number }> {
  const { rows } = await db(conn).query<{ sol_in: string; sol_out: string }>(
    'SELECT sol_in, sol_out FROM mirror_positions WHERE id = $1',
    [positionId],
  );
  return { solIn: toNum(rows[0]!.sol_in), solOut: toNum(rows[0]!.sol_out) };
}

export interface MirrorEventInsert {
  walletAddress: string;
  tokenAddress: string;
  txType: string;
  signature: string;
  solAmount: number | null;
  tokenAmount: number | null;
  newTokenBalance: number | null;
  pool: string | null;
  priceSol: number | null;
  action: string;
  positionId: number | null;
  ourSol: number | null;
  ourTokens: number | null;
  sellPct: number | null;
  detail: Record<string, unknown> | null;
}

/** ON CONFLICT DO NOTHING (ίδιο signature+wallet ξανά, π.χ. μετά από reconnect). false = υπήρχε ήδη. */
export async function insertMirrorEvent(e: MirrorEventInsert, conn?: Queryable): Promise<boolean> {
  const result = await db(conn).query(
    `INSERT INTO mirror_events
       (wallet_address, token_address, tx_type, signature, sol_amount, token_amount, new_token_balance,
        pool, price_sol, action, position_id, our_sol, our_tokens, sell_pct, detail_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (signature, wallet_address) DO NOTHING`,
    [
      e.walletAddress,
      e.tokenAddress,
      e.txType,
      e.signature,
      e.solAmount,
      e.tokenAmount,
      e.newTokenBalance,
      e.pool,
      e.priceSol,
      e.action,
      e.positionId,
      e.ourSol,
      e.ourTokens,
      e.sellPct,
      e.detail ? JSON.stringify(e.detail) : null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface MirrorWalletSummary {
  address: string;
  name: string | null;
  openPositions: number;
  closedPositions: number;
  wins: number;
  pnlSol: number;
}

/** Για το /mirrors: κάθε mirror wallet με τα αποτελέσματά του. */
export async function mirrorWalletSummaries(conn?: Queryable): Promise<MirrorWalletSummary[]> {
  const { rows } = await db(conn).query<{ address: string; name: string | null; open: string; closed: string; wins: string; pnl: string | null }>(
    `SELECT w.address, w.name,
            count(p.id) FILTER (WHERE p.status = 'open')                    AS open,
            count(p.id) FILTER (WHERE p.status = 'closed')                  AS closed,
            count(p.id) FILTER (WHERE p.status = 'closed' AND p.pnl_sol > 0) AS wins,
            sum(p.pnl_sol) FILTER (WHERE p.status = 'closed')               AS pnl
       FROM watchlist_wallets w
       LEFT JOIN mirror_positions p ON p.wallet_address = w.address
      WHERE w.copy_mode = 'mirror'
      GROUP BY w.address, w.name, w.added_at
      ORDER BY w.added_at`,
  );
  return rows.map((r) => ({
    address: r.address,
    name: r.name,
    openPositions: toNum(r.open),
    closedPositions: toNum(r.closed),
    wins: toNum(r.wins),
    pnlSol: r.pnl === null ? 0 : toNum(r.pnl),
  }));
}

/** Wallets που ΔΕΝ είναι πια mirror αλλά έχουν ακόμα ανοιχτή mirror θέση (μετά από /unmirror):
 * οι πωλήσεις τους συνεχίζουν να αντιγράφονται ώστε οι θέσεις να κλείσουν κανονικά. */
export async function listWalletsWithOpenMirrorPositions(conn?: Queryable): Promise<string[]> {
  const { rows } = await db(conn).query<{ wallet_address: string }>(
    `SELECT DISTINCT wallet_address FROM mirror_positions WHERE status = 'open'`,
  );
  return rows.map((r) => r.wallet_address);
}
