import WebSocket from 'ws';

import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } from '../mirror/heliusTrade.js';
import type { SocketLike } from '../solana/heliusLogsListener.js';
import {
  getMultipleAccounts,
  getTokenAccountsByOwner,
  getTokenLargestAccounts,
  heliusRpcUrl,
  heliusWsUrl,
  type AccountInfoLite,
} from '../solana/heliusRpc.js';
import { PUMP_TOKEN_SUPPLY, type PumpPortalTradeEvent } from './pumpportalEvents.js';
import type { RealtimeFeed } from './realtimeFeed.js';

/**
 * 2026-10-07 (ρητή απόφαση χρήστη: «δεν κάνω άλλο top-up στο PumpPortal») — τιμές για τις
 * εξόδους από το Helius, δωρεάν: `accountSubscribe` στη bonding curve (ή στα token accounts του
 * PumpSwap pool) κάθε token με ανοιχτή θέση. Τα websocket δεν χρεώνονται credits στο free plan·
 * μόνο η εύρεση των λογαριασμών ενός token κοστίζει ~4 credits (μία φορά ανά token).
 *
 * Το PumpPortal χρέωνε 0.01 SOL ανά 10k trades και σχεδόν όλα ήταν trades τρίτων στα tokens που
 * κρατάμε (π.χ. 380 από 521 events σε 1h40 από ένα token) — άδειαζε συνέχεια.
 *
 * Κάθε αλλαγή του λογαριασμού = ένα συνθετικό tick (`PumpPortalTradeEvent`) με την τιμή ΜΕΤΑ το
 * trade, στις ίδιες μονάδες με το PumpPortal: curve → vSol/vTokens (SOL / UI tokens),
 * PumpSwap → marketCapSol = wSOL / tokens × 1e9. Ο exit handler δεν ξεχωρίζει την πηγή.
 * Wallets: no-op (τα σήματα έρχονται από το heliusSignalSource).
 */

export interface CurveState {
  virtualTokenReserves: number;
  virtualSolReserves: number;
  complete: boolean;
}

/** Pump.fun BondingCurve account: [8 disc][u64 vTok][u64 vSol][u64 realTok][u64 realSol][u64 supply][bool complete]. */
export function decodeBondingCurve(data: Buffer): CurveState | null {
  if (data.length < 49) return null;
  const vTok = Number(data.readBigUInt64LE(8)) / 1e6;
  const vSol = Number(data.readBigUInt64LE(16)) / 1e9;
  if (!(vTok > 0) || !(vSol > 0)) return null;
  return { virtualTokenReserves: vTok, virtualSolReserves: vSol, complete: data.readUInt8(48) === 1 };
}

export function curveTick(mint: string, s: CurveState, slot: number): PumpPortalTradeEvent {
  return {
    signature: `helius-tick:${mint}:${slot}`,
    mint,
    traderPublicKey: '',
    txType: 'buy',
    tokenAmount: 1,
    solAmount: 1,
    vTokensInBondingCurve: s.virtualTokenReserves,
    vSolInBondingCurve: s.virtualSolReserves,
    marketCapSol: (s.virtualSolReserves / s.virtualTokenReserves) * PUMP_TOKEN_SUPPLY,
    pool: 'pump',
    signalSource: 'helius',
  };
}

export function ammTick(mint: string, baseUi: number, quoteSol: number, slot: number): PumpPortalTradeEvent | null {
  if (!(baseUi > 0) || !(quoteSol > 0)) return null;
  return {
    signature: `helius-tick:${mint}:${slot}`,
    mint,
    traderPublicKey: '',
    txType: 'buy',
    tokenAmount: 1,
    solAmount: 1,
    marketCapSol: (quoteSol / baseUi) * PUMP_TOKEN_SUPPLY,
    pool: 'pump-amm',
    signalSource: 'helius',
  };
}

/** Υπόλοιπο ενός jsonParsed token account (UI units). */
export function parsedTokenAmount(data: unknown): number | null {
  const info = (data as { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } } | null)?.parsed?.info;
  const t = info?.tokenAmount;
  if (t?.amount === undefined || t.decimals === undefined) return null;
  return Number(t.amount) / 10 ** t.decimals;
}

