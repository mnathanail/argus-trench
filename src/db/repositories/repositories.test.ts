/**
 * Integration tests — τρέχουν πάνω στο dev Postgres (`npm run db:up`).
 *
 * Κάθε test τρέχει μέσα σε transaction που γίνεται ΠΑΝΤΑ rollback, άρα η βάση μένει
 * καθαρή και τα tests δεν εξαρτώνται από τη σειρά εκτέλεσης. Δεν κάνουμε mock το
 * Postgres επίτηδες: ό,τι θέλουμε να επαληθεύσουμε εδώ (CHECK constraints, κυκλική FK,
 * τύποι που επιστρέφει ο driver) ζει στη βάση, και ένα mock θα τα έκρυβε όλα.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type pg from 'pg';
import { closePool, getPool } from '../pool.js';
import { insertDecision, insertDecisions, upsertDecisions, recordTrigger, gatePassRate } from './decisionLog.js';
import { recordEntry } from './entries.js';
import {
  closeTrade,
  countOpenTrades,
  getTrade,
  listOpenTrades,
  openTrade,
} from './paperTrades.js';
import { insertScores, recentScores } from './walletScoreHistory.js';
import {
  getWallet,
  insertWalletIfNew,
  listActiveWallets,
  setWalletActive,
  updateWalletScore,
  upsertWallet,
} from './watchlistWallets.js';

after(async () => {
  await closePool();
});

async function inRollback(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const baseDecision = {
  tokenAddress: 'TokenTest1111',
  logicVersion: 'test-v1',
  candidateSource: 'sample_window' as const,
  gateSnapshot: { rug_ratio: 0.05, smart_degen_count: 3 },
  gatePassed: true,
};

test('insertDecision writes a row and returns a numeric id', async () => {
  await inRollback(async (tx) => {
    const id = await insertDecision({ ...baseDecision, decision: 'skipped_no_trigger' }, tx);
    assert.equal(typeof id, 'number');
    assert.ok(id > 0);
  });
});

test('candidate_source is required and CHECK-constrained', async () => {
  await inRollback(async (tx) => {
    await assert.rejects(
      insertDecision(
        // Παρακάμπτουμε τους τύπους επίτηδες: επαληθεύουμε ότι η ΒΑΣΗ φρουρεί, όχι ο compiler.
        { ...baseDecision, candidateSource: 'bogus' as never, decision: 'skipped_gate' },
        tx,
      ),
      /chk_decision_log_candidate_source/,
    );
  });
});

test('gatePassRate never mixes the two candidate sources', async () => {
  await inRollback(async (tx) => {
    // Διαφορετικά tokens: το unique index (token, logic_version, candidate_source)
    // επιτρέπει ένα row ανά candidate ανά πηγή παρατήρησης.
    await insertDecisions(
      [
        { ...baseDecision, tokenAddress: 'TokenPass1', gatePassed: true, decision: 'skipped_no_trigger' },
        { ...baseDecision, tokenAddress: 'TokenFail1', gatePassed: false, gateFailReason: 'rug_ratio 0.4 > max 0.2', decision: 'skipped_gate' },
        { ...baseDecision, tokenAddress: 'TokenPass1', candidateSource: 'gated_pool', gatePassed: true, decision: 'skipped_no_trigger' },
      ],
      tx,
    );

    const sample = await gatePassRate('test-v1', 'sample_window', tx);
    assert.deepEqual(sample, { evaluated: 2, passed: 1 });

    const gated = await gatePassRate('test-v1', 'gated_pool', tx);
    assert.deepEqual(gated, { evaluated: 1, passed: 1 });
  });
});

test('upsertDecisions clears a stale trigger once the gate re-evaluates as failed', async () => {
  // Reproduces ένα πραγματικό production row (2026-08-26, token
  // ERbqmhiwvNwnx9g7Y9YYb3ivWbjauqsp1n9qaTyGpump, candidate_source sample_window):
  // gate_passed=false / decision='skipped_gate', αλλά trigger_type ακόμα
  // 'smart_money_buy' με wallet από ένα ΠΑΛΙΟΤΕΡΟ, ξεχωριστό evaluation. Το
  // upsertDecisions() δεν έγραφε τα trigger πεδία στο ON CONFLICT, άρα κάθε νέο
  // discovery cycle άφηνε το παλιό trigger να «επιζήσει» ανεξάρτητα από το νέο decision.
  await inRollback(async (tx) => {
    // Cycle 1: το discovery βλέπει το token να περνά το gate.
    await upsertDecisions(
      [{ ...baseDecision, candidateSource: 'gated_pool', gatePassed: true, decision: 'skipped_no_trigger' }],
      tx,
    );

    // trigger_wallet_address έχει FK στο watchlist_wallets — πρέπει να υπάρχει πρώτα.
    await upsertWallet(
      { address: 'WalletTrigger1111111111111111111111111111', source: 'manual', active: true },
      tx,
    );

    // Ένας wallet-activity κύκλος βρίσκει πραγματικό buy και σφραγίζει το trigger.
    const updated = await recordTrigger(
      {
        tokenAddress: baseDecision.tokenAddress,
        logicVersion: baseDecision.logicVersion,
        triggerType: 'smart_money_buy',
        triggerWalletAddress: 'WalletTrigger1111111111111111111111111111',
        triggerWalletSnapshot: { win_rate: 0.6 },
        decision: 'signal_logged',
        decisionReasonText: 'trusted wallet buy — gate είχε περάσει',
      },
      tx,
    );
    assert.equal(updated, 1);

    // Cycle 2: το discovery ξανα-αξιολογεί και το gate ΤΩΡΑ αποτυγχάνει — ακριβώς όπως
    // στο production row. Το `triggerType: 'none'` εδώ είναι ό,τι στέλνει ΠΑΝΤΑ ο
    // discovery collector (δεν ξέρει τίποτα για triggers).
    await upsertDecisions(
      [
        {
          ...baseDecision,
          candidateSource: 'gated_pool',
          gatePassed: false,
          gateFailReason: 'rug_ratio 0.4 > max 0.2',
          triggerType: 'none',
          decision: 'skipped_gate',
        },
      ],
      tx,
    );

    const { rows } = await tx.query(
      `SELECT decision, gate_passed, trigger_type, trigger_wallet_address
         FROM decision_log
        WHERE token_address = $1 AND logic_version = $2 AND candidate_source = 'gated_pool'`,
      [baseDecision.tokenAddress, baseDecision.logicVersion],
    );
    assert.equal(rows[0]?.decision, 'skipped_gate');
    assert.equal(rows[0]?.gate_passed, false);
    assert.equal(rows[0]?.trigger_type, 'none');
    assert.equal(rows[0]?.trigger_wallet_address, null);
  });
});

test('insertDecisions returns one id per input and handles an empty batch', async () => {
  await inRollback(async (tx) => {
    assert.deepEqual(await insertDecisions([], tx), []);
    const ids = await insertDecisions(
      [1, 2, 3].map((n) => ({
        ...baseDecision,
        tokenAddress: `Token${n}`,
        decision: 'skipped_gate' as const,
        gatePassed: false,
      })),
      tx,
    );
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
  });
});

test('NUMERIC columns come back as numbers, not strings', async () => {
  // Regression guard: ο driver επιστρέφει NUMERIC ως string ("0.6200"). Οι συγκρίσεις
  // δουλεύουν λόγω coercion, οπότε το bug είναι σιωπηλό μέχρι να γίνει αριθμητική.
  await inRollback(async (tx) => {
    await upsertWallet(
      { address: 'WalletNum1', source: 'manual', active: true, winRate: 0.62, pnlMultiplier: 3.5, tradeCount: 21 },
      tx,
    );
    const wallet = await getWallet('WalletNum1', tx);
    assert.ok(wallet);
    assert.equal(typeof wallet.winRate, 'number');
    assert.equal(typeof wallet.pnlMultiplier, 'number');
    assert.equal(wallet.winRate, 0.62);
    assert.equal(wallet.pnlMultiplier, 3.5);
    assert.equal(wallet.tradeCount, 21);
    // Το πραγματικό σύμπτωμα που φυλάμε: πρόσθεση, όχι concatenation.
    assert.equal((wallet.winRate ?? 0) + 1, 1.62);
  });
});

test('upsertWallet is idempotent and preserves added_at', async () => {
  await inRollback(async (tx) => {
    const first = await upsertWallet(
      { address: 'WalletUp1', source: 'manual', active: true, winRate: 0.6, tradeCount: 20 },
      tx,
    );
    const second = await upsertWallet(
      { address: 'WalletUp1', source: 'manual', active: true, winRate: 0.7, tradeCount: 30 },
      tx,
    );
    assert.equal(second.id, first.id);
    assert.deepEqual(second.addedAt, first.addedAt);
    assert.equal(second.winRate, 0.7);
    assert.equal(second.tradeCount, 30);
  });
});

test('insertWalletIfNew inserts a fresh smart_money candidate as active', async () => {
  await inRollback(async (tx) => {
    const inserted = await insertWalletIfNew(
      { address: 'WalletDiscover1', source: 'smart_money', active: true, winRate: 0.62, pnlMultiplier: 0.4, tradeCount: 20 },
      tx,
    );
    assert.equal(inserted, true);

    const wallet = await getWallet('WalletDiscover1', tx);
    assert.equal(wallet?.source, 'smart_money');
    assert.equal(wallet?.active, true);
    assert.equal(wallet?.winRate, 0.62);
  });
});

test('insertWalletIfNew never overwrites an existing manual wallet', async () => {
  await inRollback(async (tx) => {
    // Ο χρήστης το πρόσθεσε χειροκίνητα, με δικά του scores.
    await upsertWallet({ address: 'WalletManual1', source: 'manual', active: true, winRate: 0.3, tradeCount: 2 }, tx);

    // Το discovery το ξαναβρίσκει ως smart_degen holder, ΚΑΙ περνάει το threshold —
    // δεν πρέπει να το υποβαθμίσει από 'manual' σε 'smart_money'.
    const inserted = await insertWalletIfNew(
      { address: 'WalletManual1', source: 'smart_money', active: true, winRate: 0.9, pnlMultiplier: 1, tradeCount: 100 },
      tx,
    );
    assert.equal(inserted, false);

    const wallet = await getWallet('WalletManual1', tx);
    assert.equal(wallet?.source, 'manual');
    assert.equal(wallet?.winRate, 0.3);
    assert.equal(wallet?.tradeCount, 2);
  });
});

test('insertWalletIfNew does not re-score an already-known smart_money wallet', async () => {
  await inRollback(async (tx) => {
    await insertWalletIfNew(
      { address: 'WalletKnown1', source: 'smart_money', active: true, winRate: 0.55, tradeCount: 15 },
      tx,
    );
    const insertedAgain = await insertWalletIfNew(
      { address: 'WalletKnown1', source: 'smart_money', active: true, winRate: 0.95, tradeCount: 999 },
      tx,
    );
    assert.equal(insertedAgain, false);

    const wallet = await getWallet('WalletKnown1', tx);
    assert.equal(wallet?.winRate, 0.55);
    assert.equal(wallet?.tradeCount, 15);
  });
});

test('updateWalletScore stamps last_reviewed_at; setWalletActive filters the active list', async () => {
  await inRollback(async (tx) => {
    const created = await upsertWallet({ address: 'WalletAct1', source: 'manual', active: true }, tx);
    assert.equal(created.lastReviewedAt, null);

    const scored = await updateWalletScore('WalletAct1', { winRate: 0.55, pnlMultiplier: 2, tradeCount: 18 }, tx);
    assert.ok(scored?.lastReviewedAt instanceof Date);

    assert.ok((await listActiveWallets(tx)).some((w) => w.address === 'WalletAct1'));
    assert.equal(await setWalletActive('WalletAct1', false, tx), true);
    assert.ok(!(await listActiveWallets(tx)).some((w) => w.address === 'WalletAct1'));
    // Άγνωστο address δεν είναι σφάλμα — απλά δεν άλλαξε γραμμή.
    assert.equal(await setWalletActive('NoSuchWallet', false, tx), false);
  });
});

test('wallet score history keeps a trend, newest first', async () => {
  await inRollback(async (tx) => {
    await upsertWallet({ address: 'WalletHist1', source: 'manual', active: true }, tx);
    await insertScores(
      [
        { walletAddress: 'WalletHist1', winRate: 0.7, pnlMultiplier: 4, tradeCount: 40 },
        { walletAddress: 'WalletHist1', winRate: 0.55, pnlMultiplier: 2.5, tradeCount: 45 },
      ],
      tx,
    );
    const history = await recentScores('WalletHist1', 10, tx);
    assert.equal(history.length, 2);
    assert.equal(typeof history[0]?.winRate, 'number');
  });
});

test('recordEntry links decision and trade atomically in both directions', async () => {
  await inRollback(async (tx) => {
    const { decisionLogId, tradeId } = await recordEntry(
      {
        ...baseDecision,
        candidateSource: 'gated_pool',
        triggerType: 'smart_money_buy',
        decisionReasonText: 'trusted wallet buy + gate passed',
      },
      {
        tokenAddress: baseDecision.tokenAddress,
        mode: 'log_only',
        intendedSizePct: 0.01,
        bankrollAtEntry: 10,
        simulatedEntryPrice: 0.0000123,
        simulatedEntryAmountSol: 0.1,
        assumedSlippagePct: 0.02,
        assumedLatencyMs: 400,
        conditionOrders: { profit_stop: 2, profit_stop_trace: { drawdown_rate: 0.25 } },
      },
      tx,
    );

    const { rows } = await tx.query<{ linked_trade_id: string | null; decision: string }>(
      'SELECT linked_trade_id, decision FROM decision_log WHERE id = $1',
      [decisionLogId],
    );
    assert.equal(rows[0]?.decision, 'entered');
    assert.equal(Number(rows[0]?.linked_trade_id), tradeId);

    const trade = await getTrade(tradeId, tx);
    assert.equal(trade?.decisionLogId, decisionLogId);
    assert.equal(trade?.status, 'open');
  });
});

test('recordEntry refuses to enter a candidate that failed the gate', async () => {
  await inRollback(async (tx) => {
    await assert.rejects(
      recordEntry(
        { ...baseDecision, gatePassed: false, gateFailReason: 'rug_ratio too high' },
        {
          tokenAddress: 'TokenBad1',
          mode: 'log_only',
          intendedSizePct: 0.01,
          bankrollAtEntry: 10,
          simulatedEntryPrice: 1,
          simulatedEntryAmountSol: 0.1,
          assumedSlippagePct: 0.02,
          assumedLatencyMs: 400,
        },
        tx,
      ),
      /gatePassed = false/,
    );
  });
});

test('closeTrade is idempotent — a duplicate exit signal does not rewrite P&L', async () => {
  await inRollback(async (tx) => {
    const openBefore = await countOpenTrades(tx);
    const decisionLogId = await insertDecision({ ...baseDecision, decision: 'entered' }, tx);
    const tradeId = await openTrade(
      {
        decisionLogId,
        tokenAddress: baseDecision.tokenAddress,
        mode: 'paper',
        intendedSizePct: 0.01,
        bankrollAtEntry: 10,
        simulatedEntryPrice: 1,
        simulatedEntryAmountSol: 0.1,
        assumedSlippagePct: 0.02,
        assumedLatencyMs: 400,
      },
      tx,
    );

    // Delta, όχι absolute: το count είναι table-wide, και μόλις η Φάση 1 αρχίσει να
    // γράφει πραγματικά δεδομένα στην ίδια dev βάση, ένα `=== 1` θα έσπαγε.
    assert.equal(await countOpenTrades(tx), openBefore + 1);
    assert.ok((await listOpenTrades(tx)).some((t) => t.id === tradeId));

    const exit = {
      exitReason: 'exit_signal' as const,
      exitTriggerDetail: { wallet: 'WalletX' },
      simulatedExitPrice: 2,
      pnlSol: 0.1,
      pnlPct: 100,
      assumedFeesPct: 0.01,
      pnlNetPct: 99,
    };
    assert.equal(await closeTrade(tradeId, exit, tx), true);
    // Δεύτερο exit-signal για το ίδιο trade: δε γράφει, δε σκάει.
    assert.equal(await closeTrade(tradeId, { ...exit, simulatedExitPrice: 99, pnlNetPct: -50 }, tx), false);

    const trade = await getTrade(tradeId, tx);
    assert.equal(trade?.status, 'closed');
    assert.equal(trade?.simulatedExitPrice, 2);
    assert.equal(trade?.pnlNetPct, 99);
    assert.equal(await countOpenTrades(tx), openBefore);
  });
});
