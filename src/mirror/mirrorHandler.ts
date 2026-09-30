import {
  applyMirrorFill,
  closeMirrorPosition,
  getOpenMirrorPositionForUpdate,
  insertMirrorEvent,
  listWalletsWithOpenMirrorPositions,
  mirrorEventExists,
  openMirrorPosition,
  startMirrorShadow,
  type MirrorEventInsert,
} from '../db/repositories/mirror.js';
import { listMirrorWallets } from '../db/repositories/watchlistWallets.js';
import { withTransaction } from '../db/tx.js';
import { PAPER_ASSUMED_FEES_PCT, PAPER_ASSUMED_SLIPPAGE_PCT } from '../decision/paperTradingConfig.js';
import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import { MIRROR_MODE, mirrorBuySol } from './mirrorConfig.js';
import { decideMirror, mirrorPnl } from './mirrorDecision.js';

/**
 * MIRROR route (2026-09-30) — εκτέλεση ενός trade event mirror wallet. Paper μόνο (MIRROR_MODE).
 * Καλείται για ΚΑΘΕ PumpPortal event (main.ts), ανεξάρτητα από το κανονικό argus· για μη
 * mirror wallets επιστρέφει αμέσως null (in-memory set, χωρίς DB).
 *
 * Σειρά ανά event (σειριακά ανά token, in-process lock + ένα DB transaction):
 *   1. ίδιο signature ξανά → τίποτα (idempotent),
 *   2. ανοιχτή θέση του token (FOR UPDATE) → decideMirror,
 *   3. άνοιγμα/ενημέρωση/κλείσιμο θέσης,
 *   4. καταγραφή του event με την ενέργεια (και τα ignored — πλήρης ιχνηλασία).
 */

export type MirrorOutcome =
  | { kind: 'opened'; wallet: string; walletName: string | null; token: string; ourSol: number }
  | { kind: 'added' | 'reduced'; wallet: string; token: string }
  | {
      kind: 'closed';
      wallet: string;
      walletName: string | null;
      token: string;
      pnlSol: number;
      pnlPct: number | null;
      buyCount: number;
      sellCount: number;
    }
  | { kind: 'ignored'; wallet: string; token: string; reason: string }
  | { kind: 'duplicate' };

const CACHE_TTL_MS = 60_000;
let mirrorNames = new Map<string, string | null>();
/** Πρώην mirror wallets με ανοιχτή θέση — μόνο οι ΠΩΛΗΣΕΙΣ τους αντιγράφονται (κλείσιμο). */
let sellOnlyWallets = new Set<string>();
let cacheLoadedAt = 0;
let cacheLoading: Promise<void> | null = null;

/** Ξαναφορτώνει τα mirror wallets (καλείται και από /mirror, /unmirror). */
export async function refreshMirrorWallets(): Promise<void> {
  const rows = await listMirrorWallets();
  const withOpen = await listWalletsWithOpenMirrorPositions();
  mirrorNames = new Map(rows.map((r) => [r.address, r.name]));
  sellOnlyWallets = new Set(withOpen.filter((a) => !mirrorNames.has(a)));
  cacheLoadedAt = Date.now();
}

async function mirrorRole(address: string): Promise<'mirror' | 'sell_only' | null> {
  if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    cacheLoading ??= refreshMirrorWallets().finally(() => {
      cacheLoading = null;
    });
    await cacheLoading;
  }
  if (mirrorNames.has(address)) return 'mirror';
  return sellOnlyWallets.has(address) ? 'sell_only' : null;
}

/** Μόνο για tests. */
export function setMirrorWalletsForTest(entries: [string, string | null][], sellOnly: string[] = []): void {
  mirrorNames = new Map(entries);
  sellOnlyWallets = new Set(sellOnly);
  cacheLoadedAt = Date.now();
}

// Σειριακή επεξεργασία ανά token: ένα burst αγορών στο ίδιο token δεν πρέπει να ανοίξει δύο θέσεις.
const tokenQueues = new Map<string, Promise<unknown>>();
function serializeByToken<T>(mint: string, fn: () => Promise<T>): Promise<T> {
  const prev = tokenQueues.get(mint) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  tokenQueues.set(mint, next);
  void next.finally(() => {
    if (tokenQueues.get(mint) === next) tokenQueues.delete(mint);
  }).catch(() => undefined);
  return next;
}

/** Από πού ήρθε το event — καταγράφεται σε κάθε mirror_events row (detail_json.source). */
export type MirrorEventSource = 'pumpportal' | 'gmgn' | 'helius';