function parsedTokenOwner(data: unknown): string | null {
  const owner = (data as { parsed?: { info?: { owner?: string } } } | null)?.parsed?.info?.owner;
  return typeof owner === 'string' ? owner : null;
}

function base64Data(data: unknown): Buffer | null {
  return Array.isArray(data) && typeof data[0] === 'string' ? Buffer.from(data[0], 'base64') : null;
}

export type PoolLocation =
  | { kind: 'curve'; curve: string; state: CurveState }
  | { kind: 'amm'; pool: string; base: string; quote: string; baseUi: number; quoteSol: number };

export interface PoolRpc {
  largest: (mint: string) => Promise<{ address: string }[]>;
  accounts: (addresses: readonly string[], encoding: 'jsonParsed' | 'base64') => Promise<(AccountInfoLite | null)[]>;
  tokenAccountsByOwner: (owner: string, mint: string) => Promise<{ pubkey: string; account: AccountInfoLite }[]>;
}

/**
 * Πού ζει η τιμή ενός token: ο owner (PDA) ενός από τους μεγαλύτερους κατόχους του που ανήκει στο
 * πρόγραμμα του PumpSwap (pool — προτιμάται, το token έχει αποφοιτήσει) ή του Pump.fun (curve).
 * ~4 credits. null = κανένα από τα δύο (άλλο DEX / δεν βρέθηκε).
 */
export async function locatePool(mint: string, rpc: PoolRpc): Promise<PoolLocation | null> {
  const largest = (await rpc.largest(mint)).map((a) => a.address);
  const tokenInfos = await rpc.accounts(largest, 'jsonParsed');
  const holders = largest
    .map((address, i) => ({ address, owner: parsedTokenOwner(tokenInfos[i]?.data), amount: parsedTokenAmount(tokenInfos[i]?.data) }))
    .filter((h): h is { address: string; owner: string; amount: number | null } => h.owner !== null);
  const owners = [...new Set(holders.map((h) => h.owner))];
  const ownerInfos = await rpc.accounts(owners, 'base64');
  const programOf = new Map(owners.map((o, i) => [o, ownerInfos[i] ?? null]));

  const amm = holders.find((h) => programOf.get(h.owner)?.owner === PUMP_AMM_PROGRAM);
  if (amm !== undefined) {
    const quote = (await rpc.tokenAccountsByOwner(amm.owner, WSOL_MINT))[0];
    const quoteSol = quote === undefined ? null : parsedTokenAmount(quote.account.data);
    if (quote !== undefined && quoteSol !== null && amm.amount !== null) {
      return { kind: 'amm', pool: amm.owner, base: amm.address, quote: quote.pubkey, baseUi: amm.amount, quoteSol };
    }
  }
  const curve = holders.find((h) => programOf.get(h.owner)?.owner === PUMP_PROGRAM);
  if (curve !== undefined) {
    const data = base64Data(programOf.get(curve.owner)?.data);
    const state = data === null ? null : decodeBondingCurve(data);
    if (state !== null) return { kind: 'curve', curve: curve.owner, state };
  }
  return null;
}

type Role = 'curve' | 'base' | 'quote';
interface TokenState {
  location: PoolLocation | null;
  subIds: number[];
  baseUi: number | null;
  quoteSol: number | null;
  attempts: number;
}

export interface HeliusPriceFeedOptions {
  apiKey: string;
  onTick: (event: PumpPortalTradeEvent) => void;
  log?: (line: string) => void;
  createSocket?: (url: string) => SocketLike;
  rpc?: PoolRpc;
}

const OPEN = 1;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const PING_INTERVAL_MS = 30_000;
const RESOLVE_RETRY_MS = 60_000;
const MAX_RESOLVE_ATTEMPTS = 5;
const GRADUATION_RECHECK_MS = 20_000;
const RESOLVE_PACING_MS = 500;

