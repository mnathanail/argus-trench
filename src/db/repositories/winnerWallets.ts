import { db, type Queryable } from '../tx.js';
import { toNum, toNumOrNull } from '../rows.js';

/**
 * migration 0025 — wallets που κέρδισαν σε τοπ tokens (collectors/winnerWallets.ts).
 */

export interface WinnerHit {
  walletAddress: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenAthUsd: number | null;
  multiple: number;
  profitUsd: number | null;
  costUsd: number | null;
  entryMin: number | null;
}

/** Νέο hit ή ανανέωση (το × / κέρδος αλλάζει όσο το token τρέχει). `first_seen_at` μένει. */
export async function upsertWinnerHit(hit: WinnerHit, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `INSERT INTO wallet_winner_hits (wallet_address, token_address, token_symbol, token_ath_usd, multiple, profit_usd, cost_usd, entry_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (wallet_address, token_address) DO UPDATE
       SET token_ath_usd = EXCLUDED.token_ath_usd, multiple = EXCLUDED.multiple, profit_usd = EXCLUDED.profit_usd,
           cost_usd = EXCLUDED.cost_usd, entry_min = EXCLUDED.entry_min, updated_at = now()`,
    [hit.walletAddress, hit.tokenAddress, hit.tokenSymbol, hit.tokenAthUsd, hit.multiple, hit.profitUsd, hit.costUsd, hit.entryMin],
  );
}

export async function recordWinnerTokenScan(
  token: { address: string; symbol: string | null; athUsd: number | null; createdAtUnix: number | null },
  tradersSeen: number,
  hits: number,
  conn?: Queryable,
): Promise<void> {
  await db(conn).query(
    `INSERT INTO winner_tokens (token_address, token_symbol, ath_usd, created_at_unix, traders_seen, hits, scanned_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (token_address) DO UPDATE
       SET ath_usd = EXCLUDED.ath_usd, traders_seen = EXCLUDED.traders_seen, hits = EXCLUDED.hits, scanned_at = now()`,
    [token.address, token.symbol, token.athUsd, token.createdAtUnix === null ? null : Math.round(token.createdAtUnix), tradersSeen, hits],
  );
}

/** Tokens που σαρώθηκαν μέσα στις τελευταίες `hours` ώρες. */
export async function listRecentlyScannedTokens(addresses: readonly string[], hours: number, conn?: Queryable): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const { rows } = await db(conn).query<{ token_address: string }>(
    `SELECT token_address FROM winner_tokens
      WHERE token_address = ANY($1::text[]) AND scanned_at > now() - make_interval(hours => $2)`,
    [addresses, hours],
  );
  return new Set(rows.map((r) => r.token_address));
}

export interface WinnerScore {
  address: string;
  /** Διαφορετικά τοπ tokens όπου κέρδισε. */
  tokens: number;
  maxMultiple: number;
  totalProfitUsd: number;
}

/** Hits των τελευταίων `days` ημερών (κατά `first_seen_at`), ανά wallet. */
export async function listWinnerScores(days: number, conn?: Queryable): Promise<WinnerScore[]> {
  const { rows } = await db(conn).query<{ wallet_address: string; tokens: string; max_multiple: string; total_profit: string | null }>(
    `SELECT wallet_address, count(*) AS tokens, max(multiple) AS max_multiple, sum(profit_usd) AS total_profit
       FROM wallet_winner_hits
      WHERE first_seen_at > now() - make_interval(days => $1)
      GROUP BY 1`,
    [days],
  );
  return rows.map((r) => ({
    address: r.wallet_address,
    tokens: toNum(r.tokens),
    maxMultiple: toNum(r.max_multiple),
    totalProfitUsd: toNumOrNull(r.total_profit) ?? 0,
  }));
}

/** Wallets που αποδείχτηκαν με ΔΙΚΑ ΜΑΣ trades: ≥ `minTrades` κλειστά σε `days` μέρες με θετικό σύνολο
 * (χωρίς τα trades του πειράματος). */
export async function listProvenWallets(days: number, minTrades: number, conn?: Queryable): Promise<Set<string>> {
  const { rows } = await db(conn).query<{ address: string }>(
    `SELECT d.trigger_wallet_address AS address
       FROM paper_trades p JOIN decision_log d ON d.id = p.decision_log_id
      WHERE p.status = 'closed' AND p.pnl_sol IS NOT NULL
        AND p.entry_at > now() - make_interval(days => $1)
        AND d.trigger_wallet_address IS NOT NULL
        AND NOT COALESCE(p.entry_timing_json ? 'experiment', false)
      GROUP BY 1
     HAVING count(*) >= $2 AND sum(p.pnl_sol) > 0`,
    [days, minTrades],
  );
  return new Set(rows.map((r) => r.address));
}

export interface WalletStatusRow {
  address: string;
  active: boolean;
  source: string;
  deactivatedReason: string | null;
  copyMode: string;
}

export async function listWalletStatuses(conn?: Queryable): Promise<WalletStatusRow[]> {
  const { rows } = await db(conn).query<{ address: string; active: boolean; source: string; deactivated_reason: string | null; copy_mode: string }>(
    `SELECT address, active, source, deactivated_reason, copy_mode FROM watchlist_wallets`,
  );
  return rows.map((r) => ({ address: r.address, active: r.active, source: r.source, deactivatedReason: r.deactivated_reason, copyMode: r.copy_mode }));
}

/**
 * Νέο wallet → INSERT (`winner_trader`, active). Υπάρχον → active ξανά (`winner_trader`, εκτός αν
 * είναι manual — εκείνο κρατάει το source του). Ποτέ για wallet που έκανε ο χρήστης /unwatch
 * (`deactivated_reason='manual'`) — το φιλτράρει ήδη ο caller, και το WHERE ξανά εδώ.
 * true = άλλαξε κάτι.
 */
export async function activateWinnerWallet(address: string, avgHoldingSec: number | null, conn?: Queryable): Promise<boolean> {
  const result = await db(conn).query(
    `INSERT INTO watchlist_wallets (address, chain, source, active, avg_holding_sec)
     VALUES ($1, 'sol', 'winner_trader', true, $2)
     ON CONFLICT (address) DO UPDATE
       SET active = true, deactivated_reason = NULL,
           source = CASE WHEN watchlist_wallets.source = 'manual' THEN watchlist_wallets.source ELSE 'winner_trader' END,
           avg_holding_sec = COALESCE(EXCLUDED.avg_holding_sec, watchlist_wallets.avg_holding_sec)
     WHERE watchlist_wallets.deactivated_reason IS DISTINCT FROM 'manual'
       AND (NOT watchlist_wallets.active OR watchlist_wallets.source NOT IN ('manual', 'winner_trader'))`,
    [address, avgHoldingSec],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Απενεργοποίηση ως 'curated' (καμία διαγραφή· /watch τα ξαναβάζει). */
export async function deactivateCurated(addresses: readonly string[], conn?: Queryable): Promise<number> {
  if (addresses.length === 0) return 0;
  const result = await db(conn).query(
    `UPDATE watchlist_wallets SET active = false, deactivated_reason = 'curated'
      WHERE address = ANY($1::text[]) AND active AND source <> 'manual' AND copy_mode <> 'mirror'`,
    [addresses],
  );
  return result.rowCount ?? 0;
}
