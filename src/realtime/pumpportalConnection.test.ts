import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PumpPortalConnection, type WebSocketLike } from './pumpportalConnection.js';

const REAL_BUY_EVENT = {
  signature: 'sig1',
  mint: 'TokenMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
  traderPublicKey: 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
  txType: 'buy',
  tokenAmount: 100,
  solAmount: 1,
  vTokensInBondingCurve: 500_000_000,
  vSolInBondingCurve: 50,
  marketCapSol: 100,
  pool: 'pump',
};

/** Strict TS array indexing επιστρέφει `T | undefined` — αυτό βεβαιώνει και επιστρέφει `T`. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  assert.ok(value !== undefined, `περίμενα στοιχείο στο index ${index}`);
  return value;
}

/** Fake socket — καταγράφει ό,τι στέλνεται, επιτρέπει στο test να προσομοιώσει events.
 * Προσομοιώνει σωστά CONNECTING(0)→OPEN(1)→CLOSED(3), και ρίχνει exception σε send()
 * όταν δεν είναι OPEN — ΑΚΡΙΒΩΣ όπως το πραγματικό `ws` (πραγματικό incident
 * 2026-09-09: το production code δεν το πρόσεχε αυτό, το fake socket ΔΕΝ το
 * προσομοίωνε, άρα το test suite δεν το έπιασε πριν το deploy). */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  readyState = 0; // CONNECTING, ίδιο με πραγματικό ws.WebSocket στη δημιουργία
  private openListener: (() => void) | null = null;
  private messageListener: ((data: unknown) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error(`WebSocket is not open: readyState ${this.readyState} (CONNECTING)`);
    }
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  on(event: string, listener: never): void {
    if (event === 'open') this.openListener = listener;
    else if (event === 'message') this.messageListener = listener;
    else if (event === 'close') this.closeListener = listener;
    else if (event === 'error') this.errorListener = listener;
  }
  triggerOpen(): void {
    this.readyState = 1;
    this.openListener?.();
  }
  triggerMessage(payload: unknown): void {
    this.messageListener?.(JSON.stringify(payload));
  }
  triggerClose(): void {
    this.readyState = 3;
    this.closeListener?.();
  }
  triggerError(error: Error): void {
    this.errorListener?.(error);
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const reconnectCalls: { fn: () => void; delayMs: number }[] = [];
  const events: unknown[] = [];

  const conn = new PumpPortalConnection({
    apiKey: 'test-key',
    onTradeEvent: (e) => events.push(e),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    scheduleReconnect: (fn, delayMs) => reconnectCalls.push({ fn, delayMs }),
    random: () => 0.5,
  });

  return { conn, sockets, reconnectCalls, events };
}

test('subscribeWallet before connect() sends nothing yet, but is remembered', () => {
  const { conn, sockets } = setup();
  conn.subscribeWallet('WalletA');
  assert.equal(sockets.length, 0);
  assert.equal(conn.subscribedWalletCount, 1);
});

test('on open, resubscribeAll sends everything that was subscribed before connecting', () => {
  const { conn, sockets } = setup();
  conn.subscribeWallet('WalletA');
  conn.subscribeToken('TokenA');
  conn.connect();
  at(sockets, 0).triggerOpen();

  assert.deepEqual(at(sockets, 0).sent.map((s) => JSON.parse(s)), [
    { method: 'subscribeAccountTrade', keys: ['WalletA'] },
    { method: 'subscribeTokenTrade', keys: ['TokenA'] },
  ]);
});

test('REGRESSION 2026-09-09: subscribing right after connect(), before the socket has actually opened, must not throw and must crash-loop the process', () => {
  // Πραγματικό production incident: connect() ξεκινάει το handshake αλλά δεν το
  // ολοκληρώνει αμέσως· ένα subscribe που φτάνει όσο είναι ακόμα CONNECTING (readyState
  // 0) έριξε ολόκληρο το process σε crash-loop, γιατί το πραγματικό ws.send() πετάει
  // exception αν δεν είναι OPEN — δεν αποτυγχάνει σιωπηλά. Το fake socket εδώ
  // αναπαράγει ΑΚΡΙΒΩΣ αυτή τη συμπεριφορά (readyState=0 στη δημιουργία, send()
  // πετάει αν δεν είναι 1/OPEN) — αν το production guard λείπει ή είναι λάθος, αυτό
  // το test θα ρίξει, όχι απλά θα αποτύχει σε ένα assertion.
  const { conn, sockets } = setup();
  conn.connect();
  assert.equal(at(sockets, 0).readyState, 0, 'το fake socket ξεκινάει CONNECTING, ίδιο με πραγματικό ws');

  assert.doesNotThrow(() => {
    conn.subscribeToken('TokenA');
    conn.subscribeWallet('WalletA');
  });
  assert.equal(at(sockets, 0).sent.length, 0, 'τίποτα δεν έπρεπε να σταλεί ενώ ήταν ακόμα CONNECTING');

  // Μόλις ανοίξει πραγματικά, η συνδρομή πρέπει να έχει διατηρηθεί και να στέλνεται τώρα.
  at(sockets, 0).triggerOpen();
  assert.deepEqual(at(sockets, 0).sent.map((s) => JSON.parse(s)), [
    { method: 'subscribeAccountTrade', keys: ['WalletA'] },
    { method: 'subscribeTokenTrade', keys: ['TokenA'] },
  ]);
});

