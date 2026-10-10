import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildEntryTiming,
  decideEntry,
  entriesInFlightCount,
  IN_FLIGHT,
  withTokenEntryLock,
  type EntryWalletInput,
} from './realtimeEntryHandler.js';
import { fallbackOutcomeFor } from '../live/liveEntryExecution.js';
import type { PumpPortalTradeEvent } from './pumpportalEvents.js';

const WALLET = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const TOKEN = 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';

function activeWallet(overrides: Partial<EntryWalletInput> = {}): EntryWalletInput {
  return {
    address: WALLET,
    active: true,
    winRate: 0.6,
    pnlMultiplier: 0.3,
    tradeCount: 40,
    source: 'smart_money',
    name: null,
    ...overrides,
  };
}

function buyEvent(overrides: Partial<PumpPortalTradeEvent> = {}): PumpPortalTradeEvent {
  return {
    signature: 'sig',
    mint: TOKEN,
    traderPublicKey: WALLET,
    txType: 'buy',
    tokenAmount: 100,
    solAmount: 1,
    vTokensInBondingCurve: 1,
    vSolInBondingCurve: 0.00001, // τιμή ρητά μικρή, ασήμαντη για αυτά τα tests
    marketCapSol: 100,
    pool: 'pump',
    ...overrides,
  };
}

test('enters when everything checks out: buy, active wallet, gated token, room under the cap', () => {
  const decision = decideEntry(buyEvent(), activeWallet(), true, 5);
  assert.equal(decision.type, 'enter');
  if (decision.type === 'enter') assert.equal(decision.entryPrice, 0.00001);
});

