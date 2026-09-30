import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import type { ParsedTransaction, TokenBalance } from '../solana/heliusRpc.js';

/**
 * MIRROR — γρήγορη πηγή (2026-09-30). Μετατρέπει μια on-chain συναλλαγή (getTransaction,
 * jsonParsed) σε trade event ενός συγκεκριμένου wallet, ΑΝΕΞΑΡΤΗΤΑ από το bot/router που
 * χρησιμοποίησε (Axiom, Photon, Jupiter…): κοιτάμε μόνο τις αλλαγές υπολοίπων.
 *
 *  - token: η αλλαγή στα token accounts που ανήκουν στο wallet (εκτός wSOL). Ακριβώς ΕΝΑ
 *    token πρέπει να αλλάξει — αλλιώς δεν είναι απλή αγορά/πώληση με SOL.
 *  - newTokenBalance: το υπόλοιπο μετά (ακριβές % πώλησης).
 *  - SOL: δύο εκτιμήσεις —
 *      walletSol = πόσα SOL έφυγαν/ήρθαν στο wallet (χωρίς network fee και χωρίς το rent του
 *                  token account)· περιλαμβάνει όμως fee bot / tip → λίγο μεγαλύτερο στις αγορές,
 *      poolSol   = η μεγαλύτερη αλλαγή lamports άλλου λογαριασμού στην αντίθετη κατεύθυνση
 *                  (bonding curve ή vault του pool) = το ποσό που πήγε πραγματικά στο pool.
 *    Χρησιμοποιούμε poolSol όταν είναι εύλογο σε σχέση με το walletSol, αλλιώς walletSol.
 *  - pool: 'pump' αν καλείται το πρόγραμμα του Pump.fun bonding curve, 'pump-amm' για PumpSwap,
 *    αλλιώς 'other' (→ ignored_pool). Χωρίς curve πεδία → τιμή = sol/tokens (priceFromTradeEvent).
 */

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpMNtHVfk3KnA';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS = 1e9;

export type WalletTradeSkip = 'no_meta' | 'failed' | 'wallet_not_in_tx' | 'no_token_change' | 'multi_token' | 'no_sol_change';

export type WalletTradeParse =
  | {
      ok: true;
      event: PumpPortalTradeEvent;
      blockTime: number | null;
      program: 'pump' | 'pump-amm' | 'other';
      walletSol: number;
      poolSol: number | null;
      solSource: 'pool' | 'wallet';
    }
  | { ok: false; reason: WalletTradeSkip };

interface MintDelta {
  pre: bigint;
  post: bigint;
  decimals: number;
  preIndex: number | null;
  postIndex: number | null;
}

function ownedBalances(list: TokenBalance[] | null | undefined, wallet: string): TokenBalance[] {
  return (list ?? []).filter((b) => b.owner === wallet);
}