test('subscribing the same wallet twice sends only one message', () => {
  const { conn, sockets } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();
  conn.subscribeWallet('WalletA');
  conn.subscribeWallet('WalletA');
  assert.equal(at(sockets, 0).sent.length, 1);
});

test('unsubscribing something never subscribed sends nothing', () => {
  const { conn, sockets } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();
  conn.unsubscribeToken('NeverSubscribed');
  assert.equal(at(sockets, 0).sent.length, 0);
});

test('a real trade event is parsed and dispatched to onTradeEvent', () => {
  const { conn, sockets, events } = setup();
  conn.connect();
  at(sockets, 0).triggerMessage(REAL_BUY_EVENT);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], REAL_BUY_EVENT);
});

test('the subscription-ack message does not fire onTradeEvent (not a trade)', () => {
  const { conn, sockets, events } = setup();
  conn.connect();
  at(sockets, 0).triggerMessage({ message: 'Successfully subscribed to keys.' });
  assert.equal(events.length, 0);
});

test('on disconnect, a reconnect is scheduled with the first backoff step (jittered)', () => {
  const { conn, sockets, reconnectCalls } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();
  at(sockets, 0).triggerClose();

  assert.equal(reconnectCalls.length, 1);
  assert.equal(at(reconnectCalls, 0).delayMs, 1000);
});

test('reconnecting resubscribes everything that was subscribed before the disconnect — the whole point of tracking state', () => {
  const { conn, sockets, reconnectCalls } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();
  conn.subscribeWallet('WalletA');
  conn.subscribeToken('TokenA');

  at(sockets, 0).triggerClose();
  at(reconnectCalls, 0).fn();
  assert.equal(sockets.length, 2, 'πρέπει να δημιουργήθηκε νέο socket');

  at(sockets, 1).triggerOpen();
  assert.deepEqual(at(sockets, 1).sent.map((s) => JSON.parse(s)), [
    { method: 'subscribeAccountTrade', keys: ['WalletA'] },
    { method: 'subscribeTokenTrade', keys: ['TokenA'] },
  ]);
});

test('backoff escalates across consecutive disconnects, resets to the first step after a successful open', () => {
  const { conn, sockets, reconnectCalls } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();

  at(sockets, 0).triggerClose();
  assert.equal(at(reconnectCalls, 0).delayMs, 1000);
  at(reconnectCalls, 0).fn();

  at(sockets, 1).triggerClose();
  assert.equal(at(reconnectCalls, 1).delayMs, 2000, 'δεύτερο βήμα backoff');
  at(reconnectCalls, 1).fn();

  at(sockets, 2).triggerOpen();
  at(sockets, 2).triggerClose();
  assert.equal(at(reconnectCalls, 2).delayMs, 1000, 'reset στο πρώτο βήμα μετά από επιτυχές open');
});

test('close() is final — a close event after it does not schedule a reconnect', () => {
  const { conn, sockets, reconnectCalls } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();
  conn.close();
  assert.equal(at(sockets, 0).closed, true);

  at(sockets, 0).triggerClose();
  assert.equal(reconnectCalls.length, 0, 'όχι reconnect μετά από σκόπιμο close()');
});

test('unsubscribeWallet removes from tracked state — a later reconnect does not resubscribe it', () => {
  const { conn, sockets, reconnectCalls } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();
  conn.subscribeWallet('WalletA');
  conn.unsubscribeWallet('WalletA');
  assert.equal(conn.subscribedWalletCount, 0);

  at(sockets, 0).triggerClose();
  at(reconnectCalls, 0).fn();
  at(sockets, 1).triggerOpen();
  assert.equal(at(sockets, 1).sent.length, 0, 'δεν πρέπει να ξανασυνδρομήσει κάτι που αποσυνδρομήθηκε');
});

test('an error event alone does not double-schedule a reconnect (close follows separately)', () => {
  const { conn, sockets, reconnectCalls } = setup();
  conn.connect();
  at(sockets, 0).triggerOpen();
  at(sockets, 0).triggerError(new Error('boom'));
  assert.equal(reconnectCalls.length, 0, 'το error μόνο του δεν προγραμματίζει reconnect');
  at(sockets, 0).triggerClose();
  assert.equal(reconnectCalls.length, 1, 'το close μετά από error προγραμματίζει κανονικά');
});