test('skips a sell event — only buys open new positions', () => {
  const decision = decideEntry(buyEvent({ txType: 'sell' }), activeWallet(), true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('skips when the wallet is unknown (null) — defensive, should not normally happen for a subscribed wallet', () => {
  const decision = decideEntry(buyEvent(), null, true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('ΕΥΡΗΜΑ-style guard: skips a buy from a wallet that was deactivated after we subscribed it', () => {
  const decision = decideEntry(buyEvent(), activeWallet({ active: false }), true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('skips when the token has not (yet) passed the gate', () => {
  const decision = decideEntry(buyEvent(), activeWallet(), false, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('skips when the open-trades cap has been reached', () => {
  const decision = decideEntry(buyEvent(), activeWallet(), true, 800);
  assert.deepEqual(decision, { type: 'skip' });
});

test('ΑΛΛΑΓΗ 2026-09-27: a token already migrated off the bonding curve now ENTERS, flagged graduated, priced from the trade (solAmount/tokenAmount)', () => {
  const decision = decideEntry(buyEvent({ pool: 'raydium' }), activeWallet(), true, 5);
  assert.deepEqual(decision, { type: 'enter', entryPrice: 1 / 100, graduated: true });
});

test('a bonding-curve entry is flagged graduated=false', () => {
  const decision = decideEntry(buyEvent(), activeWallet(), true, 5);
  assert.equal(decision.type, 'enter');
  if (decision.type === 'enter') assert.equal(decision.graduated, false);
});

test('skips a graduated DUST buy — no trustworthy price', () => {
  const decision = decideEntry(buyEvent({ pool: 'raydium', solAmount: 0.0009 }), activeWallet(), true, 5);
  assert.deepEqual(decision, { type: 'skip' });
});

test('ΑΛΛΑΓΗ 2026-09-27: ENTERS (graduated) when the bonding-curve fields are entirely absent — the real post-graduation PumpPortal shape', () => {
  const decision = decideEntry(
    buyEvent({
      vTokensInBondingCurve: undefined,
      vSolInBondingCurve: undefined,
      marketCapSol: undefined,
      pool: undefined,
    }),
    activeWallet(),
    true,
    5,
  );
  assert.deepEqual(decision, { type: 'enter', entryPrice: 1 / 100, graduated: true });
});

test('uses the real event price (vSol/vTokens), not any placeholder', () => {
  const decision = decideEntry(
    buyEvent({ vSolInBondingCurve: 53.93797509913754, vTokensInBondingCurve: 596796597.218102 }),
    activeWallet(),
    true,
    5,
  );
  assert.equal(decision.type, 'enter');
  if (decision.type === 'enter') {
    assert.ok(Math.abs(decision.entryPrice - 9.0393e-8) / 9.0393e-8 < 0.01);
  }
});

// --- 2026-09-28: ΕΝΑ entry ανά token (πραγματικό incident: διπλές/τριπλές live αγορές) ---

test('withTokenEntryLock: a second concurrent entry for the SAME token is refused (the 150ms double-buy case)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const first = withTokenEntryLock('MintA', async () => { calls += 1; await gate; return 'first'; });
  const second = await withTokenEntryLock('MintA', async () => { calls += 1; return 'second'; });
  assert.equal(second, IN_FLIGHT);
  release();
  assert.equal(await first, 'first');
  assert.equal(calls, 1, 'η δεύτερη αγορά δεν πρέπει να εκτελεστεί καθόλου');
});

test('withTokenEntryLock: different tokens run concurrently', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = withTokenEntryLock('MintB', async () => { await gate; return 'b'; });
  const c = await withTokenEntryLock('MintC', async () => 'c');
  assert.equal(c, 'c');
  release();
  assert.equal(await a, 'b');
});

test('withTokenEntryLock: the lock is released even if the entry throws', async () => {
  await assert.rejects(withTokenEntryLock('MintD', async () => { throw new Error('swap failed'); }));
  assert.equal(entriesInFlightCount(), 0);
  assert.equal(await withTokenEntryLock('MintD', async () => 'again'), 'again');
});

// --- 2026-09-28: entry_timing_json ---

const TIMING_EVENT: PumpPortalTradeEvent = {
  signature: 'sig1', mint: 'MintT', traderPublicKey: 'W', txType: 'buy', tokenAmount: 1000, solAmount: 0.5,
  vSolInBondingCurve: 30, vTokensInBondingCurve: 1_000_000_000, marketCapSol: 30, pool: 'pump',
};

test('buildEntryTiming: live entry records signal vs executed price and the live timing', () => {
  const t = buildEntryTiming(
    TIMING_EVENT,
    { type: 'enter', entryPrice: 0.00000003, graduated: false },
    'discovery',
    { receivedAt: Date.now() - 2500, lookupMs: 12, onDemandGateMs: null },
    8,
    2400,
    {
      mode: 'live', actualEntryAmountSol: 0.05, entryPrice: 0.0000000315, liveStrategyOrderId: null,
      nativeOrderVerified: false, killSwitchJustTriggered: false, fallbackReason: null, walletAddress: 'W',
      timing: {
        walletQueueMs: 0, walletExecMs: 900, riskGateMs: 5, reserveMs: 4,
        swap: { submitQueueMs: 0, submitExecMs: 1300, confirmMs: 0, initialStatus: 'successful' },
        postSwapMs: 5000, totalMs: 7200, txHash: 'tx', reportInputSol: 0.05, reportGasSol: 0.00004,
        balanceDiffSol: 0.0521, priorityFeeSol: 0.00002, tipFeeSol: 0.00002,
      },
    },
  );
  assert.equal(t['mode'], 'live');
  assert.equal(t['gate_source'], 'discovery');
  assert.ok(Math.abs((t['slippage_vs_signal'] as number) - 0.05) < 1e-9);
  assert.equal((t['signal'] as Record<string, unknown>)['mcap_sol'], 30);
  assert.ok(((t['ms'] as Record<string, number>)['event_to_insert'] ?? 0) >= 2500);
  assert.equal((t['live'] as Record<string, unknown>)['walletExecMs'], 900);
});

test('buildEntryTiming: paper fallback keeps the reason, no slippage', () => {
  const t = buildEntryTiming(
    TIMING_EVENT,
    { type: 'enter', entryPrice: 0.00000003, graduated: false },
    'on_demand',
    { receivedAt: Date.now(), lookupMs: 10, onDemandGateMs: 1100 },
    5,
    0,
    fallbackOutcomeFor('on_demand_gate_paper_only'),
  );
  assert.equal(t['fallback_reason'], 'on_demand_gate_paper_only');
  assert.equal(t['slippage_vs_signal'], null);
  assert.equal((t['ms'] as Record<string, number>)['on_demand_gate'], 1100);
});

// --- 2026-09-29: holder risk στο entry_timing_json ---
import { holderRiskJson } from './realtimeEntryHandler.js';
import { isHighHolderRisk } from '../decision/holderRiskCheck.js';

test('holderRiskJson: stable names for the report; null risk is never "high"', () => {
  assert.deepEqual(holderRiskJson({ riskPct: 0.62, riskWalletCount: 14, checked: true }, 840, 'record'), {
    pct: 0.62, wallet_count: 14, checked: true, mode: 'record', ms: 840,
  });
  assert.equal(isHighHolderRisk(0.62), true);
  assert.equal(isHighHolderRisk(0.49), false);
  assert.equal(isHighHolderRisk(null), false);
});

// --- recordEntrySkip (2026-09-30, migration 0022) ---------------------------------------
import { recordEntrySkip } from './realtimeEntryHandler.js';
import type { RealtimeEntrySkip } from '../db/repositories/realtimeEntrySkips.js';

test('recordEntrySkip stores wallet, token, reason, pool and whether bonding-curve data was present', async () => {
  const saved: RealtimeEntrySkip[] = [];
  const insert = async (s: RealtimeEntrySkip): Promise<void> => {
    saved.push(s);
  };
  recordEntrySkip(buyEvent(), 'gate_not_passed', { on_demand: 'failed' }, insert);
  recordEntrySkip(buyEvent({ pool: 'pump-amm', vTokensInBondingCurve: undefined }), 'graduated_off', null, insert);
  await new Promise((r) => setImmediate(r));
  assert.equal(saved.length, 2);
  assert.equal(saved[0]?.reason, 'gate_not_passed');
  assert.equal(saved[0]?.hasCurveData, true);
  assert.deepEqual(saved[0]?.detail, { on_demand: 'failed' });
  assert.equal(saved[1]?.pool, 'pump-amm');
  assert.equal(saved[1]?.hasCurveData, false);
});

test('recordEntrySkip never throws when the insert fails', async () => {
  recordEntrySkip(buyEvent(), 'x', null, async () => {
    throw new Error('db down');
  });
  await new Promise((r) => setImmediate(r));
});

// --- 2026-10-04: MIN_WALLET_BUY_SOL ---
import { isWalletBuyTooSmall } from './realtimeEntryHandler.js';

test('isWalletBuyTooSmall: < 0.3 SOL κόβεται, 0.3+ περνάει, άγνωστο ποσό δεν κόβεται', () => {
  assert.equal(isWalletBuyTooSmall({ solAmount: 0.29 }), true);
  assert.equal(isWalletBuyTooSmall({ solAmount: 0.3 }), false);
  assert.equal(isWalletBuyTooSmall({ solAmount: 2 }), false);
  assert.equal(isWalletBuyTooSmall({ solAmount: Number.NaN }), false);
});

// --- 2026-10-05: live μόνο on-demand ---
import { paperOnlyReason } from './realtimeEntryHandler.js';

test('paperOnlyReason: σημερινές σημαίες → on-demand live, discovery paper, graduated paper', () => {
  assert.equal(paperOnlyReason(false, 'on_demand'), null);
  assert.equal(paperOnlyReason(false, 'discovery'), 'discovery_gate_paper_only');
  assert.equal(paperOnlyReason(true, 'on_demand'), 'graduated_paper_only');
});

test('paperOnlyReason: κάθε σημαία ανεξάρτητη', () => {
  const all = { graduated: true, onDemand: true, discovery: true };
  assert.equal(paperOnlyReason(true, 'discovery', all), null);
  assert.equal(paperOnlyReason(false, 'on_demand', { ...all, onDemand: false }), 'on_demand_gate_paper_only');
});

// --- 2026-10-06: paper πείραμα (PAPER_EXPERIMENT_ENABLED) ---
import { experimentTags, experimentTimingJson } from './realtimeEntryHandler.js';
import { PAPER_EXPERIMENT_ENABLED } from '../decision/paperTradingConfig.js';

test('experimentTags: μία ετικέτα ανά λόγο που θα κοβόταν, κενό για κανονικό σήμα', () => {
  assert.deepEqual(experimentTags({ relaxedGate: false, smallBuy: false, graduated: false }), []);
  assert.deepEqual(experimentTags({ relaxedGate: true, smallBuy: true, graduated: false }), ['relaxed_gate', 'small_buy']);
  assert.deepEqual(experimentTags({ relaxedGate: false, smallBuy: false, graduated: true }), ['graduated']);
});

test('paperOnlyReason: πειραματικό σήμα ή χωρίς gate → ΠΟΤΕ live, ακόμα κι αν όλες οι live σημαίες είναι true', () => {
  const all = { graduated: true, onDemand: true, discovery: true };
  assert.equal(paperOnlyReason(false, 'on_demand', all, ['small_buy']), 'experiment_paper_only');
  assert.equal(paperOnlyReason(false, 'none', all), 'experiment_paper_only');
  assert.equal(paperOnlyReason(true, 'discovery', all, ['graduated']), 'experiment_paper_only');
  assert.equal(paperOnlyReason(false, 'on_demand', all, []), null, 'κανονικό σήμα όπως πριν');
});

test('experimentTimingJson: πεδία ΜΟΝΟ στα πειραματικά trades (με αυτά ξεχωρίζουν στη βάση)', () => {
  assert.deepEqual(experimentTimingJson([], null, 'passed'), {});
  assert.deepEqual(experimentTimingJson(['relaxed_gate'], 'bundler_trader_amount_rate 0.45 > max 0.3', 'failed'), {
    experiment: ['relaxed_gate'],
    gate_fail_reason: 'bundler_trader_amount_rate 0.45 > max 0.3',
    on_demand_outcome: 'failed',
  });
});

test('PAPER_EXPERIMENT_ENABLED: τέλος πειράματος 2026-10-07 (−2.77 SOL σε 418 trades)', () => {
  assert.equal(PAPER_EXPERIMENT_ENABLED, false);
});

test('realisticPaperEntryPrice: τωρινή τιμή καμπύλης + 2% όταν μετρήθηκε, αλλιώς σήμα + 3%', async () => {
  const { realisticPaperEntryPrice } = await import('./realtimeEntryHandler.js');
  const r = realisticPaperEntryPrice(1e-8, 0.25);
  assert.equal(r.basis, 'curve_now');
  assert.ok(Math.abs(r.price - 1e-8 * 1.25 * 1.02) < 1e-20);
  const s = realisticPaperEntryPrice(1e-8, null);
  assert.equal(s.basis, 'signal');
  assert.ok(Math.abs(s.price - 1e-8 * 1.03) < 1e-20);
  assert.equal(realisticPaperEntryPrice(1e-8, Number.NaN).basis, 'signal');
});
