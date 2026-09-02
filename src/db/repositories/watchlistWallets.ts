import { db, type Queryable } from '../tx.js';
import { requireRow, toNum, toNumOrNull } from '../rows.js';
import type { Chain, WalletSource } from '../types.js';

export interface WatchlistWallet {
  id: number;
  address: string;
  chain: string;
  source: WalletSource;
  winRate: number | null;
  pnlMultiplier: number | null;
  tradeCount: number | null;
  active: boolean;
  addedAt: Date;
  lastReviewedAt: Date | null;
  /** Cursor του activity polling — βλ. `updateActivityCursor`. */
  lastSeenTxHash: string | null;
  lastSeenActivityAt: Date | null;
  /** Πότε το ΔΙΚΟ ΜΑΣ σύστημα έλεγξε τελευταία φορά αυτό το wallet για νέα activity —
   * ΔΙΑΦΟΡΕΤΙΚΟ από `lastSeenActivityAt` (που είναι η ώρα του ίδιου του on-chain trade).
   * Οδηγεί το activity-check rotation — βλ. `selectWalletsForActivityCheck`. */
  lastActivityCheckedAt: Date | null;
  /** NULL όταν active. 'manual' (/unwatch) ή 'below_threshold' (auto) όταν όχι — βλ.
   * `setWalletActive`. Το auto-reactivate ΠΟΤΕ δεν παρακάμπτει ένα 'manual'. */
  deactivatedReason: string | null;
}

interface WalletRow {
  id: string;
  address: string;
  chain: string;
  source: WalletSource;
  win_rate: string | null;
  pnl_multiplier: string | null;
  trade_count: number | null;
  active: boolean;
  added_at: Date;
  last_reviewed_at: Date | null;
  last_seen_tx_hash: string | null;
  last_seen_activity_at: Date | null;
  last_activity_checked_at: Date | null;
  deactivated_reason: string | null;
}

const COLUMNS = `id, address, chain, source, win_rate, pnl_multiplier, trade_count,
                 active, added_at, last_reviewed_at, last_seen_tx_hash,
                 last_seen_activity_at, last_activity_checked_at, deactivated_reason`;

function mapWallet(row: WalletRow): WatchlistWallet {
  return {
    id: toNum(row.id),
    address: row.address,
    chain: row.chain,
    source: row.source,
    winRate: toNumOrNull(row.win_rate),
    pnlMultiplier: toNumOrNull(row.pnl_multiplier),
    // trade_count είναι INTEGER, άρα έρχεται ήδη ως number — δε χρειάζεται parsing.
    tradeCount: row.trade_count,
    active: row.active,
    addedAt: row.added_at,
    lastReviewedAt: row.last_reviewed_at,
    lastSeenTxHash: row.last_seen_tx_hash,
    lastSeenActivityAt: row.last_seen_activity_at,
    lastActivityCheckedAt: row.last_activity_checked_at,
    deactivatedReason: row.deactivated_reason,
  };
}

export interface UpsertWalletInput {
  address: string;
  chain?: Chain;
  source: WalletSource;
  /**
   * Τα manual wallets μπαίνουν `active=true` αμέσως χωρίς να περάσουν το threshold
   * `win_rate > 0.5 AND trade_count >= 15` — εμπιστευόμαστε την κρίση του χρήστη
   * (CLAUDE.md, "Manual wallet watching"). Τα auto-discovered το περνούν.
   */
  active: boolean;
  winRate?: number | null;
  pnlMultiplier?: number | null;
  tradeCount?: number | null;
}

/**
 * Idempotent ως προς `address` (UNIQUE). Το `added_at` δε πειράζεται σε conflict, ώστε
 * ένα re-add να μη σβήνει το πότε μπήκε αρχικά το wallet.
 */
export async function upsertWallet(
  input: UpsertWalletInput,
  conn?: Queryable,
): Promise<WatchlistWallet> {
  const { rows } = await db(conn).query<WalletRow>(
    `INSERT INTO watchlist_wallets (address, chain, source, active, win_rate, pnl_multiplier, trade_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (address) DO UPDATE SET
       chain = EXCLUDED.chain,
       source = EXCLUDED.source,
       active = EXCLUDED.active,
       win_rate = EXCLUDED.win_rate,
       pnl_multiplier = EXCLUDED.pnl_multiplier,
       trade_count = EXCLUDED.trade_count
     RETURNING ${COLUMNS}`,
    [
      input.address,
      input.chain ?? 'sol',
      input.source,
      input.active,
      input.winRate ?? null,
      input.pnlMultiplier ?? null,
      input.tradeCount ?? null,
    ],
  );
  return mapWallet(requireRow(rows, 'upsertWallet'));
}