function toUi(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export function parseWalletTrade(tx: ParsedTransaction, wallet: string): WalletTradeParse {
  const meta = tx.meta;
  if (meta === null || meta === undefined) return { ok: false, reason: 'no_meta' };
  if (meta.err !== null && meta.err !== undefined) return { ok: false, reason: 'failed' };

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const walletIndex = keys.indexOf(wallet);
  if (walletIndex < 0) return { ok: false, reason: 'wallet_not_in_tx' };

  const program = keys.includes(PUMP_PROGRAM) ? 'pump' : keys.includes(PUMP_AMM_PROGRAM) ? 'pump-amm' : 'other';

  // Αλλαγές token (όχι wSOL) στα accounts του wallet.
  const deltas = new Map<string, MintDelta>();
  const walletTokenAccounts = new Set<number>();
  let wsolDelta = 0n;
  for (const [side, list] of [
    ['pre', ownedBalances(meta.preTokenBalances, wallet)],
    ['post', ownedBalances(meta.postTokenBalances, wallet)],
  ] as const) {
    for (const b of list) {
      walletTokenAccounts.add(b.accountIndex);
      const amount = BigInt(b.uiTokenAmount.amount);
      if (b.mint === WSOL_MINT) {
        wsolDelta += side === 'post' ? amount : -amount;
        continue;
      }
      const d = deltas.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals, preIndex: null, postIndex: null };
      if (side === 'pre') {
        d.pre += amount;
        d.preIndex = b.accountIndex;
      } else {
        d.post += amount;
        d.postIndex = b.accountIndex;
      }
      deltas.set(b.mint, d);
    }
  }
  const changed = [...deltas.entries()].filter(([, d]) => d.post !== d.pre);
  if (changed.length === 0) return { ok: false, reason: 'no_token_change' };
  if (changed.length > 1) return { ok: false, reason: 'multi_token' };
  const [mint, d] = changed[0]!;
  const isBuy = d.post > d.pre;

  // SOL του wallet: native + wSOL, χωρίς network fee (αν πλήρωσε) και χωρίς rent token account.
  let native = (meta.postBalances[walletIndex] ?? 0) - (meta.preBalances[walletIndex] ?? 0);
  if (walletIndex === 0) native += meta.fee;
  if (d.preIndex === null && d.postIndex !== null) native += meta.postBalances[d.postIndex] ?? 0; // άνοιξε token account
  if (d.preIndex !== null && d.postIndex === null) native -= meta.preBalances[d.preIndex] ?? 0; // έκλεισε token account
  const walletLamports = native + Number(wsolDelta);
  const walletSol = (isBuy ? -walletLamports : walletLamports) / LAMPORTS;
  if (!(walletSol > 0)) return { ok: false, reason: 'no_sol_change' };

  // Αντισυμβαλλόμενος: η μεγαλύτερη αλλαγή lamports άλλου λογαριασμού στην αντίθετη κατεύθυνση.
  let best = 0;
  for (let i = 0; i < keys.length; i += 1) {
    if (i === walletIndex || walletTokenAccounts.has(i)) continue;
    const change = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
    const towardPool = isBuy ? change : -change;
    if (towardPool > best) best = towardPool;
  }
  const poolSol = best > 0 ? best / LAMPORTS : null;
  // Αγορά: το pool παίρνει λιγότερα από όσα έδωσε το wallet (fees)· πώληση: δίνει περισσότερα.
  const plausible =
    poolSol !== null && (isBuy ? poolSol >= walletSol * 0.5 && poolSol <= walletSol * 1.02 : poolSol >= walletSol * 0.98 && poolSol <= walletSol * 1.5);

  const event: PumpPortalTradeEvent = {
    signature: tx.transaction.signatures[0]!,
    mint,
    traderPublicKey: wallet,
    txType: isBuy ? 'buy' : 'sell',
    tokenAmount: toUi(isBuy ? d.post - d.pre : d.pre - d.post, d.decimals),
    solAmount: plausible ? poolSol! : walletSol,
    pool: program,
    newTokenBalance: toUi(d.post, d.decimals),
  };
  return {
    ok: true,
    event,
    blockTime: tx.blockTime ?? null,
    program,
    walletSol,
    poolSol,
    solSource: plausible ? 'pool' : 'wallet',
  };
}

/** Διαγνωστικό (helius-mirror-probe): όλες οι αλλαγές token του wallet (και wSOL) + native SOL. */
export function describeWalletChanges(tx: ParsedTransaction, wallet: string): string {
  const meta = tx.meta;
  if (!meta) return 'no meta';
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const idx = keys.indexOf(wallet);
  const byMint = new Map<string, { pre: bigint; post: bigint; decimals: number }>();
  for (const [side, list] of [['pre', meta.preTokenBalances], ['post', meta.postTokenBalances]] as const) {
    for (const b of ownedBalances(list, wallet)) {
      const d = byMint.get(b.mint) ?? { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
      if (side === 'pre') d.pre += BigInt(b.uiTokenAmount.amount);
      else d.post += BigInt(b.uiTokenAmount.amount);
      byMint.set(b.mint, d);
    }
  }
  const parts = [...byMint.entries()]
    .filter(([, d]) => d.pre !== d.post)
    .map(([m, d]) => `${m === WSOL_MINT ? 'wSOL' : m.slice(0, 8)} ${toUi(d.pre, d.decimals).toPrecision(6)}→${toUi(d.post, d.decimals).toPrecision(6)}`);
  const native = idx < 0 ? 'wallet εκτός tx' : `SOL ${(((meta.postBalances[idx] ?? 0) - (meta.preBalances[idx] ?? 0)) / LAMPORTS).toFixed(4)}`;
  return `${native} | ${parts.join(' | ') || 'καμία αλλαγή token'}`;
}
