import WebSocket from 'ws';

/**
 * Solana `logsSubscribe` (mentions: [wallet]) πάνω σε Helius WebSocket — μία συνδρομή ανά
 * wallet (το RPC δέχεται μόνο ΕΝΑ address στο mentions). Για κάθε ΕΠΙΤΥΧΗΜΕΝΗ συναλλαγή
 * που αναφέρει το wallet καλεί onSignature(wallet, signature)· την ανάγνωση της συναλλαγής
 * την κάνει ο caller (getTransaction). Reconnect με backoff, ping κάθε 30″ (ο Helius κλείνει
 * αδρανείς συνδέσεις), επανεγγραφή όλων των wallets σε κάθε νέα σύνδεση.
 */

export interface SocketLike {
  on(event: 'open' | 'close', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string): void;
  ping(): void;
  close(): void;
  readonly readyState: number;
}

export interface HeliusLogsListenerOptions {
  wsUrl: string;
  /** `logs` = τα log messages της συναλλαγής από το notification (φιλτράρισμα ΠΡΙΝ το getTransaction). */
  onSignature: (wallet: string, signature: string, receivedAtMs: number, logs: readonly string[]) => void;
  log?: (line: string) => void;
  createSocket?: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  setRepeating?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearRepeating?: (handle: unknown) => void;
}

const OPEN = 1;
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const PING_INTERVAL_MS = 30_000;
const RECENT_SIGNATURES_MAX = 5_000;

export class HeliusLogsListener {
  private socket: SocketLike | null = null;
  private readonly wanted = new Set<string>();
  private readonly subIdToWallet = new Map<number, string>();
  private readonly walletToSubId = new Map<string, number>();
  private readonly pendingSubscribe = new Map<number, string>();
  private readonly recent = new Set<string>();
  private nextRequestId = 1;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private pingHandle: unknown = null;
  private readonly log: (line: string) => void;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly setRepeating: (fn: () => void, ms: number) => unknown;
  private readonly clearRepeating: (handle: unknown) => void;

  constructor(private readonly options: HeliusLogsListenerOptions) {
    this.log = options.log ?? ((line) => console.log(line));
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.setRepeating =
      options.setRepeating ??
      ((fn, ms) => {
        const h = setInterval(fn, ms);
        h.unref();
        return h;
      });
    this.clearRepeating = options.clearRepeating ?? ((h) => clearInterval(h as NodeJS.Timeout));
  }

  /** Πόσα wallets έχουν ενεργή (επιβεβαιωμένη) συνδρομή. */
  get activeSubscriptions(): number {
    return this.walletToSubId.size;
  }

  connect(): void {
    this.closedByUser = false;
    const socket = this.createSocket(this.options.wsUrl);
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectAttempt = 0;
      this.subIdToWallet.clear();
      this.walletToSubId.clear();
      this.pendingSubscribe.clear();
      this.log(`[helius] συνδέθηκε — συνδρομή σε ${this.wanted.size} wallets`);
      for (const wallet of this.wanted) this.sendSubscribe(wallet);
      if (this.pingHandle !== null) this.clearRepeating(this.pingHandle);
      this.pingHandle = this.setRepeating(() => {
        if (this.socket?.readyState === OPEN) this.socket.ping();
      }, PING_INTERVAL_MS);
    });

    socket.on('message', (data) => this.handleMessage(data));

    socket.on('error', (error) => {
      this.log(`[helius] σφάλμα socket: ${error.message}`);
    });

    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.pingHandle !== null) {
        this.clearRepeating(this.pingHandle);
        this.pingHandle = null;
      }
      this.subIdToWallet.clear();
      this.walletToSubId.clear();
      this.pendingSubscribe.clear();
      if (this.closedByUser) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!;
      this.reconnectAttempt += 1;
      this.log(`[helius] αποσυνδέθηκε — νέα προσπάθεια σε ${delay / 1000}s`);
      this.setTimer(() => {
        if (!this.closedByUser) this.connect();
      }, delay);
    });
  }

  close(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }

  addWallet(wallet: string): void {
    if (this.wanted.has(wallet)) return;
    this.wanted.add(wallet);
    if (this.socket?.readyState === OPEN) this.sendSubscribe(wallet);
  }

  removeWallet(wallet: string): void {
    if (!this.wanted.delete(wallet)) return;
    const subId = this.walletToSubId.get(wallet);
    if (subId === undefined) return;
    this.walletToSubId.delete(wallet);
    this.subIdToWallet.delete(subId);
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id: this.nextRequestId++, method: 'logsUnsubscribe', params: [subId] }));
    }
  }

  /** Συγχρονίζει με την τρέχουσα λίστα (προσθέτει νέα, αφαιρεί όσα έφυγαν). */
  setWallets(wallets: readonly string[]): void {
    const next = new Set(wallets);
    for (const w of [...this.wanted]) if (!next.has(w)) this.removeWallet(w);
    for (const w of next) this.addWallet(w);
  }

  private sendSubscribe(wallet: string): void {
    const id = this.nextRequestId++;
    this.pendingSubscribe.set(id, wallet);
    this.socket?.send(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [wallet] }, { commitment: 'confirmed' }] }),
    );
  }

  private handleMessage(data: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this.pendingSubscribe.has(msg.id)) {
      const wallet = this.pendingSubscribe.get(msg.id)!;
      this.pendingSubscribe.delete(msg.id);
      if (typeof msg.result === 'number' && this.wanted.has(wallet)) {
        this.subIdToWallet.set(msg.result, wallet);
        this.walletToSubId.set(wallet, msg.result);
      } else {
        this.log(`[helius] αποτυχία συνδρομής ${wallet.slice(0, 8)}: ${JSON.stringify(msg.error ?? msg.result).slice(0, 200)}`);
      }
      return;
    }
    if (msg.method !== 'logsNotification') return;
    const params = msg.params as { subscription?: number; result?: { value?: { signature?: string; err?: unknown; logs?: unknown } } } | undefined;
    const wallet = params?.subscription === undefined ? undefined : this.subIdToWallet.get(params.subscription);
    const value = params?.result?.value;
    if (wallet === undefined || value === undefined || typeof value.signature !== 'string') return;
    if (value.err !== null && value.err !== undefined) return; // αποτυχημένη συναλλαγή
    const key = `${wallet}:${value.signature}`;
    if (this.recent.has(key)) return;
    this.recent.add(key);
    if (this.recent.size > RECENT_SIGNATURES_MAX) {
      const first = this.recent.values().next().value;
      if (first !== undefined) this.recent.delete(first);
    }
    const logs = Array.isArray(value.logs) ? value.logs.filter((l): l is string => typeof l === 'string') : [];
    this.options.onSignature(wallet, value.signature, Date.now(), logs);
  }
}
