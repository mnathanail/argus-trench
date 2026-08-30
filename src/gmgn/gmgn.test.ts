/**
 * Τα fixtures στο `__fixtures__/` είναι **πραγματικά** responses, καταγεγραμμένα από live
 * calls — όχι χειρόγραφα. Έτσι τα tests φυλάνε το αληθινό σχήμα, συμπεριλαμβανομένων των
 * σημείων όπου το documentation διαφωνεί (`event_type` και όχι `type`, `tx_hash` και όχι
 * `transaction_hash`, ποσά ως strings στο activity αλλά numbers στο trenches).
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildActivityArgs, parseActivityResponse } from './activity.js';
import { GmgnCliError, GmgnRateLimitError, GmgnResponseError, rethrowIfRateLimited } from './errors.js';
import { LOCAL_CLI_BIN, runCli } from './exec.js';
import { buildHoldersArgs, parseHoldersResponse } from './holders.js';
import { buildKlineArgs, parseKlineResponse } from './kline.js';
import { TokenBucket, type Clock } from './rateLimiter.js';
import { buildTrenchesArgs, parseTrenchesResponse } from './trenches.js';
import { toNumber } from './validate.js';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as unknown;
}

/** Ο fake clock προχωράει ΜΟΝΟ μέσω sleep, ώστε τα tests να μην περιμένουν πραγματικά. */
function fakeClock(): { clock: Clock; elapsed: () => number } {
  let now = 0;
  return {
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    elapsed: () => now,
  };
}

test('TokenBucket starts full and deducts the route weight', async () => {
  const { clock } = fakeClock();
  const bucket = new TokenBucket(20, 20, clock);
  assert.equal(bucket.available, 20);

  // Ένας κύκλος discovery: gated + ungated trenches, weight 3 το καθένα.
  await bucket.acquire(3);
  await bucket.acquire(3);
  assert.equal(bucket.available, 14);
});

test('TokenBucket waits for refill instead of over-spending', async () => {
  const { clock, elapsed } = fakeClock();
  const bucket = new TokenBucket(20, 20, clock);

  for (let i = 0; i < 6; i += 1) await bucket.acquire(3); // 18 από 20
  assert.equal(elapsed(), 0, 'δε πρέπει να έχει περιμένει ακόμα');

  await bucket.acquire(6); // λείπουν 4 tokens → 200ms στα 20/s
  assert.equal(elapsed(), 200);
  assert.ok(bucket.available < 1);
});

test('TokenBucket refuses a weight it can never satisfy', async () => {
  const bucket = new TokenBucket(20, 20, fakeClock().clock);
  await assert.rejects(bucket.acquire(21), /exceeds bucket capacity/);
});

test('TokenBucket serialises concurrent acquires', async () => {
  const { clock } = fakeClock();
  const bucket = new TokenBucket(20, 20, clock);
  // 10 ταυτόχρονα × 3 = 30 > capacity: αν δεν σειριοποιούσε, θα πήγαινε αρνητικό.
  await Promise.all(Array.from({ length: 10 }, () => bucket.acquire(3)));
  assert.ok(bucket.available >= 0);
});

test('TokenBucket serves higher-priority requests first', async () => {
  const { clock } = fakeClock();
  const bucket = new TokenBucket(3, 20, clock);
  await bucket.acquire(3);

  const order: string[] = [];
  const low = bucket.acquire(3, 0).then(() => order.push('low'));
  const high = bucket.acquire(3, 10).then(() => order.push('high'));
  await Promise.all([low, high]);

  assert.deepEqual(order, ['high', 'low']);
});

test('TokenBucket pauses queued acquires after a shared rate limit', async () => {
  const { clock, elapsed } = fakeClock();
  const bucket = new TokenBucket(20, 20, clock);
  bucket.block(new Date(5_000));

  await bucket.acquire(3);

  assert.ok(elapsed() >= 8_000 && elapsed() <= 8_001);
});

test('parseTrenchesResponse reads the real near_completion shape', () => {
  const candidates = parseTrenchesResponse(fixture('trenches.near_completion.json'), 'near_completion');
  assert.equal(candidates.length, 2);

  const first = candidates[0];
  assert.ok(first);
  assert.equal(typeof first.tokenAddress, 'string');
  assert.equal(first.launchpadPlatform, 'Pump.fun');
  assert.equal(typeof first.gate.rugRatio, 'number');
  assert.equal(typeof first.gate.smartDegenCount, 'number');
  // Το raw πάει αυτούσιο στο decision_log.gate_snapshot_json — χωρίς απώλειες.
  assert.ok(Object.keys(first.raw).length > 50);
  assert.equal(first.raw['address'], first.tokenAddress);
});

