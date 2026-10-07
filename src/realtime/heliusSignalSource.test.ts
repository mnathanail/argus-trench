import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParsedTransaction, TokenBalance } from '../solana/heliusRpc.js';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } from '../mirror/heliusTrade.js';
import {
  HeliusCreditBudget,
  isPumpBuyLog,
  processHeliusSignal,
  SignatureDedupe,
  withPoolPrice,
  type HeliusSignalDeps,
} from './heliusSignalSource.js';
import { isGraduatedEvent, priceFromTradeEvent, type PumpPortalTradeEvent } from './pumpportalEvents.js';

const W = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const M = 'MintPumpToken1111111111111111111111111111111';
const S = 1e9;
const FEE = 5_000;
const RENT = 2_039_280;
const close = (a: number, b: number, rel = 1e-6) => Math.abs(a / b - 1) < rel;

function tb(accountIndex: number, owner: string, mint: string, ui: number, decimals = 6): TokenBalance {
  return { accountIndex, owner, mint, uiTokenAmount: { amount: String(BigInt(Math.round(ui * 10 ** decimals))), decimals } };
}

function tx(keys: string[], pre: number[], post: number[], preTok: TokenBalance[], postTok: TokenBalance[]): ParsedTransaction {
  return {
    blockTime: 1_800_000_000,
    meta: { err: null, fee: FEE, preBalances: pre, postBalances: post, preTokenBalances: preTok, postTokenBalances: postTok },
    transaction: { signatures: ['sigCurve'], message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
  };
}

// Συνεπές curve buy: πριν vSol 35 / vTokens 802.183M, αγορά 1 SOL → μετά vSol 36 / vTokens 779.9M.
const K = 36 * 779_900_000;
const PRE_VTOK = K / 35;
const TOKENS_OUT = PRE_VTOK - 779_900_000;
// keys: 0 wallet, 1 wallet ATA, 2 bonding curve, 3 curve token account, 4 program
function curveBuy(): ParsedTransaction {
  return tx(
    [W, 'ATA', 'Curve', 'CurveATA', PUMP_PROGRAM],
    [10 * S, 0, 5 * S, RENT, 1],
    [10 * S - 1 * S - RENT - FEE, RENT, 6 * S, RENT, 1],
    [tb(3, 'Curve', M, PRE_VTOK - 279_900_000)],
    [tb(1, W, M, TOKENS_OUT), tb(3, 'Curve', M, 500_000_000)],
  );
}

// PumpSwap buy: pool 101M tokens / 59.4 wSOL → 100M / 60, αγορά 0.6 SOL για 1M tokens.
// keys: 0 wallet, 1 wallet ATA, 2 pool, 3 pool base, 4 pool quote (wSOL), 5 program
function ammBuy(): ParsedTransaction {
  return tx(
    [W, 'ATA', 'Pool', 'PoolBase', 'PoolQuote', PUMP_AMM_PROGRAM],
    [10 * S, RENT, 1, RENT, 59.4 * S + RENT, 1],
    [10 * S - 0.6 * S - FEE, RENT, 1, RENT, 60 * S + RENT, 1],
    [tb(1, W, M, 5), tb(3, 'Pool', M, 101_000_000), tb(4, 'Pool', WSOL_MINT, 59.4, 9)],
    [tb(1, W, M, 1_000_005), tb(3, 'Pool', M, 100_000_000), tb(4, 'Pool', WSOL_MINT, 60, 9)],
  );
}

const baseEvent = (over: Partial<PumpPortalTradeEvent>): PumpPortalTradeEvent => ({
  signature: 's',
  mint: M,
  traderPublicKey: W,
  txType: 'buy',
  tokenAmount: TOKENS_OUT,
  solAmount: 1,
  pool: 'pump',
  ...over,
});

test('isPumpBuyLog: μόνο αγορές σε Pump.fun / PumpSwap (ή κομμένα logs με το πρόγραμμα)', () => {
  const curveBuyLogs = [`Program ${PUMP_PROGRAM} invoke [2]`, 'Program log: Instruction: Buy', `Program ${PUMP_PROGRAM} success`];
  assert.equal(isPumpBuyLog(curveBuyLogs), true);
  assert.equal(isPumpBuyLog([`Program ${PUMP_AMM_PROGRAM} invoke [3]`, 'Program log: Instruction: BuyExactQuoteIn']), true);
  assert.equal(isPumpBuyLog([`Program ${PUMP_PROGRAM} invoke [2]`, 'Program log: Instruction: Sell']), false, 'πώληση');
  assert.equal(isPumpBuyLog(['Program JUP6Lkb invoke [1]', 'Program log: Instruction: Buy']), false, 'άλλο πρόγραμμα');
  assert.equal(isPumpBuyLog([`Program ${PUMP_PROGRAM} invoke [2]`, 'Log truncated']), true);
  assert.equal(isPumpBuyLog([]), false);
});

test('SignatureDedupe: η ίδια υπογραφή περνάει μία φορά, με όριο μνήμης', () => {
  const d = new SignatureDedupe(2);
  assert.equal(d.claim('a'), true);
  assert.equal(d.claim('a'), false);
  assert.equal(d.has('a'), true);
  d.claim('b');
  d.claim('c');
  assert.equal(d.has('a'), false, 'το παλαιότερο φεύγει');
});

test('HeliusCreditBudget: ημερήσιο και ανά wallet όριο, μηδενίζει στην αλλαγή ημέρας UTC, ειδοποίηση μία φορά', () => {
  let now = new Date('2026-10-07T10:00:00Z');
  const b = new HeliusCreditBudget(3, 2, () => now);
  assert.equal(b.tryConsume('A'), true);
  assert.equal(b.tryConsume('A'), true);
  assert.equal(b.tryConsume('A'), false, 'όριο wallet');
  assert.equal(b.tryConsume('B'), true);
  assert.equal(b.tryConsume('C'), false, 'ημερήσιο όριο');
  assert.equal(b.shouldNotifyExhausted(), true);
  assert.equal(b.shouldNotifyExhausted(), false);
  assert.deepEqual(b.usage(), { day: '2026-10-07', used: 3, limit: 3, walletsAtCap: 1 });
  now = new Date('2026-10-08T00:00:01Z');
  assert.equal(b.tryConsume('A'), true);
  assert.equal(b.usage().used, 1);
});

test('withPoolPrice: curve buy → vSol/vTokens της bonding curve ΜΕΤΑ το trade (όχι graduated)', () => {
  const { event, priceFallback } = withPoolPrice(curveBuy(), baseEvent({}));
  assert.equal(priceFallback, false);
  assert.ok(close(event.vSolInBondingCurve!, 36), String(event.vSolInBondingCurve));
  assert.ok(close(event.vTokensInBondingCurve!, 779_900_000), String(event.vTokensInBondingCurve));
  assert.equal(isGraduatedEvent(event), false, 'περνάει από on-demand gate όπως ένα PumpPortal event');
  assert.ok(close(priceFromTradeEvent(event)!, 36 / 779_900_000));
});

test('withPoolPrice: PumpSwap buy → marketCapSol από wSOL/tokens του pool', () => {
  const ev = baseEvent({ pool: 'pump-amm', tokenAmount: 1_000_000, solAmount: 0.6 });
  const { event, priceFallback } = withPoolPrice(ammBuy(), ev);
  assert.equal(priceFallback, false);
  assert.ok(close(event.marketCapSol!, (60 / 100_000_000) * 1e9));
  assert.equal(isGraduatedEvent(event), true);
  assert.ok(close(priceFromTradeEvent(event)!, 60 / 100_000_000));
});

test('withPoolPrice: παράλογη τιμή pool → μέση τιμή του trade (price_fallback), curve παραμένει curve', () => {
  const { event, priceFallback } = withPoolPrice(curveBuy(), baseEvent({ solAmount: 10 }));
  assert.equal(priceFallback, true);
  assert.equal(isGraduatedEvent(event), false);
  assert.ok(close(priceFromTradeEvent(event)!, 10 / TOKENS_OUT));
});

function deps(fetched: ParsedTransaction | null, dedupe = new SignatureDedupe()): HeliusSignalDeps & { events: PumpPortalTradeEvent[] } {
  const events: PumpPortalTradeEvent[] = [];
  return { fetchTx: async () => fetched, dedupe, onEvent: (e) => events.push(e), nowMs: () => 1_800_000_002_500, events };
}

test('processHeliusSignal: αγορά curve → ένα σήμα με signalSource helius και lag', async () => {
  const d = deps(curveBuy());
  assert.equal(await processHeliusSignal(W, 'sigCurve', d), 'emitted');
  assert.equal(d.events.length, 1);
  assert.equal(d.events[0]!.signalSource, 'helius');
  assert.equal(d.events[0]!.signalLagSec, 2.5);
  assert.equal(d.events[0]!.txType, 'buy');
  assert.equal(isGraduatedEvent(d.events[0]!), false);
  // το claim ανήκει στο entry path — αλλιώς εκείνο θα έβρισκε την υπογραφή «ήδη επεξεργασμένη»
  assert.equal(d.dedupe.has('sigCurve'), false);
  assert.equal(d.dedupe.claim('sigCurve'), true);
});

test('processHeliusSignal: ήδη από PumpPortal → καμία κλήση, κανένα σήμα', async () => {
  const dedupe = new SignatureDedupe();
  dedupe.claim('sigCurve');
  let fetched = 0;
  const d = deps(curveBuy(), dedupe);
  d.fetchTx = async () => {
    fetched += 1;
    return curveBuy();
  };
  assert.equal(await processHeliusSignal(W, 'sigCurve', d), 'duplicate');
  assert.equal(fetched, 0);
  assert.equal(d.events.length, 0);
});

test('processHeliusSignal: πώληση / όχι pump / δεν βρέθηκε → κανένα σήμα', async () => {
  const sell = curveBuy();
  sell.meta!.preTokenBalances = [tb(1, W, M, TOKENS_OUT), tb(3, 'Curve', M, 500_000_000)];
  sell.meta!.postTokenBalances = [tb(3, 'Curve', M, 500_000_000 + TOKENS_OUT)];
  sell.meta!.preBalances = [9 * S, RENT, 6 * S, RENT, 1];
  sell.meta!.postBalances = [9 * S + 0.99 * S + RENT - FEE, 0, 5.01 * S, RENT, 1];
  assert.equal(await processHeliusSignal(W, 'x', deps(sell)), 'not_a_buy');
  const other = curveBuy();
  other.transaction.message.accountKeys[4] = { pubkey: 'SomeOtherDex1111111111111111111111111111111' };
  assert.equal(await processHeliusSignal(W, 'y', deps(other)), 'other_program');
  assert.equal(await processHeliusSignal(W, 'z', deps(null)), 'not_found');
});
