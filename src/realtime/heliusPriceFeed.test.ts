import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } from '../mirror/heliusTrade.js';
import type { SocketLike } from '../solana/heliusLogsListener.js';
import type { AccountInfoLite } from '../solana/heliusRpc.js';
import { ammTick, curveTick, decodeBondingCurve, HEARTBEAT_MS, HeliusPriceFeed, locatePool, type PoolRpc } from './heliusPriceFeed.js';
import { isGraduatedEvent, isDustGraduatedTrade, priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';

const MINT = 'MintPumpToken1111111111111111111111111111111';
const close = (a: number, b: number) => Math.abs(a / b - 1) < 1e-9;

function curveData(vTokRaw: bigint, vSolLamports: bigint, complete = false): string {
  const b = Buffer.alloc(49 + 32);
  b.writeBigUInt64LE(vTokRaw, 8);
  b.writeBigUInt64LE(vSolLamports, 16);
  b.writeUInt8(complete ? 1 : 0, 48);
  return b.toString('base64');
}
const tokenAcct = (owner: string, amount: number, decimals = 6): AccountInfoLite => ({
  owner: 'TokenProgram',
  lamports: 2_039_280,
  data: { parsed: { info: { owner, tokenAmount: { amount: String(BigInt(Math.round(amount * 10 ** decimals))), decimals } } } },
});

test('decodeBondingCurve: virtual reserves σε SOL / UI tokens και flag ολοκλήρωσης', () => {
  const s = decodeBondingCurve(Buffer.from(curveData(779_900_000_000_000n, 36_000_000_000n, true), 'base64'))!;
  assert.equal(s.virtualTokenReserves, 779_900_000);
  assert.equal(s.virtualSolReserves, 36);
  assert.equal(s.complete, true);
  assert.equal(decodeBondingCurve(Buffer.alloc(10)), null);
  // αδύνατες τιμές για bonding curve → null (όχι ψεύτικη τιμή)
  assert.equal(decodeBondingCurve(Buffer.from(curveData(5_000_000_000_000n, 40_000_000_000n), 'base64')), null, 'vTok 5M');
  assert.equal(decodeBondingCurve(Buffer.from(curveData(779_900_000_000_000n, 900_000_000_000n), 'base64')), null, 'vSol 900');
});

test('curveTick / ammTick: ίδιες μονάδες με το PumpPortal — curve = όχι graduated, PumpSwap = τιμή από marketCapSol', () => {
  const c = curveTick(MINT, { virtualTokenReserves: 779_900_000, virtualSolReserves: 36, complete: false }, 5);
  assert.equal(isGraduatedEvent(c), false);
  assert.ok(close(priceFromTradeEvent(c)!, 36 / 779_900_000));
  assert.equal(isDustGraduatedTrade(c), false);
  const a = ammTick(MINT, 100_000_000, 60, 6)!;
  assert.equal(isGraduatedEvent(a), true);
  assert.ok(close(priceFromTradeEvent(a)!, 60 / 100_000_000));
  assert.equal(ammTick(MINT, 0, 60, 1), null);
});

function fakeRpc(kind: 'curve' | 'amm' | 'none'): PoolRpc & { calls: number } {
  const rpc = {
    calls: 0,
    largest: async () => {
      rpc.calls += 1;
      return [{ address: 'WhaleATA' }, { address: 'PoolATA' }];
    },
    accounts: async (addresses: readonly string[], encoding: 'jsonParsed' | 'base64') => {
      rpc.calls += 1;
      if (encoding === 'jsonParsed') return [tokenAcct('Whale', 1_000_000), tokenAcct('PoolPDA', 100_000_000)];
      return addresses.map((a) =>
        a === 'PoolPDA'
          ? kind === 'none'
            ? { owner: 'OtherDex', lamports: 1, data: ['', 'base64'] }
            : {
                owner: kind === 'curve' ? PUMP_PROGRAM : PUMP_AMM_PROGRAM,
                lamports: 1,
                data: [curveData(779_900_000_000_000n, 36_000_000_000n), 'base64'],
              }
          : { owner: '11111111111111111111111111111111', lamports: 1, data: ['', 'base64'] },
      );
    },
    tokenAccountsByOwner: async (_owner: string, mint: string) => {
      rpc.calls += 1;
      assert.equal(mint, WSOL_MINT);
      return [{ pubkey: 'PoolQuote', account: tokenAcct('PoolPDA', 60, 9) }];
    },
  };
  return rpc;
}

test('locatePool: curve (owner στο Pump.fun πρόγραμμα), PumpSwap (wSOL του pool), αλλιώς null', async () => {
  const c = await locatePool(MINT, fakeRpc('curve'));
  assert.equal(c?.kind, 'curve');
  assert.equal(c?.kind === 'curve' && c.curve, 'PoolPDA');
  const a = await locatePool(MINT, fakeRpc('amm'));
  assert.deepEqual(a, { kind: 'amm', pool: 'PoolPDA', base: 'PoolATA', quote: 'PoolQuote', baseUi: 100_000_000, quoteSol: 60 });
  assert.equal(await locatePool(MINT, fakeRpc('none')), null);
});

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
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(obj: unknown): void {
    this.emit('message', JSON.stringify(obj));
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

test('HeliusPriceFeed: subscribeToken → εύρεση curve → αρχικό tick + accountSubscribe → tick σε κάθε αλλαγή → unsubscribe', async () => {
  const socket = new FakeSocket();
  const ticks: PumpPortalTradeEvent[] = [];
  const feed = new HeliusPriceFeed({ apiKey: 'k', onTick: (e) => ticks.push(e), log: () => undefined, createSocket: () => socket, rpc: fakeRpc('curve') });
  feed.connect();
  socket.open();
  feed.subscribeToken(MINT);
  feed.subscribeToken(MINT); // διπλό → αγνοείται
  await settle();
  assert.equal(ticks.length, 1, 'αρχική τιμή αμέσως');
  const sub = socket.sent.find((m) => m.method === 'accountSubscribe')!;
  assert.deepEqual((sub.params as unknown[])[0], 'PoolPDA');
  socket.message({ jsonrpc: '2.0', id: sub.id, result: 77 });
  socket.message({
    jsonrpc: '2.0',
    method: 'accountNotification',
    params: { subscription: 77, result: { context: { slot: 123 }, value: { data: [curveData(700_000_000_000_000n, 40_000_000_000n), 'base64'] } } },
  });
  assert.equal(ticks.length, 2);
  assert.ok(close(priceFromTradeEvent(ticks[1]!)!, 40 / 700_000_000));
  assert.equal(ticks[1]!.signature, `helius-tick:${MINT}:123`);
  feed.unsubscribeToken(MINT);
  assert.ok(socket.sent.some((m) => m.method === 'accountUnsubscribe' && (m.params as unknown[])[0] === 77));
  assert.deepEqual(feed.tokenCount(), { total: 0, resolved: 0 });
  feed.close();
});

test('HeliusPriceFeed: PumpSwap → δύο συνδρομές (tokens + wSOL του pool), tick όταν αλλάζει οποιοδήποτε', async () => {
  const socket = new FakeSocket();
  const ticks: PumpPortalTradeEvent[] = [];
  const feed = new HeliusPriceFeed({ apiKey: 'k', onTick: (e) => ticks.push(e), log: () => undefined, createSocket: () => socket, rpc: fakeRpc('amm') });
  feed.connect();
  socket.open();
  feed.subscribeToken(MINT);
  await settle();
  const subs = socket.sent.filter((m) => m.method === 'accountSubscribe');
  assert.deepEqual(subs.map((m) => (m.params as unknown[])[0]), ['PoolATA', 'PoolQuote']);
  socket.message({ jsonrpc: '2.0', id: subs[0]!.id, result: 1 });
  socket.message({ jsonrpc: '2.0', id: subs[1]!.id, result: 2 });
  socket.message({
    jsonrpc: '2.0',
    method: 'accountNotification',
    params: { subscription: 2, result: { context: { slot: 9 }, value: { data: tokenAcct('PoolPDA', 66, 9).data } } },
  });
  assert.equal(ticks.length, 2);
  assert.ok(close(priceFromTradeEvent(ticks[1]!)!, 66 / 100_000_000));
  // wallets: no-op, αλλά αναφέρονται (για το περιοδικό sync)
  feed.subscribeWallet('W');
  assert.deepEqual(feed.walletSubscriptions(), ['W']);
  feed.close();
});

test('HeliusPriceFeed heartbeat: σιωπηλό token ξαναστέλνει την τελευταία τιμή (για time_limit / timeout)', async () => {
  const socket = new FakeSocket();
  const ticks: PumpPortalTradeEvent[] = [];
  const feed = new HeliusPriceFeed({ apiKey: 'k', onTick: (e) => ticks.push(e), log: () => undefined, createSocket: () => socket, rpc: fakeRpc('curve') });
  feed.connect();
  socket.open();
  feed.subscribeToken(MINT);
  await settle();
  assert.equal(ticks.length, 1);
  const now = Date.now();
  assert.equal(feed.emitHeartbeats(now), 0, 'μόλις ήρθε τιμή — κανένα heartbeat');
  assert.equal(feed.emitHeartbeats(now + HEARTBEAT_MS + 1), 1);
  assert.equal(ticks.length, 2);
  assert.equal(priceFromTradeEvent(ticks[1]!), priceFromTradeEvent(ticks[0]!), 'ίδια τιμή');
  assert.ok(ticks[1]!.signature.startsWith(`helius-hb:${MINT}:`));
  assert.equal(feed.emitHeartbeats(now + HEARTBEAT_MS + 2), 0, 'το heartbeat μετράει σαν tick');
  feed.unsubscribeToken(MINT);
  assert.equal(feed.emitHeartbeats(now + 10 * HEARTBEAT_MS), 0);
  feed.close();
});
