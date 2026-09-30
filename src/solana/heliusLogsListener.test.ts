import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HeliusLogsListener, type SocketLike } from './heliusLogsListener.js';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  private handlers = new Map<string, ((arg?: unknown) => void)[]>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener as (arg?: unknown) => void]);
    return this;
  }
  emit(event: string, arg?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  ping(): void {}
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(obj: unknown): void {
    this.emit('message', JSON.stringify(obj));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const got: [string, string][] = [];
  const timers: (() => void)[] = [];
  const listener = new HeliusLogsListener({
    wsUrl: 'wss://x',
    log: () => undefined,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    onSignature: (w, sig) => got.push([w, sig]),
    setTimer: (fn) => timers.push(fn),
    setRepeating: () => null,
    clearRepeating: () => undefined,
  });
  return { listener, sockets, got, timers };
}

const notif = (subscription: number, signature: string, err: unknown = null) => ({
  jsonrpc: '2.0',
  method: 'logsNotification',
  params: { subscription, result: { context: { slot: 1 }, value: { signature, err, logs: [] } } },
});

test('συνδρομή ανά wallet στο open, ειδοποίηση → onSignature, αποτυχημένες/διπλές κόβονται', () => {
  const { listener, sockets, got } = setup();
  listener.setWallets(['W1', 'W2']);
  listener.connect();
  const s = sockets[0]!;
  s.open();
  assert.equal(s.sent.length, 2);
  assert.deepEqual(s.sent[0]!.params, [{ mentions: ['W1'] }, { commitment: 'confirmed' }]);
  s.message({ jsonrpc: '2.0', id: s.sent[0]!.id, result: 101 });
  s.message({ jsonrpc: '2.0', id: s.sent[1]!.id, result: 102 });
  assert.equal(listener.activeSubscriptions, 2);

  s.message(notif(102, 'sigA'));
  s.message(notif(102, 'sigA')); // διπλή
  s.message(notif(101, 'sigB', { InstructionError: [0, 'x'] })); // αποτυχημένη
  s.message(notif(999, 'sigC')); // άγνωστη συνδρομή
  assert.deepEqual(got, [['W2', 'sigA']]);
});

test('νέο wallet όσο είναι ανοιχτό → subscribe αμέσως· αφαίρεση → logsUnsubscribe', () => {
  const { listener, sockets } = setup();
  listener.connect();
  const s = sockets[0]!;
  s.open();
  listener.addWallet('W3');
  assert.equal(s.sent.at(-1)!.method, 'logsSubscribe');
  s.message({ jsonrpc: '2.0', id: s.sent.at(-1)!.id, result: 7 });
  listener.setWallets([]);
  assert.equal(s.sent.at(-1)!.method, 'logsUnsubscribe');
  assert.deepEqual(s.sent.at(-1)!.params, [7]);
  assert.equal(listener.activeSubscriptions, 0);
});

test('αποσύνδεση → reconnect → ξανά συνδρομή σε όλα', () => {
  const { listener, sockets, timers } = setup();
  listener.setWallets(['W1']);
  listener.connect();
  sockets[0]!.open();
  sockets[0]!.emit('close');
  assert.equal(timers.length, 1);
  timers[0]!();
  const s2 = sockets[1]!;
  s2.open();
  assert.deepEqual(s2.sent[0]!.params, [{ mentions: ['W1'] }, { commitment: 'confirmed' }]);
});

test('close() από εμάς → κανένα reconnect', () => {
  const { listener, sockets, timers } = setup();
  listener.connect();
  sockets[0]!.open();
  listener.close();
  assert.equal(timers.length, 0);
});
