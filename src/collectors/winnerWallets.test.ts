import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WalletStatusRow, WinnerScore } from '../db/repositories/winnerWallets.js';
import { parseTradersResponse, type TokenTrader } from '../gmgn/traders.js';
import { buildWinnerTokensArgs } from '../gmgn/trending.js';
import { decideLifecycleTransition } from './scoring.js';
import { isWinnerWallet, planWatchlist, rankWinners, traderMultiple, winnerRejectReason } from './winnerWallets.js';

const CREATED = 1_800_000_000;
const NOW = CREATED + 6 * 3600;

const trader = (over: Partial<TokenTrader> = {}): TokenTrader => ({
  address: 'W1',
  addrType: 0,
  tags: [],
  makerTokenTags: [],
  realizedProfitUsd: 900,
  realizedPnl: 2,
  buyCostUsd: 300,
  startHoldingAt: CREATED + 5 * 60,
  endHoldingAt: CREATED + 40 * 60,
  profitUsd: 1_500,
  profitChange: 4, // 5×
  totalCostUsd: 300,
  ...over,
});

test('traderMultiple: 1 + profit_change, αλλιώς 1 + realized_pnl', () => {
  assert.equal(traderMultiple(trader()), 5);
  assert.equal(traderMultiple(trader({ profitChange: null })), 3);
  assert.equal(traderMultiple(trader({ profitChange: null, realizedPnl: null })), null);
});

test('winnerRejectReason: νικητής = κανονικό wallet, ≥3×, ≥$300, ≥$50, μπήκε 0.5–60′, κράτησε ≥2′', () => {
  assert.equal(winnerRejectReason(trader(), CREATED, NOW), null);
  assert.equal(winnerRejectReason(trader({ addrType: 2 }), CREATED, NOW), 'not_wallet');
  assert.equal(winnerRejectReason(trader({ makerTokenTags: ['sniper'] }), CREATED, NOW), 'excluded_tag');
  assert.equal(winnerRejectReason(trader({ tags: ['bundler'] }), CREATED, NOW), 'excluded_tag');
  assert.equal(winnerRejectReason(trader({ profitChange: 1.5 }), CREATED, NOW), 'low_multiple');
  assert.equal(winnerRejectReason(trader({ profitUsd: 200 }), CREATED, NOW), 'low_profit');
  assert.equal(winnerRejectReason(trader({ totalCostUsd: 40, profitUsd: 400 }), CREATED, NOW), 'small_size');
  assert.equal(winnerRejectReason(trader({ startHoldingAt: CREATED + 10 }), CREATED, NOW), 'entry_too_early', 'sniper στο άνοιγμα');
  assert.equal(winnerRejectReason(trader({ startHoldingAt: CREATED + 61 * 60, endHoldingAt: null }), CREATED, NOW), 'entry_too_late');
  assert.equal(winnerRejectReason(trader({ endHoldingAt: CREATED + 5 * 60 + 60 }), CREATED, NOW), 'short_hold');
  assert.equal(winnerRejectReason(trader({ endHoldingAt: null }), CREATED, NOW), null, 'κρατάει ακόμα = μετράει ως τώρα');
  assert.equal(winnerRejectReason(trader(), null, NOW), 'missing_data');
});

const score = (address: string, tokens: number, maxMultiple: number, totalProfitUsd = 1000): WinnerScore => ({ address, tokens, maxMultiple, totalProfitUsd });

test('isWinnerWallet / rankWinners: ≥2 τοπ tokens ή ένα ≥10×, κατάταξη tokens → × → κέρδος', () => {
  assert.equal(isWinnerWallet(score('a', 1, 9)), false);
  assert.equal(isWinnerWallet(score('a', 1, 10)), true);
  assert.equal(isWinnerWallet(score('a', 2, 3)), true);
  const ranked = rankWinners([score('one', 1, 12), score('two', 2, 3), score('three', 3, 4), score('weak', 1, 4), score('two-b', 2, 8)]);
  assert.deepEqual(ranked.map((r) => r.address), ['three', 'two-b', 'two', 'one']);
});