export async function getWallet(
  address: string,
  conn?: Queryable,
): Promise<WatchlistWallet | null> {
  const { rows } = await db(conn).query<WalletRow>(
    `SELECT ${COLUMNS} FROM watchlist_wallets WHERE address = $1`,
    [address],
  );
  const row = rows[0];
  return row === undefined ? null : mapWallet(row);
}

export async function listActiveWallets(conn?: Queryable): Promise<WatchlistWallet[]> {
  const { rows } = await db(conn).query<WalletRow>(
    `SELECT ${COLUMNS} FROM watchlist_wallets WHERE active ORDER BY added_at`,
  );
  return rows.map(mapWallet);
}

/**
 * Τα `limit` wallets που ΔΕΝ έχουν ελεγχθεί εδώ και περισσότερο καιρό —
 * `NULLS FIRST` σημαίνει ότι ένα ποτέ-μη-ελεγμένο wallet (π.χ. μόλις ανακαλύφθηκε) έχει
 * πάντα προτεραιότητα. Αντικαθιστά το παλιό in-memory round-robin index: καμία
 * κατάσταση διεργασίας να χαθεί σε restart — η ίδια η βάση ΕΙΝΑΙ η κατάσταση,
 * self-healing by construction.
 */
export async function selectWalletsForActivityCheck(
  limit: number,
  conn?: Queryable,
): Promise<WatchlistWallet[]> {
  const { rows } = await db(conn).query<WalletRow>(
    `SELECT ${COLUMNS} FROM watchlist_wallets
      WHERE active
      ORDER BY last_activity_checked_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
  );
  return rows.map(mapWallet);
}

/** Σφραγίζει ότι μόλις ελέγχθηκε — ανεξάρτητα αν βρέθηκε κάτι νέο ή όχι, γιατί το
 * rotation αφορά "πότε το είδαμε τελευταία", όχι "πότε βρήκαμε κάτι". */
export async function markActivityChecked(address: string, conn?: Queryable): Promise<void> {
  await db(conn).query(
    `UPDATE watchlist_wallets SET last_activity_checked_at = now() WHERE address = $1`,
    [address],
  );
}

/** Γενικό query ανά `source` — π.χ. για μελλοντικό ξεχωριστό discovery/vetting loop. */
export async function listWalletsBySource(
  source: WalletSource,
  conn?: Queryable,
): Promise<WatchlistWallet[]> {
  const { rows } = await db(conn).query<WalletRow>(
    `SELECT ${COLUMNS} FROM watchlist_wallets WHERE source = $1 ORDER BY added_at`,
    [source],
  );
  return rows.map(mapWallet);
}

/**
 * Ο cursor του activity polling. Χωρίς αυτόν, κάθε κύκλος θα ξανα-παρήγαγε τα ίδια buys
 * ως νέα triggers, αφού το `portfolio activity` επιστρέφει πάντα τα πιο πρόσφατα trades.
 */
export async function updateActivityCursor(
  address: string,
  txHash: string,
  activityAt: Date,
  conn?: Queryable,
): Promise<void> {
  await db(conn).query(
    `UPDATE watchlist_wallets
        SET last_seen_tx_hash = $2, last_seen_activity_at = $3
      WHERE address = $1`,
    [address, txHash, activityAt],
  );
}

export async function getActivityCursor(
  address: string,
  conn?: Queryable,
): Promise<{ txHash: string | null; activityAt: Date | null }> {
  const { rows } = await db(conn).query<{
    last_seen_tx_hash: string | null;
    last_seen_activity_at: Date | null;
  }>(
    `SELECT last_seen_tx_hash, last_seen_activity_at FROM watchlist_wallets WHERE address = $1`,
    [address],
  );
  const row = rows[0];
  return {
    txHash: row?.last_seen_tx_hash ?? null,
    activityAt: row?.last_seen_activity_at ?? null,
  };
}

export interface WalletScoreUpdate {
  winRate: number | null;
  pnlMultiplier: number | null;
  tradeCount: number | null;
}

/** Ενημερώνει το τρέχον score και σφραγίζει το `last_reviewed_at`. */
export async function updateWalletScore(
  address: string,
  score: WalletScoreUpdate,
  conn?: Queryable,
): Promise<WatchlistWallet | null> {
  const { rows } = await db(conn).query<WalletRow>(
    `UPDATE watchlist_wallets
        SET win_rate = $2, pnl_multiplier = $3, trade_count = $4, last_reviewed_at = now()
      WHERE address = $1
      RETURNING ${COLUMNS}`,
    [address, score.winRate, score.pnlMultiplier, score.tradeCount],
  );
  const row = rows[0];
  return row === undefined ? null : mapWallet(row);
}

/**
 * Χρησιμοποιείται από το `/unwatch`. Χωρίς φίλτρο σε `source` επίτηδες: το `/unwatch`
 * είναι χειροκίνητο veto πάνω σε ΟΠΟΙΟ wallet — ακόμα και auto-discovered που πέρασε το
 * algorithmic threshold (`win_rate > 0.5 AND trade_count >= 15`). Δεν καλείται αυτόματα
 * όταν πέφτει το score κανενός wallet· εκεί στέλνουμε alert και αποφασίζει ο χρήστης
 * (CLAUDE.md).
 */
export async function setWalletActive(
  address: string,
  active: boolean,
  reason?: 'manual' | 'below_threshold',
  conn?: Queryable,
): Promise<boolean> {
  // active=true πάντα καθαρίζει το reason (NULL) — δεν έχει νόημα deactivated_reason σε
  // ενεργό wallet. active=false χωρίς ρητό reason προεπιλέγει σε 'manual' — το /unwatch
  // στο telegram/bot.ts καλεί με 2 ορίσματα, άρα παίρνει αυτόματα 'manual', σωστό.
  const result = await db(conn).query(
    `UPDATE watchlist_wallets SET active = $2, deactivated_reason = $3 WHERE address = $1`,
    [address, active, active ? null : (reason ?? 'manual')],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Ποια wallets αξίζει να σκοράρουμε — active, ΚΑΙ auto-deactivated (για να δούμε αν
 * ξαναπέρασαν το threshold), αλλά ΟΧΙ manually /unwatch-ed (ο χρήστης το απέκλεισε
 * σκόπιμα, δεν έχει νόημα να συνεχίζουμε να ξοδεύουμε weight σκοράροντάς το).
 */
export async function listWalletsForScoring(conn?: Queryable): Promise<WatchlistWallet[]> {
  const { rows } = await db(conn).query<WalletRow>(
    `SELECT ${COLUMNS} FROM watchlist_wallets
      WHERE active OR deactivated_reason = 'below_threshold'
      ORDER BY added_at`,
  );
  return rows.map(mapWallet);
}

export interface NewDiscoveredWallet {
  address: string;
  chain?: Chain;
  source: WalletSource;
  active: boolean;
  winRate?: number | null;
  pnlMultiplier?: number | null;
  tradeCount?: number | null;
}

/**
 * Χρησιμοποιείται από το wallet-discovery collector. INSERT-only, ΠΟΤΕ update —
 * `ON CONFLICT DO NOTHING`. Αν το address υπάρχει ήδη, ΔΕΝ το αγγίζουμε καθόλου:
 * - αν είναι `manual`, το auto-discovery δεν πρέπει ποτέ να το υποβαθμίσει/επικαλύψει
 *   με `source='smart_money'` — το manual είναι ρητή εμπιστοσύνη του χρήστη.
 * - αν είναι ήδη `smart_money` (από προηγούμενο discovery pass), το re-scoring του
 *   είναι δουλειά του wallet-scoring loop (`updateWalletScore`), όχι αυτής της
 *   συνάρτησης — αλλιώς θα διπλογραφόταν η ίδια λογική σε δύο σημεία.
 *
 * Επιστρέφει `true` μόνο όταν όντως γράφτηκε νέο row.
 */
export async function insertWalletIfNew(
  input: NewDiscoveredWallet,
  conn?: Queryable,
): Promise<boolean> {
  const result = await db(conn).query(
    `INSERT INTO watchlist_wallets (address, chain, source, active, win_rate, pnl_multiplier, trade_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (address) DO NOTHING`,
    [
      input.address,
      input.chain ?? 'sol',
      input.source,
      input.active,
      input.winRate ?? null,
      input.pnlMultiplier ?? null,
      input.tradeCount ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