test('parseTrenchesResponse also accepts the documented data.pump shape', () => {
  // Το CLI σήμερα δίνει top-level `near_completion`, τα docs υπόσχονται `data.pump`.
  // Αν αλλάξει η κανονικοποίηση, θέλουμε να συνεχίσει να δουλεύει, όχι να γυρίσει 0.
  const real = fixture('trenches.near_completion.json') as { near_completion: unknown[] };
  const wrapped = { data: { pump: real.near_completion } };
  assert.equal(parseTrenchesResponse(wrapped, 'near_completion').length, 2);
});

test('parseTrenchesResponse fails loudly, naming the keys it did find', () => {
  assert.throws(
    () => parseTrenchesResponse({ something_else: [] }, 'near_completion'),
    (error: unknown) =>
      error instanceof GmgnResponseError && /something_else/.test(error.message),
  );
});

test('parseActivityResponse reads event_type/tx_hash and coerces string amounts', () => {
  const page = parseActivityResponse(fixture('activity.buys.json'));
  assert.equal(page.activities.length, 3);

  const buy = page.activities[0];
  assert.ok(buy);
  assert.equal(buy.eventType, 'buy');
  assert.equal(typeof buy.txHash, 'string');
  assert.equal(typeof buy.tokenAddress, 'string');
  // Στο raw JSON αυτά είναι strings· ο adapter τα δίνει ως numbers.
  assert.equal(typeof buy.tokenAmount, 'number');
  assert.equal(typeof buy.costUsd, 'number');
  assert.equal(typeof buy.timestamp, 'number');
  assert.equal(typeof page.nextCursor, 'string');
});

test('parseHoldersResponse reads the wallet from `address`, not `account_address`', () => {
  // Το πραγματικό response έχει ΚΑΙ τα δύο πεδία: `address` είναι ο owner/wallet,
  // `account_address` είναι το on-chain token account (ATA). Αν μπερδευτούν, το
  // discovery θα σκόραρε/πρότεινε λάθος address για watchlist.
  const holders = parseHoldersResponse(fixture('token.holders.smart_degen.json'));
  assert.equal(holders.length, 5);

  const first = holders[0];
  assert.ok(first);
  assert.equal(first.address, '9wFxpNE8awZnaYqCUPje3gSMBzijeasATnRCmaMgEvQF');
  assert.notEqual(first.address, '6uFko3dFCPXpvLuVh32zEMsp62SXpMYtyNF9krQnKfYp'); // account_address
  assert.ok(first.tags.includes('smart_degen'));
});

test('buildHoldersArgs uses a single --tag value, not repeatable', () => {
  assert.deepEqual(
    buildHoldersArgs({ tokenAddress: 'TOKEN1', tag: 'smart_degen', limit: 20 }),
    ['token', 'holders', '--chain', 'sol', '--address', 'TOKEN1', '--tag', 'smart_degen', '--limit', '20'],
  );
});

test('rethrowIfRateLimited stops a per-item loop instead of hammering through a ban', () => {
  // Αυτό είναι το guard που εμποδίζει το ακριβές λάθος που κάνει ένα naive per-item
  // catch: ξαναχτυπάει το API στο επόμενο item ενώ το ban είναι ακόμα ενεργό.
  assert.throws(
    () => rethrowIfRateLimited(new GmgnRateLimitError('banned', null, '')),
    GmgnRateLimitError,
  );
  // Οτιδήποτε άλλο σφάλμα περνά αθόρυβα — το per-item catch συνεχίζει κανονικά.
  assert.doesNotThrow(() => rethrowIfRateLimited(new Error('some other failure')));
  assert.doesNotThrow(() => rethrowIfRateLimited(new GmgnCliError('x', 1, '', [])));
});

test('toNumber accepts both driver conventions and rejects junk', () => {
  assert.equal(toNumber(0.106, 'x'), 0.106);
  assert.equal(toNumber('306571428.571428', 'x'), 306571428.571428);
  assert.throws(() => toNumber('not-a-number', 'x'), GmgnResponseError);
  assert.throws(() => toNumber(null, 'x'), GmgnResponseError);
});