const status = (address: string, over: Partial<WalletStatusRow> = {}): WalletStatusRow => ({
  address,
  active: true,
  source: 'smart_money',
  deactivatedReason: null,
  copyMode: 'signal',
  ...over,
});

test('planWatchlist: μένουν νικητές + αποδεδειγμένα + manual + mirror· τα υπόλοιπα ενεργά κόβονται', () => {
  const ranked = rankWinners([score('w1', 3, 5), score('w2', 2, 4), score('bot', 2, 20), score('vetoed', 4, 30)]);
  const statuses = [
    status('w1'),
    status('noise'),
    status('proven'),
    status('man', { source: 'manual' }),
    status('mir', { copyMode: 'mirror' }),
    status('vetoed', { active: false, deactivatedReason: 'manual' }),
    status('old', { active: false, deactivatedReason: 'curated' }),
  ];
  const plan = planWatchlist(ranked, statuses, new Set(['proven']), new Set(['bot']), 150, 2);
  assert.deepEqual(plan.keepWinners, ['w1', 'w2'], 'όχι bot, όχι /unwatch');
  assert.deepEqual(plan.deactivate, ['noise']);
  assert.equal(plan.pruned, true);
});

test('planWatchlist: λίγοι νικητές → κανένα κλάδεμα (το πρώτο τρέξιμο δεν αδειάζει τη watchlist)', () => {
  const plan = planWatchlist(rankWinners([score('w1', 2, 3)]), [status('noise'), status('w1')], new Set(), new Set(), 150, 30);
  assert.equal(plan.pruned, false);
  assert.deepEqual(plan.deactivate, []);
  assert.deepEqual(plan.keepWinners, ['w1']);
});

test('planWatchlist: όριο WATCHLIST_MAX κατά κατάταξη', () => {
  const ranked = rankWinners([score('a', 5, 3), score('b', 4, 3), score('c', 3, 3)]);
  const plan = planWatchlist(ranked, [status('a'), status('b'), status('c')], new Set(), new Set(), 2, 1);
  assert.deepEqual(plan.keepWinners, ['a', 'b']);
  assert.deepEqual(plan.deactivate, ['c']);
});

test('scoring: τα winner_trader wallets δεν απενεργοποιούνται για χαμηλό win rate του GMGN', () => {
  const w = { active: true, winRate: 0.2, tradeCount: 50, deactivatedReason: null, copyMode: 'signal' as const };
  assert.equal(decideLifecycleTransition({ ...w, source: 'winner_trader' }, { winRate: 0.2, tradeCount: 50 }), null);
  assert.equal(decideLifecycleTransition({ ...w, source: 'smart_money' }, { winRate: 0.2, tradeCount: 50 }), 'deactivate');
});

test('buildWinnerTokensArgs: τοπ tokens κατά ATH, χωρίς φίλτρο bundler', () => {
  const a = buildWinnerTokensArgs(48, 300_000);
  assert.deepEqual(a.slice(a.indexOf('--max-created'), a.indexOf('--max-created') + 2), ['--max-created', '48h']);
  assert.deepEqual(a.slice(a.indexOf('--order-by'), a.indexOf('--order-by') + 2), ['--order-by', 'history_highest_market_cap']);
  assert.equal(a.includes('--max-bundler-rate'), false);
});

test('parseTradersResponse: profit / profit_change / total_cost (πεδία του πραγματικού response, winners-report)', () => {
  const [t] = parseTradersResponse({
    list: [{ address: 'W', addr_type: 0, profit: '1500.5', profit_change: '4.2', total_cost: '350', start_holding_at: CREATED }],
  });
  assert.equal(t!.profitUsd, 1500.5);
  assert.equal(t!.profitChange, 4.2);
  assert.equal(t!.totalCostUsd, 350);
});
