import WebSocket from 'ws';
import { parseTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';

/**
 * Ελάχιστο interface που χρειαζόμαστε από ένα websocket — επιτρέπει injectable fake στα
 * tests, ίδιο σκεπτικό με το `SchedulerClock` στο scheduler.ts. Δεν είναι όλο το `ws.WebSocket`
 * API, μόνο ό,τι πραγματικά χρησιμοποιούμε.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  /** Standard WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED. */
  readonly readyState: number;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/**
 * Standard WebSocket readyState τιμή — βλ. σχόλιο στο `send()`. Πραγματικό incident
 * 2026-09-09: `connect()` ξεκινάει τη σύνδεση αλλά δεν την ολοκληρώνει αμέσως (το
 * handshake είναι ασύγχρονο). Ένα subscribe που καλείται πολύ νωρίς μετά το connect()
 * (π.χ. μετά από ένα γρήγορο DB await, όχι αρκετό χρόνο για το πραγματικό handshake)
 * έβρισκε το socket ΝΑ ΥΠΑΡΧΕΙ αλλά ΟΧΙ ακόμα OPEN — το πραγματικό ws.send() πετάει
 * exception σε αυτή την περίπτωση, ΟΧΙ σιωπηλή αποτυχία, και το exception ήταν
 * ασύλληπτο — ρίχνει ΟΛΟΚΛΗΡΟ το process σε κρας-loop σε κάθε εκκίνηση.
 */
const WS_OPEN = 1;

export type CreateSocket = (url: string) => WebSocketLike;

/**
 * Backoff πριν από κάθε reconnect προσπάθεια, με jitter — ίδιο σκεπτικό με το
 * scheduler.ts's `applyJitter`: αποφυγή resonance με τυχόν περιοδικό μοτίβο στην πλευρά
 * του PumpPortal. Το ίδιο το PumpPortal προειδοποιεί ρητά ότι αποσυνδέσεις συμβαίνουν
 * (network instability, server-side load rebalancing) — το reconnect logic ΔΕΝ είναι
 * προαιρετικό εδώ, είναι βασική απαίτηση.
 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface PumpPortalConnectionOptions {
  apiKey: string;
  onTradeEvent: (event: PumpPortalTradeEvent) => void;
  log?: (message: string) => void;
  /** Injectable για tests — default: πραγματικό ws.WebSocket. */
  createSocket?: CreateSocket;
  /** Injectable για tests — default: πραγματικό setTimeout. */
  scheduleReconnect?: (fn: () => void, delayMs: number) => void;
  /** Injectable για tests — default: Math.random. */
  random?: () => number;
}

/**
 * Μία, μόνιμη σύνδεση για όλο το process — ΟΧΙ μία ανά token/wallet. Θυμάται ποια
 * wallets/tokens έχουν ζητηθεί (`subscribedWallets`/`subscribedTokens`) ώστε μετά από
 * ΚΑΘΕ reconnect (μια φρέσκια σύνδεση ξεκινάει με μηδέν subscriptions στην πλευρά του
 * server) να τα ξαναζητήσει όλα αυτόματα — χωρίς αυτό, ένα απλό network blip θα
 * σταματούσε σιωπηλά όλη την παρακολούθηση χωρίς κανένα ορατό σφάλμα.
 */
export class PumpPortalConnection {
  private socket: WebSocketLike | null = null;
  private readonly subscribedWallets = new Set<string>();
  private readonly subscribedTokens = new Set<string>();
  private reconnectAttempt = 0;
  private closedByUser = false;

