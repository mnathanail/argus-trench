import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adjustedReturn,
  BLOCK_MIN_WEIGHT,
  CLEAN_SINCE,
  computeWalletScores,
  entryMcapAllowsLive,
  MAX_UNPROVEN_ENTRY_MCAP_SOL,
  DEFAULT_SLIPPAGE,
  HALF_LIFE_DAYS,
  slippageFor,
  thompsonLive,
  type ScoringTrade,
} from './walletScore.js';

const NOW = new Date('2026-10-09T08:00:00Z');
const t = (wallet: string, netRet: number, hoursAgo = 1, mode = 'paper', liveSlippage: number | null = null): ScoringTrade => ({
  wallet,
  netRet,
  closedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
  mode,
  liveSlippage,
});
const many = (wallet: string, rets: number[]) => rets.map((r, i) => t(wallet, r, i * 0.1 + 0.1));
const by = (wallet: string, scores: ReturnType<typeof computeWalletScores>) => scores.find((s) => s.wallet === wallet)!;

test('Bayesian: λίγα trades μένουν κοντά στο 0 — ένα τυχερό 5× δεν κάνει ένα wallet «σίγουρο»', () => {
  const scores = computeWalletScores([t('lucky', 4), ...many('steady', Array(30).fill(0.2)), ...many('noise', [-0.3, 0.1, -0.2, 0.05])], NOW);
  const lucky = by('lucky', scores);
  const steady = by('steady', scores);
  assert.equal(lucky.trades, 1);
  assert.ok(lucky.sd > steady.sd * 1.5, 'πολύ πιο αβέβαιο');
  assert.ok(lucky.mean <= 2 / 9 + 1e-9, 'κομμένο στο +200% και «αραιωμένο» από το prior 8 trades');
  assert.equal(lucky.status, 'exploring');
  assert.equal(steady.status, 'proven');
  assert.ok(steady.lcb > 0 && steady.sd < lucky.sd);
});

test('blocked μόνο με αρκετό δείγμα και 90% σίγουρα αρνητικό', () => {
  const bad = many('bad', Array(20).fill(-0.35));
  const fewBad = many('fewbad', Array(4).fill(-0.35));
  const scores = computeWalletScores([...bad, ...fewBad], NOW);
  assert.equal(by('bad', scores).status, 'blocked');
  assert.ok(by('bad', scores).weight >= BLOCK_MIN_WEIGHT);
  assert.notEqual(by('fewbad', scores).status, 'blocked', '4 trades: όχι ακόμα');
});

test('χρονική απόσβεση: trade πριν από HALF_LIFE μετράει το μισό, τα παλιά δεδομένα (πριν το CLEAN_SINCE) καθόλου', () => {
  const later = new Date(NOW.getTime() + 5 * 86_400_000);
  const at = (hoursAgo: number): ScoringTrade => ({ wallet: 'w', netRet: 0.1, closedAt: new Date(later.getTime() - hoursAgo * 3_600_000), mode: 'paper', liveSlippage: null });
  const recent = computeWalletScores([at(0)], later);
  const old = computeWalletScores([at(HALF_LIFE_DAYS * 24)], later);
  assert.ok(Math.abs(by('w', recent).weight - 1) < 1e-6);
  assert.ok(Math.abs(by('w', old).weight - 0.5) < 1e-6);
  const dirty: ScoringTrade = { wallet: 'x', netRet: 5, closedAt: new Date(CLEAN_SINCE.getTime() - 1000), mode: 'paper', liveSlippage: null };
  assert.equal(computeWalletScores([dirty], NOW).length, 0);
});

test('copyability: τα paper αποτελέσματα φορτώνονται με το κόστος εισόδου, τα live μετράνε ως έχουν', () => {
  assert.equal(slippageFor([], []), DEFAULT_SLIPPAGE);
  assert.ok(Math.abs(slippageFor([], [0.1, 0.1, 0.1, 0.1, 0.1]) - 0.1) < 1e-9, 'από όλα τα live trades');
  assert.ok(Math.abs(slippageFor([0.2, 0.2, 0.2], [0.1, 0.1, 0.1, 0.1, 0.1]) - 0.2) < 1e-9, 'από τα δικά του live');
  assert.ok(Math.abs(adjustedReturn(t('w', 0.5), 0.05) - (1.5 / 1.05 - 1)) < 1e-12);
  assert.equal(adjustedReturn(t('w', 0.5, 1, 'live', 0.2), 0.05), 0.5);
  // ένα wallet που μας κόστισε 20% στην είσοδο σε 3 live trades βγαίνει χειρότερο από ένα ίδιο με 5%
  const base = Array(10).fill(0.15);
  const scores = computeWalletScores(
    [...many('cheap', base), ...many('pricey', base), t('pricey', 0.15, 2, 'live', 0.2), t('pricey', 0.15, 2, 'live', 0.2), t('pricey', 0.15, 2, 'live', 0.2)],
    NOW,
  );
  assert.ok(Math.abs(by('pricey', scores).slippage - 0.2) < 1e-9);
  assert.equal(by('cheap', scores).slippage, DEFAULT_SLIPPAGE);
});

test('Thompson: σίγουρα καλό → σχεδόν πάντα live, κακό/λίγα/κανένα → paper, αβέβαιο → μερικές φορές', () => {
  let seed = 1;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const share = (score: Parameters<typeof thompsonLive>[0]) => {
    let n = 0;
    for (let i = 0; i < 2000; i += 1) if (thompsonLive(score, rng).allowed) n += 1;
    return n / 2000;
  };
  assert.ok(share({ mean: 0.15, sd: 0.05, status: 'proven', trades: 30 }) > 0.98);
  assert.ok(share({ mean: -0.2, sd: 0.05, status: 'exploring', trades: 30 }) < 0.02);
  const unsure = share({ mean: 0.02, sd: 0.15, status: 'exploring', trades: 5 });
  assert.ok(unsure > 0.4 && unsure < 0.65, String(unsure));
  assert.equal(thompsonLive(null).reason, 'no_score');
  assert.equal(thompsonLive({ mean: 0.5, sd: 0.01, status: 'exploring', trades: 2 }).reason, 'too_few_trades');
  assert.equal(thompsonLive({ mean: 0.5, sd: 0.01, status: 'blocked', trades: 30 }).allowed, false);
});

test('όριο mcap: τα proven περνούν πάντα, τα υπόλοιπα μόνο κάτω από 40 SOL', () => {
  assert.equal(MAX_UNPROVEN_ENTRY_MCAP_SOL, 40);
  assert.equal(entryMcapAllowsLive('proven', 220), true);
  assert.equal(entryMcapAllowsLive('exploring', 33), true);
  assert.equal(entryMcapAllowsLive('exploring', 40), false);
  assert.equal(entryMcapAllowsLive('exploring', 82), false);
  assert.equal(entryMcapAllowsLive(null, 30), true, 'χωρίς βαθμό: το mcap αρκεί (το Thompson κόβει ξεχωριστά)');
  assert.equal(entryMcapAllowsLive(undefined, Number.NaN), false);
  assert.equal(entryMcapAllowsLive('blocked', 30), true, 'το blocked το κόβει το Thompson, όχι αυτό');
});
