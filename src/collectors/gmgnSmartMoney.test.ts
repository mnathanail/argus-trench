import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SmartMoneyTrade } from '../gmgn/trackSmartmoney.js';
import { filterNewSmartMoneyTrades, HOLDER_RISK_MAX_PCT, isHighHolderRisk } from './gmgnSmartMoney.js';

function trade(overrides: Partial<SmartMoneyTrade> & { transactionHash: string }): SmartMoneyTrade {
  return {
    makerAddress: 'W1',
    side: 'buy',
    tokenAddress: 'TOKEN1',
    tokenSymbol: null,
    launchpad: null,
    amountUsd: null,
    tokenAmount: null,
    priceUsd: null,
    isOpenOrClose: 0,
    timestamp: 1_000,
    makerTags: [],
    ...overrides,
  };
}

test('filterNewSmartMoneyTrades drops trades already in the seen set', () => {
  const seen = new Set(['tx1']);
  const trades = [trade({ transactionHash: 'tx1' }), trade({ transactionHash: 'tx2' })];
  const fresh = filterNewSmartMoneyTrades(trades, seen);
  assert.deepEqual(
    fresh.map((t) => t.transactionHash),
    ['tx2'],
  );
});

test('filterNewSmartMoneyTrades dedupes within the same batch too (not just against the seen set)', () => {
  const seen = new Set<string>();
  const trades = [trade({ transactionHash: 'tx1' }), trade({ transactionHash: 'tx1' })];
  const fresh = filterNewSmartMoneyTrades(trades, seen);
  assert.equal(fresh.length, 1);
});

test('filterNewSmartMoneyTrades returns everything on an empty seen set', () => {
  const seen = new Set<string>();
  const trades = [trade({ transactionHash: 'tx1' }), trade({ transactionHash: 'tx2' })];
  assert.equal(filterNewSmartMoneyTrades(trades, seen).length, 2);
});

// --- isHighHolderRisk (φίλτρο εισόδου, ενεργό 2026-09-22) ---------------------------------

test('isHighHolderRisk: null (not checked / unassessable) never counts as high risk', () => {
  assert.equal(isHighHolderRisk(null), false);
});

test('isHighHolderRisk: below the 50% threshold passes through', () => {
  assert.equal(isHighHolderRisk(0.49), false);
  assert.equal(isHighHolderRisk(0), false);
  assert.equal(isHighHolderRisk(0.099), false);
});

test('isHighHolderRisk: exactly at the threshold is excluded (>=, not >)', () => {
  assert.equal(isHighHolderRisk(HOLDER_RISK_MAX_PCT), true);
  assert.equal(isHighHolderRisk(0.5), true);
});

test('isHighHolderRisk: above the threshold is excluded', () => {
  assert.equal(isHighHolderRisk(0.51), true);
  assert.equal(isHighHolderRisk(1), true);
});