export class HeliusPriceFeed implements RealtimeFeed {
  private socket: SocketLike | null = null;
  private readonly wallets = new Set<string>();
  private readonly tokens = new Map<string, TokenState>();
  private readonly subs = new Map<number, { mint: string; role: Role }>();
  private readonly pending = new Map<number, { mint: string; role: Role }>();
  private nextId = 1;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private ping: NodeJS.Timeout | null = null;
  private readonly log: (line: string) => void;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly rpc: PoolRpc;
  /** Οι εύρεσεις pool τρέχουν μία-μία με παύση: free plan = 10 RPC/s (στην εκκίνηση ~50 tokens μαζί). */
  private resolveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: HeliusPriceFeedOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    const url = heliusRpcUrl(options.apiKey);
    this.rpc = options.rpc ?? {
      largest: (mint) => getTokenLargestAccounts(url, mint),
      accounts: (addresses, encoding) => getMultipleAccounts(url, addresses, encoding),
      tokenAccountsByOwner: (owner, mint) => getTokenAccountsByOwner(url, owner, mint),
    };
  }

  // ── RealtimeFeed ─────────────────────────────────────────────────────────────────
  connect(): void {
    this.closedByUser = false;
    const socket = this.createSocket(heliusWsUrl(this.options.apiKey));
    this.socket = socket;
    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.subs.clear();
      this.pending.clear();
      for (const state of this.tokens.values()) state.subIds = [];
      this.log(`[helius-price] συνδέθηκε — τιμές για ${this.tokens.size} tokens`);
      for (const [mint, state] of this.tokens) if (state.location !== null) this.subscribeAccounts(mint, state.location);
      if (this.ping !== null) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (this.socket?.readyState === OPEN) this.socket.ping();
      }, PING_INTERVAL_MS);
      this.ping.unref();
    });
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('error', (error) => this.log(`[helius-price] σφάλμα socket: ${error.message}`));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.ping !== null) {
        clearInterval(this.ping);
        this.ping = null;
      }
      this.subs.clear();
      this.pending.clear();
      if (this.closedByUser) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
      this.reconnectAttempt += 1;
      this.log(`[helius-price] αποσυνδέθηκε — νέα προσπάθεια σε ${delay / 1000}s`);
      setTimeout(() => {
        if (!this.closedByUser) this.connect();
      }, delay).unref();
    });
  }

  close(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }

  subscribeWallet(address: string): void {
    this.wallets.add(address);
  }

  unsubscribeWallet(address: string): void {
    this.wallets.delete(address);
  }

  walletSubscriptions(): string[] {
    return [...this.wallets];
  }

  subscribeToken(mint: string): void {
    if (this.tokens.has(mint)) return;
    this.tokens.set(mint, { location: null, subIds: [], baseUi: null, quoteSol: null, attempts: 0 });
    this.enqueueResolve(mint);
  }

  unsubscribeToken(mint: string): void {
    const state = this.tokens.get(mint);
    if (state === undefined) return;
    this.tokens.delete(mint);
    this.dropSubscriptions(state);
  }

  /** Για logs/tests. */
  tokenCount(): { total: number; resolved: number } {
    let resolved = 0;
    for (const s of this.tokens.values()) if (s.location !== null) resolved += 1;
    return { total: this.tokens.size, resolved };
  }

  // ── εσωτερικά ────────────────────────────────────────────────────────────────────
  private enqueueResolve(mint: string): void {
    this.resolveQueue = this.resolveQueue
      .then(() => this.resolve(mint))
      .then(() => new Promise<void>((r) => setTimeout(r, RESOLVE_PACING_MS)))
      .catch(() => undefined);
  }

  private async resolve(mint: string): Promise<void> {
    const state = this.tokens.get(mint);
    if (state === undefined) return;
    state.attempts += 1;
    let location: PoolLocation | null = null;
    try {
      location = await locatePool(mint, this.rpc);
    } catch (error) {
      this.log(`[helius-price] ${mint.slice(0, 8)}: εύρεση pool απέτυχε (${error instanceof Error ? error.message : String(error)})`);
    }
    if (this.tokens.get(mint) !== state) return; // έγινε unsubscribe στο μεταξύ
    if (location === null) {
      if (state.attempts < MAX_RESOLVE_ATTEMPTS) setTimeout(() => this.enqueueResolve(mint), RESOLVE_RETRY_MS).unref();
      else this.log(`[helius-price] ${mint.slice(0, 8)}: δεν βρέθηκε Pump.fun curve / PumpSwap pool — καμία τιμή`);
      return;
    }
    state.location = location;
    if (location.kind === 'curve') {
      this.options.onTick(curveTick(mint, location.state, 0));
      if (location.state.complete) this.scheduleRecheck(mint);
    } else {
      state.baseUi = location.baseUi;
      state.quoteSol = location.quoteSol;
      const tick = ammTick(mint, location.baseUi, location.quoteSol, 0);
      if (tick !== null) this.options.onTick(tick);
    }
    if (this.socket?.readyState === OPEN) this.subscribeAccounts(mint, location);
  }

  /** Η curve ολοκληρώθηκε (graduation) → σε λίγο ψάχνουμε ξανά (τώρα θα βρεθεί το PumpSwap pool). */
  private scheduleRecheck(mint: string): void {
    setTimeout(() => {
      const state = this.tokens.get(mint);
      if (state === undefined) return;
      this.dropSubscriptions(state);
      state.location = null;
      state.attempts = 0;
      this.enqueueResolve(mint);
    }, GRADUATION_RECHECK_MS).unref();
  }

  private dropSubscriptions(state: TokenState): void {
    for (const id of state.subIds) {
      this.subs.delete(id);
      if (this.socket?.readyState === OPEN) {
        this.socket.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'accountUnsubscribe', params: [id] }));
      }
    }
    state.subIds = [];
  }

  private subscribeAccounts(mint: string, location: PoolLocation): void {
    if (location.kind === 'curve') this.sendSubscribe(mint, 'curve', location.curve, 'base64');
    else {
      this.sendSubscribe(mint, 'base', location.base, 'jsonParsed');
      this.sendSubscribe(mint, 'quote', location.quote, 'jsonParsed');
    }
  }

  private sendSubscribe(mint: string, role: Role, account: string, encoding: 'base64' | 'jsonParsed'): void {
    const id = this.nextId++;
    this.pending.set(id, { mint, role });
    this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [account, { encoding, commitment: 'confirmed' }] }));
  }

  private handleMessage(data: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      const state = this.tokens.get(p.mint);
      if (typeof msg.result === 'number' && state !== undefined) {
        this.subs.set(msg.result, p);
        state.subIds.push(msg.result);
      } else if (typeof msg.result !== 'number') {
        this.log(`[helius-price] αποτυχία συνδρομής ${p.mint.slice(0, 8)} (${p.role}): ${JSON.stringify(msg.error ?? msg.result).slice(0, 200)}`);
      }
      return;
    }
    if (msg.method !== 'accountNotification') return;
    const params = msg.params as { subscription?: number; result?: { context?: { slot?: number }; value?: { data?: unknown } } } | undefined;
    const sub = params?.subscription === undefined ? undefined : this.subs.get(params.subscription);
    if (sub === undefined) return;
    const state = this.tokens.get(sub.mint);
    const value = params?.result?.value;
    if (state === undefined || value === undefined) return;
    const slot = params?.result?.context?.slot ?? 0;
    if (sub.role === 'curve') {
      const buf = base64Data(value.data);
      const curve = buf === null ? null : decodeBondingCurve(buf);
      if (curve === null) return;
      if (curve.complete) {
        this.scheduleRecheck(sub.mint);
        return;
      }
      this.options.onTick(curveTick(sub.mint, curve, slot));
      return;
    }
    const amount = parsedTokenAmount(value.data);
    if (amount === null) return;
    if (sub.role === 'base') state.baseUi = amount;
    else state.quoteSol = amount;
    if (state.baseUi === null || state.quoteSol === null) return;
    const tick = ammTick(sub.mint, state.baseUi, state.quoteSol, slot);
    if (tick !== null) this.options.onTick(tick);
  }
}