test('buildTrenchesArgs maps thresholds to flags and omits the broken --limit', () => {
  const args = buildTrenchesArgs({
    category: 'near_completion',
    launchpadPlatforms: ['Pump.fun'],
    thresholds: { maxRugRatio: 0.2, minSmartDegenCount: 1 },
  });
  assert.deepEqual(args, [
    'market', 'trenches', '--chain', 'sol', '--type', 'near_completion',
    '--launchpad-platform', 'Pump.fun',
    '--max-rug-ratio', '0.2',
    '--min-smart-degen-count', '1',
  ]);
  assert.ok(!args.includes('--limit'), '--limit αγνοείται από το CLI, δε το στέλνουμε');
});

test('buildActivityArgs repeats --type and passes the cursor through', () => {
  assert.deepEqual(
    buildActivityArgs({ wallet: 'W1', types: ['buy', 'sell'], limit: 20, cursor: 'CUR' }),
    ['portfolio', 'activity', '--chain', 'sol', '--wallet', 'W1',
      '--type', 'buy', '--type', 'sell', '--limit', '20', '--cursor', 'CUR'],
  );
});

test('buildKlineArgs uses the CLI address flag', () => {
  assert.deepEqual(
    buildKlineArgs({ tokenAddress: 'TOKEN1', from: 123 }),
    [
      'market',
      'kline',
      '--chain',
      'sol',
      '--address',
      'TOKEN1',
      '--resolution',
      '1m',
      '--from',
      '123',
    ],
  );
});

test('parseKlineResponse accepts the real GMGN list wrapper and string numerics', () => {
  const candles = parseKlineResponse({
    list: [{ time: 1_700_000_000_000, open: '1.0', close: '1.1', high: '1.2', low: '0.9', volume: '10' }],
  });

  assert.equal(candles.length, 1);
  assert.equal(candles[0]?.timestamp, 1_700_000_000_000);
  assert.equal(candles[0]?.open, 1);
  assert.equal(candles[0]?.close, 1.1);
  assert.equal(candles[0]?.high, 1.2);
  assert.equal(candles[0]?.low, 0.9);
});

test('gmgn-cli is a packaged project dependency, not a global install', () => {
  // Το Railway build δεν έχει global npm installs — αν κάποιος αφαιρέσει το `gmgn-cli`
  // από τα package.json dependencies, αυτό το test σκάει τοπικά/στο CI, όχι σιωπηλά σε
  // ένα production deploy όπου κάθε collector call θα αποτύχει με "command not found".
  assert.ok(
    existsSync(LOCAL_CLI_BIN),
    `node_modules/.bin/gmgn-cli δε βρέθηκε στο ${LOCAL_CLI_BIN} — λείπει από τα dependencies;`,
  );
});

// --- error path, με fake CLI αντί για πραγματικά requests ------------------------------

function fakeCli(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gmgn-fake-'));
  const file = path.join(dir, 'gmgn-cli');
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

async function withFakeCli<T>(body: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.GMGN_CLI_BIN;
  process.env.GMGN_CLI_BIN = fakeCli(body);
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.GMGN_CLI_BIN;
    else process.env.GMGN_CLI_BIN = previous;
  }
}

test('runCli appends --raw and returns parsed JSON', async () => {
  const result = await withFakeCli(
    'console.log(JSON.stringify({ argv: process.argv.slice(2) }));',
    () => runCli('market trenches', ['market', 'trenches']),
  );
  assert.deepEqual(result, { argv: ['market', 'trenches', '--raw'] });
});

test('a 429 becomes GmgnRateLimitError carrying retryAt — never a retry', async () => {
  await withFakeCli(
    `console.error(JSON.stringify({code:429,error:'RATE_LIMIT_BANNED',message:'slow down',reset_at:1775184222}));process.exit(1);`,
    async () => {
      await assert.rejects(runCli('market trenches', ['market', 'trenches']), (error: unknown) => {
        assert.ok(error instanceof GmgnRateLimitError);
        assert.deepEqual(error.retryAt, new Date(1775184222 * 1000));
        return true;
      });
    },
  );
});

test('a plain CLI failure becomes GmgnCliError with the exit code', async () => {
  await withFakeCli(
    `console.error('[gmgn-cli] Invalid chain: "notachain"');process.exit(1);`,
    async () => {
      await assert.rejects(runCli('market trenches', ['market', 'trenches']), (error: unknown) => {
        assert.ok(error instanceof GmgnCliError);
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /Invalid chain/);
        return true;
      });
    },
  );
});

test('non-JSON output becomes GmgnResponseError, not a crash', async () => {
  await withFakeCli("console.log('not json at all');", async () => {
    await assert.rejects(
      runCli('market trenches', ['market', 'trenches']),
      GmgnResponseError,
    );
  });
});
