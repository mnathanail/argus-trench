import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ParsedTransaction, TokenBalance } from '../solana/heliusRpc.js';
import { parseWalletTrade, PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } from './heliusTrade.js';

const W = '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5';
const M = 'MintPumpToken1111111111111111111111111111111';
const S = 1e9;
const RENT = 2_039_280;
const FEE = 5_000;

function tb(accountIndex: number, owner: string, mint: string, amount: bigint | number, decimals = 6): TokenBalance {
  return { accountIndex, owner, mint, uiTokenAmount: { amount: String(amount), decimals } };
}

function tx(
  keys: string[],
  pre: number[],
  post: number[],
  preTok: TokenBalance[],
  postTok: TokenBalance[],
  extra: Partial<NonNullable<ParsedTransaction['meta']>> = {},
): ParsedTransaction {
  return {
    blockTime: 1_800_000_000,
    meta: { err: null, fee: FEE, preBalances: pre, postBalances: post, preTokenBalances: preTok, postTokenBalances: postTok, ...extra },
    transaction: { signatures: ['sig1'], message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
  };
}

// keys: 0 wallet, 1 wallet ATA, 2 bonding curve, 3 fee recipient, 4 bot fee, 5 program
const PUMP_KEYS = [W, 'ATA', 'Curve', 'FeeRecipient', 'BotFee', PUMP_PROGRAM];

test('pump buy (νέο token account): ποσό pool, χωρίς fee/rent, υπόλοιπο μετά', () => {
  const r = parseWalletTrade(
    tx(
      PUMP_KEYS,
      [10 * S, 0, 5 * S, 0, 0, 1],
      [10 * S - 1 * S - 0.01 * S - 0.01 * S - RENT - FEE, RENT, 6 * S, 0.01 * S, 0.01 * S, 1],
      [],
      [tb(1, W, M, 1_000_000_000_000n)],
    ),
    W,
  );
  assert.ok(r.ok);
  assert.equal(r.event.txType, 'buy');
  assert.equal(r.event.mint, M);
  assert.equal(r.event.tokenAmount, 1_000_000);
  assert.equal(r.event.newTokenBalance, 1_000_000);
  assert.equal(r.event.pool, 'pump');
  assert.equal(r.program, 'pump');
  assert.ok(Math.abs(r.walletSol - 1.02) < 1e-9, `walletSol=${r.walletSol}`);
  assert.equal(r.poolSol, 1);
  assert.equal(r.solSource, 'pool');
  assert.equal(r.event.solAmount, 1);
  assert.equal(r.blockTime, 1_800_000_000);
});

test('pump πλήρης πώληση (κλείνει token account): newTokenBalance 0, ποσό pool', () => {
  const r = parseWalletTrade(
    tx(
      PUMP_KEYS,
      [5 * S, RENT, 6 * S, 0, 0, 1],
      [5 * S + 0.98 * S + RENT - FEE, 0, 5 * S, 0.01 * S, 0.01 * S, 1],
      [tb(1, W, M, 1_000_000_000_000n)],
      [],
    ),
    W,
  );
  assert.ok(r.ok);
  assert.equal(r.event.txType, 'sell');
  assert.equal(r.event.newTokenBalance, 0);
  assert.equal(r.event.tokenAmount, 1_000_000);
  assert.ok(Math.abs(r.walletSol - 0.98) < 1e-9);
  assert.equal(r.poolSol, 1);
  assert.equal(r.event.solAmount, 1);
});

test('μερική πώληση: newTokenBalance = υπόλοιπο', () => {
  const r = parseWalletTrade(
    tx(PUMP_KEYS, [5 * S, RENT, 6 * S, 0, 0, 1], [5 * S + 0.3 * S - FEE, RENT, 5.7 * S, 0, 0, 1], [tb(1, W, M, 1_000_000_000_000n)], [tb(1, W, M, 700_000_000_000n)]),
    W,
  );
  assert.ok(r.ok);
  assert.equal(r.event.tokenAmount, 300_000);
  assert.equal(r.event.newTokenBalance, 700_000);
});

test('PumpSwap αγορά μέσω wSOL vault του pool → pump-amm', () => {
  // 0 wallet, 1 wallet ATA, 2 pool quote vault (wSOL, owner pool), 3 program
  const r = parseWalletTrade(
    tx(
      [W, 'ATA', 'PoolVault', PUMP_AMM_PROGRAM],
      [3 * S, RENT, 100 * S, 1],
      [3 * S - 0.5 * S - FEE, RENT, 100 * S + 0.495 * S, 1],
      [tb(1, W, M, 0), tb(2, 'Pool', WSOL_MINT, 100 * S, 9)],
      [tb(1, W, M, 5_000_000_000n), tb(2, 'Pool', WSOL_MINT, 100.495 * S, 9)],
    ),
    W,
  );
  assert.ok(r.ok);
  assert.equal(r.event.pool, 'pump-amm');
  assert.equal(r.event.tokenAmount, 5_000);
  assert.ok(Math.abs(r.event.solAmount - 0.495) < 1e-9);
});

test('wallet όχι fee payer: δεν προστίθεται fee· πληρωμή με wSOL του wallet', () => {
  // 0 bot fee payer, 1 wallet, 2 wallet ATA, 3 wallet wSOL account, 4 curve, 5 program
  const r = parseWalletTrade(
    tx(
      ['Payer', W, 'ATA', 'WsolAcc', 'Curve', PUMP_PROGRAM],
      [1 * S, 2 * S, RENT, RENT + 1 * S, 5 * S, 1],
      [1 * S - FEE, 2 * S, RENT, RENT + 0.6 * S, 5.4 * S, 1],
      [tb(2, W, M, 0), tb(3, W, WSOL_MINT, 1 * S, 9)],
      [tb(2, W, M, 2_000_000_000n), tb(3, W, WSOL_MINT, 0.6 * S, 9)],
    ),
    W,
  );
  assert.ok(r.ok);
  assert.ok(Math.abs(r.walletSol - 0.4) < 1e-9, `walletSol=${r.walletSol}`);
  assert.ok(Math.abs(r.event.solAmount - 0.4) < 1e-9);
});

test('pool όχι εύλογο (π.χ. άλλη μεγάλη κίνηση) → walletSol', () => {
  const r = parseWalletTrade(
    tx(PUMP_KEYS, [10 * S, 0, 5 * S, 0, 0, 1], [10 * S - 1 * S - RENT - FEE, RENT, 5 * S + 0.1 * S, 0, 0.9 * S, 1], [], [tb(1, W, M, 1_000_000n)]),
    W,
  );
  assert.ok(r.ok);
  // μεγαλύτερος αποδέκτης 0.9 → εύλογο (≥ 0.5×1.0)· αν ήταν 0.1 μόνο θα έπεφτε στο wallet
  assert.equal(r.solSource, 'pool');
  const r2 = parseWalletTrade(
    tx(PUMP_KEYS, [10 * S, 0, 5 * S, 0, 0, 1], [10 * S - 1 * S - RENT - FEE, RENT, 5 * S + 0.1 * S, 0, 0.2 * S, 1], [], [tb(1, W, M, 1_000_000n)]),
    W,
  );
  assert.ok(r2.ok);
  assert.equal(r2.solSource, 'wallet');
  assert.equal(r2.event.solAmount, 1);
});

test('άλλο πρόγραμμα → pool other', () => {
  const r = parseWalletTrade(
    tx([W, 'ATA', 'Pool', 'RaydiumProgram'], [10 * S, 0, 5 * S, 1], [9 * S - RENT - FEE, RENT, 6 * S, 1], [], [tb(1, W, M, 1_000_000n)]),
    W,
  );
  assert.ok(r.ok);
  assert.equal(r.event.pool, 'other');
});

test('skip: αποτυχημένη, χωρίς wallet, χωρίς token αλλαγή, δύο tokens', () => {
  const base = tx(PUMP_KEYS, [10 * S, 0, 0, 0, 0, 1], [10 * S - FEE, 0, 0, 0, 0, 1], [], []);
  assert.deepEqual(parseWalletTrade({ ...base, meta: { ...base.meta!, err: { InstructionError: [0, 'x'] } } }, W), { ok: false, reason: 'failed' });
  assert.deepEqual(parseWalletTrade(base, 'Someone'), { ok: false, reason: 'wallet_not_in_tx' });
  assert.deepEqual(parseWalletTrade(base, W), { ok: false, reason: 'no_token_change' });
  const two = tx([W, 'A1', 'A2', PUMP_PROGRAM], [10 * S, RENT, RENT, 1], [10 * S - FEE, RENT, RENT, 1], [tb(1, W, M, 5), tb(2, W, 'OtherMint', 0)], [tb(1, W, M, 0), tb(2, W, 'OtherMint', 9)]);
  assert.deepEqual(parseWalletTrade(two, W), { ok: false, reason: 'multi_token' });
  assert.deepEqual(parseWalletTrade({ ...base, meta: null }, W), { ok: false, reason: 'no_meta' });
});

// ── 2026-09-30: πραγματικό μοτίβο chriskogias — πληρώνει σε USDC, το bot κάνει USDC→SOL→token.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// keys: 0 wallet, 1 wallet USDC acc, 2 wallet token ATA, 3 SOL/USDC pool SOL vault, 4 bonding curve, 5 program
const USDC_KEYS = [W, 'UsdcAcc', 'ATA', 'SolUsdcVault', 'Curve', PUMP_PROGRAM];

test('USDC → SOL pool αγορά (GZt6ei9W): SOL από το pool, paidStable', () => {
  const r = parseWalletTrade(
    tx(
      USDC_KEYS,
      [1 * S, RENT, RENT, 5_000 * S, 50 * S, 1],
      [1 * S - FEE, RENT, RENT, 5_000 * S - 3.3 * S, 50 * S + 3.289 * S, 1],
      [tb(1, W, USDC, 92_378_000_000n, 6), tb(2, W, M, 0)],
      [tb(1, W, USDC, 91_977_800_000n, 6), tb(2, W, M, 28_047_200_000_000n)],
    ),
    W,
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.event.txType, 'buy');
  assert.equal(r.event.mint, M);
  assert.ok(Math.abs(r.event.solAmount - 3.289) < 1e-9);
  assert.equal(r.solSource, 'pool_stable');
  assert.equal(r.paidStable, true);
  assert.equal(r.event.newTokenBalance, 28_047_200);
});

test('USDC πώληση μέσω SOL pool: SOL = αυτά που έδωσε το pool', () => {
  const r = parseWalletTrade(
    tx(
      USDC_KEYS,
      [1 * S, RENT, RENT, 5_000 * S, 50 * S, 1],
      [1 * S - FEE + RENT, RENT, 0, 5_000 * S + 1.7 * S, 50 * S - 1.7166 * S, 1],
      [tb(1, W, USDC, 91_906_200_000n, 6), tb(2, W, M, 37_187_900_000_000n)],
      [tb(1, W, USDC, 92_108_200_000n, 6)],
    ),
    W,
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.event.txType, 'sell');
  assert.equal(r.event.newTokenBalance, 0);
  assert.ok(Math.abs(r.event.solAmount - 1.7166) < 1e-9);
});

test('pool σε USDC (CiyydVkn): καμία κίνηση SOL πέρα από rent → stable_pool, δεν αντιγράφεται', () => {
  const r = parseWalletTrade(
    tx(
      [W, 'UsdcAcc', 'ATA', 'NewPda', PUMP_PROGRAM],
      [1 * S, RENT, 0, 0, 1],
      [1 * S - FEE - RENT - 1_500_000, RENT, RENT, 1_500_000, 1],
      [tb(1, W, USDC, 92_108_200_000n, 6)],
      [tb(1, W, USDC, 91_908_000_000n, 6), tb(2, W, M, 38_138_400_000_000n)],
    ),
    W,
  );
  assert.deepEqual(r, { ok: false, reason: 'stable_pool' });
});
