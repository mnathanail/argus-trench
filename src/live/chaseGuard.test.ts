import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_ENTRY_PRICE_RUN, measurePriceRun, onchainFillPrice, priceRunAllowsLive, type ChaseRpc } from './chaseGuard.js';

function curveAccount(vTok: number, vSol: number): { owner: string; lamports: number; data: [string, 'base64'] } {
  const buf = Buffer.alloc(49);
  buf.writeBigUInt64LE(BigInt(Math.round(vTok * 1e6)), 8);
  buf.writeBigUInt64LE(BigInt(Math.round(vSol * 1e9)), 16);
  return { owner: 'pump', lamports: 0, data: [buf.toString('base64'), 'base64'] };
}

const rpcWith = (account: ReturnType<typeof curveAccount> | null): ChaseRpc => ({
  accounts: async () => [account],
  transaction: async () => null,
});

test('measurePriceRun: τωρινή τιμή καμπύλης ÷ τιμή σήματος − 1', async () => {
  const signal = 40 / 700_000_000;
  const run = await measurePriceRun(rpcWith(curveAccount(560_000_000, 50)), 'curve', signal);
  assert.ok(run !== null && Math.abs(run - (50 / 560_000_000 / signal - 1)) < 1e-9);
  assert.ok(run! > 0.5, 'έτρεξε πολύ');
  assert.equal(await measurePriceRun(rpcWith(null), 'curve', signal), null, 'λογαριασμός δεν βρέθηκε');
  assert.equal(await measurePriceRun(rpcWith(curveAccount(5_000_000_000, 50)), 'curve', signal), null, 'αδύνατη κατάσταση καμπύλης');
  assert.equal(await measurePriceRun(rpcWith(curveAccount(560_000_000, 50)), 'curve', 0), null);
});

test('priceRunAllowsLive: έως +10% live, πάνω ή άγνωστο → paper', () => {
  assert.equal(MAX_ENTRY_PRICE_RUN, 0.1);
  assert.equal(priceRunAllowsLive(0), true);
  assert.equal(priceRunAllowsLive(-0.05), true, 'έπεσε — φθηνότερα');
  assert.equal(priceRunAllowsLive(0.1), true);
  assert.equal(priceRunAllowsLive(0.16), false);
  assert.equal(priceRunAllowsLive(null), false);
  assert.equal(priceRunAllowsLive(Number.NaN), false);
});

test('onchainFillPrice: χωρίς συναλλαγή → null (το trade κρατά την τιμή σήματος)', async () => {
  assert.equal(await onchainFillPrice(rpcWith(null), 'sig', 'W'), null);
});
