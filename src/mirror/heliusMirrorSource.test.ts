import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import type { ParsedTransaction } from '../solana/heliusRpc.js';
import { processHeliusSignature, type HeliusMirrorSourceDeps } from './heliusMirrorSource.js';
import { PUMP_PROGRAM } from './heliusTrade.js';
import type { MirrorOutcome } from './mirrorHandler.js';

const W = '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5';
const S = 1e9;

const buyTx: ParsedTransaction = {
  blockTime: 1_800_000_000,
  meta: {
    err: null,
    fee: 5_000,
    preBalances: [10 * S, 0, 5 * S, 1],
    postBalances: [10 * S - 0.5 * S - 2_039_280 - 5_000, 2_039_280, 5.5 * S, 1],
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 1, owner: W, mint: 'MintX', uiTokenAmount: { amount: '5000000000', decimals: 6 } }],
  },
  transaction: { signatures: ['sigX'], message: { accountKeys: [W, 'ATA', 'Curve', PUMP_PROGRAM].map((pubkey) => ({ pubkey })) } },
};

function deps(tx: ParsedTransaction | null) {
  const handled: [PumpPortalTradeEvent, Record<string, unknown>][] = [];
  const outcomes: MirrorOutcome[] = [];
  const d: HeliusMirrorSourceDeps = {
    fetchTx: async () => tx,
    handle: async (event, extra) => {
      handled.push([event, extra]);
      return { kind: 'opened', wallet: W, walletName: 'k', token: event.mint, ourSol: 0.1 };
    },
    onOutcome: async (o) => {
      outcomes.push(o);
    },
    nowMs: () => 1_800_000_001_500,
    log: () => undefined,
  };
  return { d, handled, outcomes };
}

test('processHeliusSignature: αγορά → handler με lag_sec και πρόγραμμα, outcome προωθείται', async () => {
  const { d, handled, outcomes } = deps(buyTx);
  await processHeliusSignature(W, 'sigX', d);
  assert.equal(handled.length, 1);
  const [event, extra] = handled[0]!;
  assert.equal(event.txType, 'buy');
  assert.equal(event.mint, 'MintX');
  assert.equal(event.solAmount, 0.5);
  assert.equal(extra.lag_sec, 1.5);
  assert.equal(extra.program, 'pump');
  assert.equal(extra.sol_source, 'pool');
  assert.equal(outcomes.length, 1);
});

test('processHeliusSignature: όχι trade ή tx null → τίποτα', async () => {
  const noTrade = deps({ ...buyTx, meta: { ...buyTx.meta!, postTokenBalances: [] } });
  await processHeliusSignature(W, 'sigX', noTrade.d);
  assert.equal(noTrade.handled.length, 0);
  const missing = deps(null);
  await processHeliusSignature(W, 'sigX', missing.d);
  assert.equal(missing.handled.length, 0);
});
