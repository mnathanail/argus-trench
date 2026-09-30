import {
  closeMirrorShadow,
  listActiveMirrorShadows,
  listExpiredMirrorShadows,
  updateMirrorShadow,
  type MirrorShadowState,
} from '../db/repositories/mirror.js';
import { PAPER_ASSUMED_FEES_PCT } from '../decision/paperTradingConfig.js';
import { priceFromTradeEvent, type PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import { checkTick } from '../realtime/tickExit.js';
import { mirrorBuySol } from './mirrorConfig.js';
import { mirrorPnl } from './mirrorDecision.js';

/**
 * MIRROR — σκιά trailing (2026-09-30, αίτημα χρήστη: «το μεγάλο πρόβλημα είναι ότι δεν έχουμε
 * trailing»). Κάθε mirror θέση, από την πρώτη αγορά, παρακολουθεί ΚΑΙ την τιμή του token
 * (PumpPortal token ticks — subscribeToken στο άνοιγμα) και εφαρμόζει τους κανόνες του argus
 * (checkTick: trailing +50%/−25%, floor +10%, stop-loss −50%) + 24h timeout, με ένα μόνο
 * ποσό MIRROR_BUY_SOL στην τιμή της πρώτης αγοράς. Γράφει μόνο τα shadow_* πεδία· η
 * πραγματική (paper) θέση που ακολουθεί το wallet δεν αλλάζει ΠΟΤΕ από εδώ. Συνεχίζει και
 * αφού η πραγματική θέση κλείσει (όπως οι σκιές του argus).
 */

export const SHADOW_TIMEOUT_MS = 24 * 3600_000;
const REFRESH_MS = 60_000;

export type ShadowStep =
  | { kind: 'update'; peakPrice: number; trailingActive: boolean; changed: boolean }
  | { kind: 'exit'; reason: 'trailing_stop' | 'stop_loss' | 'tp_tier_1' | 'timeout'; exitPrice: number; peakPrice: number };

/** Καθαρή: ένα tick πάνω σε μια σκιά. */
export function advanceShadow(state: MirrorShadowState, price: number, nowMs: number): ShadowStep {
  const r = checkTick({
    entryPrice: state.entryPrice,
    peakPriceSinceEntry: state.peakPrice,
    trailingActive: state.trailingActive,
    currentPrice: price,
  });
  if (r.exit !== null) return { kind: 'exit', reason: r.exit.exitReason, exitPrice: r.exit.exitPrice, peakPrice: r.newPeakPriceSinceEntry };
  if (nowMs - state.openedAt.getTime() >= SHADOW_TIMEOUT_MS) {
    return { kind: 'exit', reason: 'timeout', exitPrice: price, peakPrice: r.newPeakPriceSinceEntry };
  }
  const changed = r.newPeakPriceSinceEntry !== state.peakPrice || r.newTrailingActive !== state.trailingActive;
  return { kind: 'update', peakPrice: r.newPeakPriceSinceEntry, trailingActive: r.newTrailingActive, changed };
}

export function shadowPnl(entryPrice: number, exitPrice: number): { pnlSol: number; pnlPct: number | null } {
  const base = mirrorBuySol();
  return mirrorPnl(base, (base * exitPrice) / entryPrice, PAPER_ASSUMED_FEES_PCT);
}

// ── in-memory cache: token → ενεργές σκιές ──────────────────────────────────────
let byToken = new Map<string, MirrorShadowState[]>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
const tokenQueues = new Map<string, Promise<unknown>>();

export async function refreshMirrorShadows(): Promise<string[]> {
  const rows = await listActiveMirrorShadows();
  const next = new Map<string, MirrorShadowState[]>();
  for (const s of rows) next.set(s.tokenAddress, [...(next.get(s.tokenAddress) ?? []), s]);
  byToken = next;
  loadedAt = Date.now();
  return [...next.keys()];
}

/** Μόνο για tests. */
export function setMirrorShadowsForTest(states: MirrorShadowState[]): void {
  byToken = new Map();
  for (const s of states) byToken.set(s.tokenAddress, [...(byToken.get(s.tokenAddress) ?? []), s]);
  loadedAt = Date.now();
}

async function ensureFresh(): Promise<void> {
  if (Date.now() - loadedAt <= REFRESH_MS) return;
  loading ??= refreshMirrorShadows()
    .then(() => undefined)
    .finally(() => {
      loading = null;
    });
  await loading;
}

export interface ShadowDeps {
  update: typeof updateMirrorShadow;
  close: typeof closeMirrorShadow;
  nowMs: () => number;
}
const defaultDeps: ShadowDeps = { update: updateMirrorShadow, close: closeMirrorShadow, nowMs: () => Date.now() };

/**
 * Κάθε PumpPortal event (και token ticks). Γρήγορο όταν το token δεν έχει σκιά (Map lookup).
 * Επιστρέφει τις σκιές που έκλεισαν (για log / unsubscribe του token).
 */
export async function handleMirrorShadowTick(
  event: PumpPortalTradeEvent,
  deps: ShadowDeps = defaultDeps,
): Promise<{ positionId: number; token: string; reason: string; pnlPct: number | null }[]> {
  await ensureFresh();
  if (!byToken.has(event.mint)) return [];
  const price = priceFromTradeEvent(event);
  if (price === null || !(price > 0)) return [];
  const prev = tokenQueues.get(event.mint) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const closed: { positionId: number; token: string; reason: string; pnlPct: number | null }[] = [];
    const states = byToken.get(event.mint) ?? [];
    const remaining: MirrorShadowState[] = [];
    for (const s of states) {
      const step = advanceShadow(s, price, deps.nowMs());
      if (step.kind === 'exit') {
        const { pnlSol, pnlPct } = shadowPnl(s.entryPrice, step.exitPrice);
        await deps.close({ positionId: s.positionId, exitPrice: step.exitPrice, reason: step.reason, pnlSol, pnlPct, peakPrice: step.peakPrice });
        closed.push({ positionId: s.positionId, token: event.mint, reason: step.reason, pnlPct });
        continue;
      }
      const nextState = { ...s, peakPrice: step.peakPrice, trailingActive: step.trailingActive };
      if (step.changed) await deps.update({ positionId: s.positionId, peakPrice: step.peakPrice, lastPrice: price, trailingActive: step.trailingActive });
      remaining.push(nextState);
    }
    if (remaining.length > 0) byToken.set(event.mint, remaining);
    else byToken.delete(event.mint);
    return closed;
  });
  tokenQueues.set(event.mint, run);
  void run.finally(() => {
    if (tokenQueues.get(event.mint) === run) tokenQueues.delete(event.mint);
  }).catch(() => undefined);
  return run;
}

/** Σκιές >24h χωρίς tick που να τις κλείσει → timeout στην τελευταία γνωστή τιμή. */
export async function expireMirrorShadows(): Promise<number> {
  const expired = await listExpiredMirrorShadows();
  for (const e of expired) {
    const exitPrice = e.lastPrice ?? e.entryPrice;
    const { pnlSol, pnlPct } = shadowPnl(e.entryPrice, exitPrice);
    await closeMirrorShadow({ positionId: e.positionId, exitPrice, reason: 'timeout', pnlSol, pnlPct, peakPrice: e.peakPrice ?? exitPrice });
    const list = (byToken.get(e.tokenAddress) ?? []).filter((s) => s.positionId !== e.positionId);
    if (list.length > 0) byToken.set(e.tokenAddress, list);
    else byToken.delete(e.tokenAddress);
  }
  return expired.length;
}

export function hasActiveShadow(token: string): boolean {
  return byToken.has(token);
}
