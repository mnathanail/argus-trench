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
import { recordEntry, recordSignal } from './entries.js';
import {
  closeTrade,
  countOpenTrades,
  getTrade,
  listOpenTrades,
  markExitAttemptStarted,
  markNeedsManualExit,
  openTrade,
} from './paperTrades.js';
import { recordExecutionError } from './tradeExecutionErrors.js';
import { reserveLiveCapital, releaseLiveCapital } from './liveTradingState.js';
import { insertScores, recentScores } from './walletScoreHistory.js';
import {
  getWallet,
  insertWalletIfNew,
  listActiveWallets,
  markActivityChecked,
  selectWalletsForActivityCheck,
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
    // recordTrigger επιστρέφει πλέον το decision_log id (όχι rowCount) — ώστε ο caller
    // να μπορεί να συνδέσει atomically ένα paper_trades row (βλ. entries.ts:
    // recordSignal). Ελέγχουμε ότι ταίριαξε ένα πραγματικό row, όχι τη συγκεκριμένη τιμή
    // του id (auto-increment, όχι ντετερμινιστικό).
    assert.ok(typeof updated === 'number' && updated > 0);

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

test('upsertDecisions never clobbers a row that already has a linked trade — even if the gate still passes', async () => {
  // Πραγματικό production incident 2026-09-11: πολλαπλά ήδη-καταγεγραμμένα trades
  // (wallet, trigger_type, decision) έχαναν σιωπηλά την απόδοση wallet τους ΩΡΕΣ μετά
  // το entry, όταν το discovery ξαναπερνούσε από το ΙΔΙΟ (token, candidate_source) — ΑΚΟΜΑ
  // ΚΙ ΕΝΩ το gate συνέχιζε να περνάει. Το `decision <> 'entered'` guard δεν προστάτευε
  // τα 'signal_logged' rows (Φάση 1) — μόνο το `linked_trade_id IS NULL` τα προστατεύει
  // σωστά, ασχέτως decision value.
  await inRollback(async (tx) => {
    await upsertDecisions(
      [{ ...baseDecision, candidateSource: 'gated_pool', gatePassed: true, decision: 'skipped_no_trigger' }],
      tx,
    );
    await upsertWallet(
      { address: 'WalletTrigger2222222222222222222222222222', source: 'manual', active: true },
      tx,
    );

    // Πραγματική ροή παραγωγής: recordSignal (ΟΧΙ μόνο recordTrigger) — σφραγίζει
    // trigger ΚΑΙ ανοίγει trade ΚΑΙ συνδέει linked_trade_id, ατομικά.
    const recorded = await recordSignal(
      {
        tokenAddress: baseDecision.tokenAddress,
        logicVersion: baseDecision.logicVersion,
        triggerType: 'smart_money_buy',
        triggerWalletAddress: 'WalletTrigger2222222222222222222222222222',
        triggerWalletSnapshot: { win_rate: 0.6 },
        decision: 'signal_logged',
        decisionReasonText: 'trusted wallet buy — gate είχε περάσει',
      },
      {
        tokenAddress: baseDecision.tokenAddress,
        mode: 'log_only',
        intendedSizePct: 0.01,
        bankrollAtEntry: 10,
        simulatedEntryPrice: 0.000123,
        simulatedEntryAmountSol: 0.1,
        assumedSlippagePct: 0.5,
        assumedLatencyMs: 200,
      },
      tx,
    );
    assert.ok(recorded !== null);

    // Cycle 2: το discovery ξαναπερνάει από το ΙΔΙΟ (token, candidate_source) — το gate
    // ΣΥΝΕΧΙΖΕΙ να περνάει (συνηθισμένο σενάριο, όχι το "gate απέτυχε" του άλλου test).
    await upsertDecisions(
      [{ ...baseDecision, candidateSource: 'gated_pool', gatePassed: true, decision: 'skipped_no_trigger' }],
      tx,
    );

    const { rows } = await tx.query(
      `SELECT decision, gate_passed, trigger_type, trigger_wallet_address, linked_trade_id
         FROM decision_log
        WHERE token_address = $1 AND logic_version = $2 AND candidate_source = 'gated_pool'`,
      [baseDecision.tokenAddress, baseDecision.logicVersion],
    );
    // Το πραγματικό trigger ΠΡΕΠΕΙ να επιβιώσει αναλλοίωτο — όχι να ξαναγυρίσει σε
    // 'none'/'skipped_no_trigger' όπως έκανε πριν το fix.
    assert.equal(rows[0]?.decision, 'signal_logged');
    assert.equal(rows[0]?.trigger_type, 'smart_money_buy');
    assert.equal(rows[0]?.trigger_wallet_address, 'WalletTrigger2222222222222222222222222222');
    // linked_trade_id είναι BIGINT — το ωμό tx.query() το γυρνάει πάντα ως string, ενώ το
    // recorded?.tradeId περνάει από το κανονικό, ήδη-parsed application path. Number()
    // εδώ, όχι επειδή άλλαξε κάτι στη λογική — προϋπάρχον, αδρανές type mismatch που
    // ποτέ δεν είχε τρέξει σε πραγματική Postgres σε αυτό το sandbox μέχρι τώρα.
    assert.equal(Number(rows[0]?.linked_trade_id), recorded?.tradeId);
  });
});

test('recordTrigger claims only ONE row when the same token has two unclaimed decision_log rows from different candidate_source — the real 2026-09-15 incident', async () => {
  // Πραγματικό production incident: το discovery δημιουργεί ξεχωριστό decision_log row
  // ανά candidate_source ('sample_window' vs 'gated_pool') — δύο ανεξάρτητες «θέσεις
  // παρκαρίσματος» για το ΙΔΙΟ token επέτρεπαν σε δύο ξεχωριστά σήματα (ή και το ίδιο
  // σήμα, μέσω race) να ανοίξουν ΔΥΟ ξεχωριστά trades στο ΙΔΙΟ token. Επιβεβαιωμένο σε
  // πραγματικά δεδομένα δύο φορές (3VGm...pump, 6H7pHwPBd...pump).
  await inRollback(async (tx) => {
    await upsertWallet({ address: 'WalletFirstSignal1111111111111111111111111', source: 'manual', active: true }, tx);
    await upsertWallet({ address: 'WalletSecondSignal222222222222222222222222', source: 'manual', active: true }, tx);

    // Το discovery δημιουργεί ΔΥΟ ξεχωριστά rows για το ΙΔΙΟ token — ίδιο σενάριο με το
    // πραγματικό production incident.
    await upsertDecisions(
      [
        { ...baseDecision, tokenAddress: 'TokenDoubleParked', candidateSource: 'sample_window', gatePassed: true, decision: 'skipped_no_trigger' },
        { ...baseDecision, tokenAddress: 'TokenDoubleParked', candidateSource: 'gated_pool', gatePassed: true, decision: 'skipped_no_trigger' },
      ],
      tx,
    );

    // Σήμα #1 — πρώτο wallet «κλειδώνει» ΕΝΑ από τα δύο rows. Χρήση recordSignal (όχι
    // μόνο recordTrigger) — η πραγματική ροή παραγωγής: claim ΚΑΙ άνοιγμα trade ΚΑΙ
    // σύνδεση linked_trade_id, ατομικά. Μόνο το recordTrigger μόνο του ΔΕΝ συνδέει ποτέ
    // linked_trade_id — χωρίς αυτό το βήμα, το ίδιο row θα παρέμενε «ακόμα διαθέσιμο».
    const firstSignal = await recordSignal(
      {
        tokenAddress: 'TokenDoubleParked',
        logicVersion: baseDecision.logicVersion,
        triggerType: 'smart_money_buy',
        triggerWalletAddress: 'WalletFirstSignal1111111111111111111111111',
        triggerWalletSnapshot: { win_rate: 0.6 },
        decision: 'signal_logged',
        decisionReasonText: 'πρώτο σήμα',
      },
      {
        tokenAddress: 'TokenDoubleParked',
        mode: 'log_only',
        intendedSizePct: 0.01,
        bankrollAtEntry: 10,
        simulatedEntryPrice: 0.000123,
        simulatedEntryAmountSol: 0.1,
        assumedSlippagePct: 0.5,
        assumedLatencyMs: 200,
      },
      tx,
    );
    assert.ok(firstSignal !== null);

    // Σήμα #2 — δεύτερο, ανεξάρτητο wallet, λίγο αργότερα, ΙΔΙΟ token. Πριν το fix, αυτό
    // έβρισκε το ΔΕΥΤΕΡΟ, ακόμα-άθικτο row και άνοιγε ένα ΔΕΥΤΕΡΟ πραγματικό trade.
    const secondClaim = await recordTrigger(
      {
        tokenAddress: 'TokenDoubleParked',
        logicVersion: baseDecision.logicVersion,
        triggerType: 'smart_money_buy',
        triggerWalletAddress: 'WalletSecondSignal222222222222222222222222',
        triggerWalletSnapshot: { win_rate: 0.7 },
        decision: 'signal_logged',
        decisionReasonText: 'δεύτερο, ανεξάρτητο σήμα — ΔΕΝ πρέπει να βρει τίποτα',
      },
      tx,
    );
    assert.equal(secondClaim, null);

    // Και το «αδερφό» row πρέπει να έχει διαγραφεί, όχι απλά να παραμένει ξεχασμένο.
    const { rows } = await tx.query(
      `SELECT count(*) as n FROM decision_log WHERE token_address = 'TokenDoubleParked'`,
    );
    assert.equal(Number(rows[0]?.n), 1);
  });
});

test('recordTrigger blocks a second open trade for the same token and wallet', async () => {
  await inRollback(async (tx) => {
    await upsertWallet({ address: 'WalletDup1', source: 'manual', active: true }, tx);

    const decisionId = await insertDecision(
      {
        ...baseDecision,
        tokenAddress: 'TokenDupGuard',
        triggerType: 'smart_money_buy',
        triggerWalletAddress: 'WalletDup1',
        decision: 'signal_logged',
      },
      tx,
    );

    await openTrade(
      {
        decisionLogId: decisionId,
        tokenAddress: 'TokenDupGuard',
        mode: 'paper',
        intendedSizePct: 1,
        bankrollAtEntry: 100,
        simulatedEntryPrice: 0.000123,
        simulatedEntryAmountSol: 1,
        assumedSlippagePct: 0.5,
        assumedLatencyMs: 200,
      },
      tx,
    );

    const duplicate = await recordTrigger(
      {
        tokenAddress: 'TokenDupGuard',
        logicVersion: baseDecision.logicVersion,
        triggerType: 'smart_money_buy',
        triggerWalletAddress: 'WalletDup1',
        triggerWalletSnapshot: { win_rate: 0.76 },
        decision: 'signal_logged',
        decisionReasonText: 'should be blocked while open trade exists',
      },
      tx,
    );

    assert.equal(duplicate, null);
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
    assert.equal(await setWalletActive('WalletAct1', false, undefined, tx), true);
    assert.ok(!(await listActiveWallets(tx)).some((w) => w.address === 'WalletAct1'));
    // Άγνωστο address δεν είναι σφάλμα — απλά δεν άλλαξε γραμμή.
    assert.equal(await setWalletActive('NoSuchWallet', false, undefined, tx), false);
  });
});

test('selectWalletsForActivityCheck prioritizes never-checked wallets, then oldest-checked', async () => {
  await inRollback(async (tx) => {
    // Χρονολογική σειρά insertion (added_at) — το ΠΑΛΙΟ round-robin θα τα έδινε με αυτή
    // τη σειρά. Το νέο selection δεν πρέπει να νοιάζεται καθόλου για το added_at.
    await upsertWallet({ address: 'WActOld', source: 'manual', active: true }, tx);
    await upsertWallet({ address: 'WActNew1', source: 'smart_money', active: true }, tx);
    await upsertWallet({ address: 'WActNew2', source: 'smart_money', active: true }, tx);

    // Το 'WActOld' ελέγχθηκε ήδη πρόσφατα — τα δύο άλλα, ΠΟΤΕ. Πρέπει να προτιμηθούν
    // αυτά τα δύο, ΟΧΙ το WActOld, παρά το ότι προστέθηκε πρώτο.
    await markActivityChecked('WActOld', tx);

    const batch = await selectWalletsForActivityCheck(2, tx);
    assert.deepEqual(
      batch.map((w) => w.address).sort(),
      ['WActNew1', 'WActNew2'],
    );

    // Μετά το markActivityChecked, το ίδιο wallet πάει στο τέλος της ουράς — δεν
    // επανεμφανίζεται πριν ελεγχθούν τα υπόλοιπα.
    await markActivityChecked('WActNew1', tx);
    const nextBatch = await selectWalletsForActivityCheck(1, tx);
    assert.deepEqual(nextBatch.map((w) => w.address), ['WActNew2']);
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
        conditionOrders: [
          { order_type: 'profit_stop', price_scale: '50', sell_ratio: '50' },
          { order_type: 'profit_stop_trace', price_scale: '100', sell_ratio: '100', drawdown_rate: '40' },
        ],
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
    assert.ok((await listOpenTrades(undefined, tx)).some((t) => t.id === tradeId));

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

// Πραγματική σύνδεση live trading 2026-09-15 — πραγματικά ποσά SOL, όχι υποθετικά.

test('openTrade + closeTrade persist real actual_entry/exit_amount_sol for live trades — no assumed fees needed', async () => {
  await inRollback(async (tx) => {
    const decisionLogId = await insertDecision({ ...baseDecision, decision: 'entered' }, tx);
    const tradeId = await openTrade(
      {
        decisionLogId,
        tokenAddress: baseDecision.tokenAddress,
        mode: 'live',
        intendedSizePct: 0.05,
        bankrollAtEntry: 1,
        simulatedEntryPrice: 0.000123,
        simulatedEntryAmountSol: 0.05,
        actualEntryAmountSol: 0.052341, // πραγματικό, λίγο πάνω από το ονομαστικό (fees/slippage)
        assumedSlippagePct: 0.5,
        assumedLatencyMs: 200,
      },
      tx,
    );

    const opened = await getTrade(tradeId, tx);
    assert.equal(opened?.mode, 'live');
    assert.equal(opened?.actualEntryAmountSol, 0.052341);
    assert.equal(opened?.actualExitAmountSol, null); // ακόμα ανοιχτό

    await closeTrade(
      tradeId,
      {
        exitReason: 'exit_signal',
        simulatedExitPrice: 0.000456,
        pnlSol: 0.010204, // πραγματική διαφορά balance, όχι ποσοστιαίος υπολογισμός
        pnlPct: 0.195,
        assumedFeesPct: 0, // ήδη πραγματικά ποσά — καμία παραδοχή
        pnlNetPct: 0.195,
        actualExitAmountSol: 0.062545,
      },
      tx,
    );

    const closed = await getTrade(tradeId, tx);
    assert.equal(closed?.actualExitAmountSol, 0.062545);
  });
});

test('closeTrade resets needsManualExit and exitAttemptStartedAt on a successful close — a manual retry fully clears the flag', async () => {
  await inRollback(async (tx) => {
    const decisionLogId = await insertDecision({ ...baseDecision, decision: 'entered' }, tx);
    const tradeId = await openTrade(
      {
        decisionLogId,
        tokenAddress: baseDecision.tokenAddress,
        mode: 'live',
        intendedSizePct: 0.05,
        bankrollAtEntry: 1,
        simulatedEntryPrice: 0.000123,
        simulatedEntryAmountSol: 0.05,
        actualEntryAmountSol: 0.05,
        assumedSlippagePct: 0.5,
        assumedLatencyMs: 200,
      },
      tx,
    );

    await markExitAttemptStarted(tradeId, tx);
    await markNeedsManualExit(tradeId, tx);
    const failed = await getTrade(tradeId, tx);
    assert.equal(failed?.needsManualExit, true);
    assert.equal(failed?.exitAttemptStartedAt, null); // markNeedsManualExit το καθαρίζει ήδη

    // Χειροκίνητη προσπάθεια πετυχαίνει αργότερα — το κανονικό closeTrade πρέπει να
    // καθαρίσει πλήρως το needs_manual_exit, όχι μόνο να κλείσει το trade.
    await closeTrade(
      tradeId,
      {
        exitReason: 'exit_signal',
        simulatedExitPrice: 0.000456,
        pnlSol: 0.01,
        pnlPct: 0.2,
        assumedFeesPct: 0,
        pnlNetPct: 0.2,
        actualExitAmountSol: 0.06,
      },
      tx,
    );

    const closed = await getTrade(tradeId, tx);
    assert.equal(closed?.needsManualExit, false);
    assert.equal(closed?.exitAttemptStartedAt, null);
    assert.equal(closed?.status, 'closed');
  });
});

test('recordExecutionError writes a full, queryable record — timestamp, message, amount, everything (explicit user request)', async () => {
  await inRollback(async (tx) => {
    await recordExecutionError(
      {
        paperTradeId: null, // αποτυχία στο entry, πριν καν υπάρξει trade row
        tokenAddress: baseDecision.tokenAddress,
        action: 'buy',
        amountSol: 0.05,
        errorMessage: 'swap status=failed',
        errorDetail: { status: 'failed', signature: 'abc123' },
      },
      tx,
    );

    const { rows } = await tx.query(
      `SELECT token_address, action, amount_sol, error_message, error_detail_json, attempted_at
         FROM trade_execution_errors WHERE token_address = $1`,
      [baseDecision.tokenAddress],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.action, 'buy');
    assert.equal(Number(rows[0]?.amount_sol), 0.05);
    assert.equal(rows[0]?.error_message, 'swap status=failed');
    assert.deepEqual(rows[0]?.error_detail_json, { status: 'failed', signature: 'abc123' });
    assert.ok(rows[0]?.attempted_at instanceof Date);
  });
});

// reserveLiveCapital/releaseLiveCapital — πραγματικό ρίσκο εντοπίστηκε 2026-09-15, πριν
// προλάβει να συμβεί στην πράξη: δύο σχεδόν-ταυτόχρονα σήματα σε ΔΙΑΦΟΡΕΤΙΚΑ tokens θα
// μπορούσαν να δουν το ΙΔΙΟ, ακόμα-αναλλοίωτο on-chain balance και να δεσμεύσουν μαζί
// παραπάνω κεφάλαιο απ' όσο πραγματικά υπάρχει.

async function resetReservedSol(tx: pg.PoolClient): Promise<void> {
  await tx.query(`UPDATE live_trading_state SET reserved_sol = 0 WHERE id = 1`);
}

test('reserveLiveCapital succeeds when enough real balance remains after existing reservations', async () => {
  await inRollback(async (tx) => {
    await resetReservedSol(tx);
    assert.equal(await reserveLiveCapital(1.0, 0.05, tx), true);
    const { rows } = await tx.query(`SELECT reserved_sol FROM live_trading_state WHERE id = 1`);
    assert.equal(Number(rows[0]?.reserved_sol), 0.05);
  });
});

test('reserveLiveCapital fails (no reservation made) when a prior reservation already used up the real balance — the actual race condition scenario', async () => {
  await inRollback(async (tx) => {
    await resetReservedSol(tx);
    // Σήμα #1 σε token A — δεσμεύει το μεγαλύτερο μέρος του διαθέσιμου κεφαλαίου, μόνο
    // 0.02 SOL μένει (0.36 - 0.34).
    assert.equal(await reserveLiveCapital(0.36, 0.34, tx), true);
    // Σήμα #2 σε token B, μέσα σε δευτερόλεπτα — βλέπει το ΙΔΙΟ, μπαγιάτικο 0.36 balance
    // (το πρώτο swap δεν έχει προλάβει να settle ακόμα on-chain), αλλά η κράτηση
    // αρνείται σωστά αφού μόνο 0.02 πραγματικά περισσεύει, όχι τα 0.05 που ζητάει.
    assert.equal(await reserveLiveCapital(0.36, 0.05, tx), false);
    const { rows } = await tx.query(`SELECT reserved_sol FROM live_trading_state WHERE id = 1`);
    assert.equal(Number(rows[0]?.reserved_sol), 0.34); // αμετάβλητο — η αποτυχημένη κράτηση δεν έγραψε τίποτα
  });
});

test('releaseLiveCapital frees up capital for a subsequent reservation — the normal buy-then-release cycle', async () => {
  await inRollback(async (tx) => {
    await resetReservedSol(tx);
    assert.equal(await reserveLiveCapital(0.36, 0.34, tx), true);
    assert.equal(await reserveLiveCapital(0.36, 0.05, tx), false); // δεν περισσεύει ακόμα (μόνο 0.02)

    await releaseLiveCapital(0.34, tx); // το πρώτο swap ολοκληρώθηκε (πέτυχε ή απέτυχε — δεν έχει σημασία εδώ)

    assert.equal(await reserveLiveCapital(0.36, 0.05, tx), true); // τώρα περισσεύει ολόκληρο το 0.36
  });
});

test('releaseLiveCapital never goes negative, even on a mismatched/duplicate release', async () => {
  await inRollback(async (tx) => {
    await resetReservedSol(tx);
    await reserveLiveCapital(1.0, 0.05, tx);
    await releaseLiveCapital(0.05, tx);
    await releaseLiveCapital(0.05, tx); // δεύτερο, «περιττό» release — δεν πρέπει να πάει αρνητικό
    const { rows } = await tx.query(`SELECT reserved_sol FROM live_trading_state WHERE id = 1`);
    assert.equal(Number(rows[0]?.reserved_sol), 0);
  });
});