export async function handleMirrorEvent(
  event: PumpPortalTradeEvent,
  source: MirrorEventSource = 'pumpportal',
  /** Επιπλέον πεδία για το detail_json (π.χ. lag_sec — πόσο αργά είδαμε το trade). */
  extraDetail: Record<string, unknown> = {},
): Promise<MirrorOutcome | null> {
  const role = await mirrorRole(event.traderPublicKey);
  if (role === null) return null;
  // Πρώην mirror wallet (/unmirror) με ανοιχτή θέση: οι αγορές του πάνε πια στο κανονικό argus.
  if (role === 'sell_only' && event.txType === 'buy') return null;
  const walletName = mirrorNames.get(event.traderPublicKey) ?? null;
  return serializeByToken(event.mint, () =>
    withTransaction(async (tx) => {
      if (await mirrorEventExists(event.signature, event.traderPublicKey, tx)) return { kind: 'duplicate' as const };
      const record = (e: MirrorEventInsert): Promise<boolean> =>
        insertMirrorEvent({ ...e, detail: { ...(e.detail ?? {}), ...extraDetail, source } }, tx);

      const position = await getOpenMirrorPositionForUpdate(event.mint, tx);
      const decision = decideMirror(event, position, {
        buySol: mirrorBuySol(),
        entrySlippagePct: PAPER_ASSUMED_SLIPPAGE_PCT,
      });
      const base = {
        walletAddress: event.traderPublicKey,
        tokenAddress: event.mint,
        txType: event.txType,
        signature: event.signature,
        solAmount: event.solAmount,
        tokenAmount: event.tokenAmount,
        newTokenBalance: event.newTokenBalance ?? null,
        pool: event.pool ?? null,
      };

      if (decision.action === 'ignored') {
        await record(
          {
            ...base,
            priceSol: decision.priceSol,
            action: `ignored_${decision.reason}`,
            positionId: position?.id ?? null,
            ourSol: null,
            ourTokens: null,
            sellPct: null,
            detail: position !== null && decision.reason === 'other_wallet_position' ? { position_wallet: position.walletAddress } : null,
          },
        );
        return { kind: 'ignored' as const, wallet: event.traderPublicKey, token: event.mint, reason: decision.reason };
      }

      if (decision.action === 'buy') {
        const positionId =
          position?.id ?? (await openMirrorPosition({ walletAddress: event.traderPublicKey, tokenAddress: event.mint, mode: MIRROR_MODE }, tx));
        await applyMirrorFill(
          {
            positionId,
            side: 'buy',
            sol: decision.ourSol,
            tokens: decision.ourTokens,
            priceSol: decision.priceSol,
            targetTokensEst: decision.targetBalanceAfter,
          },
          tx,
        );
        // Σκιά trailing (migration 0024): είσοδος = η τιμή της ΠΡΩΤΗΣ αγοράς μας.
        if (decision.open) await startMirrorShadow(positionId, decision.fillPrice, tx);
        await record(
          {
            ...base,
            priceSol: decision.priceSol,
            action: decision.open ? 'buy_open' : 'buy_add',
            positionId,
            ourSol: decision.ourSol,
            ourTokens: decision.ourTokens,
            sellPct: null,
            detail: { fill_price: decision.fillPrice, mode: MIRROR_MODE },
          },
        );
        return decision.open
          ? { kind: 'opened' as const, wallet: event.traderPublicKey, walletName, token: event.mint, ourSol: decision.ourSol }
          : { kind: 'added' as const, wallet: event.traderPublicKey, token: event.mint };
      }

      // sell — η θέση υπάρχει (αλλιώς decideMirror → ignored no_position)
      const pos = position!;
      await applyMirrorFill(
        {
          positionId: pos.id,
          side: 'sell',
          sol: decision.ourSol,
          tokens: decision.ourTokens,
          priceSol: decision.priceSol,
          targetTokensEst: decision.targetBalanceAfter,
        },
        tx,
      );
      await record(
        {
          ...base,
          priceSol: decision.priceSol,
          action: decision.close ? 'sell_close' : 'sell_partial',
          positionId: pos.id,
          ourSol: decision.ourSol,
          ourTokens: decision.ourTokens,
          sellPct: decision.pct,
          detail: { pct_source: decision.pctSource, mode: MIRROR_MODE },
        },
      );
      if (!decision.close) return { kind: 'reduced' as const, wallet: event.traderPublicKey, token: event.mint };

      const solIn = pos.solIn;
      const solOut = pos.solOut + decision.ourSol;
      const { pnlSol, pnlPct } = mirrorPnl(solIn, solOut, PAPER_ASSUMED_FEES_PCT);
      const closed = await closeMirrorPosition({ positionId: pos.id, pnlSol, pnlPct, reason: `wallet_exit:${decision.pctSource}` }, tx);
      return {
        kind: 'closed' as const,
        wallet: event.traderPublicKey,
        walletName,
        token: event.mint,
        pnlSol,
        pnlPct,
        buyCount: closed.buyCount,
        sellCount: closed.sellCount,
      };
    }),
  );
}

// Το main.ts δίνει τη συνδρομή του PumpPortal μόλις υπάρξει σύνδεση — ώστε ένα νέο /mirror
// wallet να αρχίσει να παρακολουθείται αμέσως, χωρίς restart.
let subscriber: ((address: string) => void) | null = null;
export function setMirrorSubscriber(fn: (address: string) => void): void {
  subscriber = fn;
}

/** Μετά από /mirror ή /unmirror: φρέσκια λίστα + (για mirror) realtime συνδρομή. */
export async function onMirrorWalletChanged(address: string, mode: 'signal' | 'mirror'): Promise<void> {
  await refreshMirrorWallets();
  if (mode === 'mirror') subscriber?.(address);
}