  private readonly createSocket: CreateSocket;
  private readonly scheduleReconnectFn: (fn: () => void, delayMs: number) => void;
  private readonly random: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: PumpPortalConnectionOptions) {
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.scheduleReconnectFn =
      options.scheduleReconnect ??
      ((fn, delayMs) => {
        setTimeout(fn, delayMs);
      });
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => {});
  }

  get subscribedWalletCount(): number {
    return this.subscribedWallets.size;
  }

  get subscribedTokenCount(): number {
    return this.subscribedTokens.size;
  }

  connect(): void {
    this.closedByUser = false;
    const url = `wss://pumpportal.fun/api/data?api-key=${this.options.apiKey}`;
    const socket = this.createSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.log('[pumpportal] συνδέθηκε');
      this.resubscribeAll();
    });

    socket.on('message', (raw) => {
      const event = this.tryParseMessage(raw);
      if (event !== null) this.options.onTradeEvent(event);
    });

    socket.on('close', () => {
      this.socket = null;
      if (this.closedByUser) return;
      this.log('[pumpportal] αποσυνδέθηκε — προγραμματίζεται reconnect');
      this.scheduleReconnectAttempt();
    });

    socket.on('error', (error) => {
      // Το 'close' ακολουθεί ούτως ή άλλως μετά από ένα error — το reconnect
      // προγραμματίζεται εκεί, όχι εδώ, ώστε να μην τρέξει διπλό reconnect.
      this.log(`[pumpportal] error: ${error.message}`);
    });
  }

  /** Οριστικό κλείσιμο — ΔΕΝ ξανασυνδέεται μετά από αυτό. */
  close(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }

  subscribeWallet(address: string): void {
    if (this.subscribedWallets.has(address)) return;
    this.subscribedWallets.add(address);
    this.send({ method: 'subscribeAccountTrade', keys: [address] });
  }

  unsubscribeWallet(address: string): void {
    if (!this.subscribedWallets.has(address)) return;
    this.subscribedWallets.delete(address);
    this.send({ method: 'unsubscribeAccountTrade', keys: [address] });
  }

  subscribeToken(mint: string): void {
    if (this.subscribedTokens.has(mint)) return;
    this.subscribedTokens.add(mint);
    this.send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  unsubscribeToken(mint: string): void {
    if (!this.subscribedTokens.has(mint)) return;
    this.subscribedTokens.delete(mint);
    this.send({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  private resubscribeAll(): void {
    for (const wallet of this.subscribedWallets) {
      this.send({ method: 'subscribeAccountTrade', keys: [wallet] });
    }
    for (const token of this.subscribedTokens) {
      this.send({ method: 'subscribeTokenTrade', keys: [token] });
    }
  }

  private send(payload: Record<string, unknown>): void {
    // Δύο ξεχωριστές περιπτώσεις όπου ΔΕΝ πρέπει να στείλουμε τώρα — και οι δύο είναι
    // εντάξει, όχι σφάλμα: (1) socket===null, καμία σύνδεση ακόμα· (2) socket υπάρχει
    // αλλά είναι ακόμα CONNECTING (πραγματικό incident 2026-09-09 — ρίξε ματιά στο
    // σχόλιο πάνω από το WS_OPEN). Και στις δύο περιπτώσεις, το subscribedWallets/Tokens
    // ήδη ενημερώθηκε πριν φτάσουμε εδώ — το resubscribeAll() στο επόμενο 'open' θα το
    // ξαναστείλει, δεν χάνεται τίποτα.
    if (this.socket === null || this.socket.readyState !== WS_OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private tryParseMessage(raw: unknown): PumpPortalTradeEvent | null {
    const text = typeof raw === 'string' ? raw : String(raw);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    return parseTradeEvent(json);
  }

  private scheduleReconnectAttempt(): void {
    const index = Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
    // Πάντα ένα valid index (Math.min το εγγυάται) — fallback εδώ μόνο για να
    // ικανοποιήσει το strict TS indexing, δεν είναι πραγματικά reachable.
    const base = RECONNECT_BACKOFF_MS[index] ?? 30_000;
    const jittered = Math.round(base * (0.85 + this.random() * 0.3));
    this.reconnectAttempt += 1;
    this.scheduleReconnectFn(() => this.connect(), jittered);
  }
}
