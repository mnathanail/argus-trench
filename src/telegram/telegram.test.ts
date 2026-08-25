import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseWalletStats, pnlBucketsSumTo, type WalletStats } from '../gmgn/walletStats.js';
import type { WatchlistWallet } from '../db/repositories/watchlistWallets.js';
import type { WalletScoreEntry } from '../db/repositories/walletScoreHistory.js';
import { authorize, handleUpdate } from './bot.js';
import { handleCommand, isLikelySolanaAddress, type CommandDeps } from './commands.js';
import { TelegramClient, type TelegramUpdate } from './api.js';

const STATS_FIXTURE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '../gmgn/__fixtures__/portfolio.stats.json'), 'utf8'),
) as unknown;

const ADDRESS = 'AV7PjXHL5JXZ1YoYRoN9Dsstg1x2UciBupMCXcJP8gUz';

// --- walletStats -----------------------------------------------------------------------

test('parseWalletStats reads winrate from pnl_stat, not top level', () => {
  const stats = parseWalletStats(STATS_FIXTURE);
  assert.equal(stats.walletAddress, ADDRESS);
  assert.equal(typeof stats.winRate, 'number');
  assert.ok((stats.winRate ?? 0) > 0.5 && (stats.winRate ?? 0) < 0.53);
  // Τα ποσά είναι strings στο raw response.
  assert.equal(typeof stats.realizedPnlRatio, 'number');
  assert.equal(typeof stats.realizedProfitUsd, 'number');
});

test('tokenCount is the winrate denominator, not buy+sell', () => {
  const stats = parseWalletStats(STATS_FIXTURE);
  const buckets = pnlBucketsSumTo(STATS_FIXTURE);
  assert.ok(buckets);
  // Ο έλεγχος που καθορίζει τη σημασιολογία: τα pnl buckets αθροίζουν σε token_num.
  assert.equal(buckets.sum, buckets.tokenNum);
  assert.equal(stats.tokenCount, buckets.tokenNum);
  // ...και είναι σαφώς διαφορετικό από το πλήθος συναλλαγών.
  assert.notEqual(stats.tokenCount, (stats.buyCount ?? 0) + (stats.sellCount ?? 0));
});

// --- authorization ---------------------------------------------------------------------

test('an empty allowlist authorises nobody (fail closed)', () => {
  assert.equal(authorize(123, []).allowed, false);
  assert.match(authorize(123, []).reason, /not set/);
  // Το id πρέπει να εμφανίζεται: είναι ο τεκμηριωμένος τρόπος να το ανακαλύψεις.
  assert.match(authorize(123, []).reason, /123/);
});

test('a rejection log always names the chat id', async () => {
  const logged: string[] = [];
  await handleUpdate(
    { update_id: 1, message: { message_id: 1, chat: { id: 555, type: 'private' }, text: '/list' } },
    { client: fakeClient([]), deps: stubDeps(), allowedChatIds: [], log: (m) => logged.push(m) },
  );
  assert.match(logged[0] ?? '', /555/);
});

test('only allowlisted chats are authorised', () => {
  assert.equal(authorize(42, [42, 43]).allowed, true);
  assert.equal(authorize(99, [42, 43]).allowed, false);
});

test('an unauthorised chat gets no reply at all', async () => {
  const sent: string[] = [];
  const client = fakeClient(sent);
  const update: TelegramUpdate = {
    update_id: 1,
    message: { message_id: 1, chat: { id: 999, type: 'private' }, text: '/list' },
  };
  await handleUpdate(update, {
    client,
    deps: stubDeps(),
    allowedChatIds: [42],
    log: () => undefined,
  });
  // Σιωπή: μια απάντηση θα επιβεβαίωνε ότι το bot υπάρχει και ποιος το έχει.
  assert.deepEqual(sent, []);
});

test('an authorised chat gets a reply', async () => {
  const sent: string[] = [];
  await handleUpdate(
    { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: '/list' } },
    { client: fakeClient(sent), deps: stubDeps(), allowedChatIds: [42], log: () => undefined },
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? '', /watchlist είναι κενή|Ενεργά wallets/);
});

test('a failing command replies with an error instead of crashing the loop', async () => {
  const sent: string[] = [];
  const deps = stubDeps();
  deps.listActiveWallets = () => Promise.reject(new Error('db is down'));
  await handleUpdate(
    { update_id: 1, message: { message_id: 1, chat: { id: 42, type: 'private' }, text: '/list' } },
    { client: fakeClient(sent), deps, allowedChatIds: [42], log: () => undefined },
  );
  assert.match(sent[0] ?? '', /db is down/);
});

// --- commands --------------------------------------------------------------------------

test('address validation rejects obvious non-addresses', () => {
  assert.ok(isLikelySolanaAddress(ADDRESS));
  assert.ok(!isLikelySolanaAddress('NOTAWALLET'));
  assert.ok(!isLikelySolanaAddress('0xdeadbeef'));
  // Το base58 δεν έχει 0, O, I, l.
  assert.ok(!isLikelySolanaAddress('0'.repeat(40)));
});

test('/watch adds the wallet as active even when scoring fails', async () => {
  const deps = stubDeps();
  const upserted: string[] = [];
  deps.upsertWallet = (input) => {
    upserted.push(input.address);
    assert.equal(input.active, true, 'manual wallets είναι ενεργά αμέσως');
    return Promise.resolve(wallet(input.address));
  };
  deps.fetchStats = () => Promise.reject(new Error('GMGN rate limit hit'));

  const reply = await handleCommand(`/watch ${ADDRESS}`, deps);
  assert.deepEqual(upserted, [ADDRESS]);
  assert.match(reply, /Προστέθηκε/);
  assert.match(reply, /scoring απέτυχε/);
});

test('/watch persists the score using token_num and the realized PnL ratio', async () => {
  const deps = stubDeps();
  const captured: unknown[] = [];
  deps.insertScore = (input) => {
    captured.push(input);
    return Promise.resolve();
  };
  const reply = await handleCommand(`/watch ${ADDRESS}`, deps);
  assert.deepEqual(captured, [
    { walletAddress: ADDRESS, winRate: 0.6, pnlMultiplier: 0.33, tradeCount: 40 },
  ]);
  assert.match(reply, /win rate: 60\.0%/);
});

test('/watch flags a weak wallet for review but never deactivates it', async () => {
  const deps = stubDeps({ winRate: 0.3, tokenCount: 4 });
  const reply = await handleCommand(`/watch ${ADDRESS}`, deps);
  assert.match(reply, /Άξιο review/);
  assert.match(reply, /μικρό δείγμα/);
  assert.match(reply, /Δεν απενεργοποιήθηκε/);
});

test('/score reports the trend against the previous measurement', async () => {
  const deps = stubDeps({ winRate: 0.42 });
  deps.getWallet = (address) => Promise.resolve(wallet(address));
  deps.recentScores = () =>
    Promise.resolve([
      { id: 2, walletAddress: ADDRESS, recordedAt: new Date(), winRate: 0.6, pnlMultiplier: 1, tradeCount: 30 },
    ] satisfies WalletScoreEntry[]);

  const reply = await handleCommand(`/score ${ADDRESS}`, deps);
  assert.match(reply, /τάση win rate: ↓ -18\.0 pp από 60\.0%/);
});

test('/unwatch distinguishes a real deactivation from an unknown address', async () => {
  const deps = stubDeps();
  deps.setWalletActive = () => Promise.resolve(true);
  assert.match(await handleCommand(`/unwatch ${ADDRESS}`, deps), /Απενεργοποιήθηκε/);

  deps.setWalletActive = () => Promise.resolve(false);
  assert.match(await handleCommand(`/unwatch ${ADDRESS}`, deps), /Δεν βρέθηκε/);
});

test('commands tolerate the /cmd@BotName form and missing arguments', async () => {
  const deps = stubDeps();
  assert.match(await handleCommand('/help', deps), /wallet watching/);
  assert.match(await handleCommand('/watch@ArgusTrenchBot', deps), /Λείπει το address/);
  assert.match(await handleCommand('/nonsense', deps), /Άγνωστη εντολή/);
});

test('/watchlist lists every active wallet regardless of source, with win/pnl/positions', async () => {
  const deps = stubDeps();
  deps.listActiveWallets = () =>
    Promise.resolve([
      wallet(ADDRESS),
      { ...wallet('AutoDiscoveredSmartMoneyAddr111111111111'), source: 'smart_money', winRate: 0.55, pnlMultiplier: -0.1, tradeCount: 20 },
    ]);

  const reply = await handleCommand('/watchlist', deps);
  assert.match(reply, /Ενεργά wallets \(2\)/);
  assert.match(reply, /manual \| win 60\.0% \| pnl \+33\.0% \| 40 θέσεις/);
  assert.match(reply, /smart_money \| win 55\.0% \| pnl -10\.0% \| 20 θέσεις/);
});

test('/list is an alias of /watchlist', async () => {
  const deps = stubDeps();
  deps.listActiveWallets = () => Promise.resolve([wallet(ADDRESS)]);
  const [viaList, viaWatchlist] = await Promise.all([
    handleCommand('/list', deps),
    handleCommand('/watchlist', deps),
  ]);
  assert.equal(viaList, viaWatchlist);
});

test('/unwatch vetoes an auto-discovered wallet that already passed the algorithmic threshold', async () => {
  const deps = stubDeps();
  const deactivated: string[] = [];
  deps.setWalletActive = (address, active) => {
    deactivated.push(address);
    assert.equal(active, false);
    return Promise.resolve(true);
  };
  // Ένα smart_money wallet με win_rate/trade_count πάνω από το auto-discovery threshold —
  // δηλαδή θα ήταν active από το algorithmic gate, όχι από χειροκίνητη προσθήκη.
  const reply = await handleCommand('/unwatch AutoDiscoveredSmartMoneyAddr111111111111', deps);
  assert.deepEqual(deactivated, ['AutoDiscoveredSmartMoneyAddr111111111111']);
  assert.match(reply, /Απενεργοποιήθηκε/);
});

// --- helpers ---------------------------------------------------------------------------

function fakeClient(sent: string[]): TelegramClient {
  const client = new TelegramClient({ token: 'test', fetchImpl: notCalled });
  // Αντικαθιστούμε μόνο το sendMessage: δε θέλουμε δίκτυο στα tests.
  client.sendMessage = async (_chatId: number, text: string) => {
    sent.push(text);
  };
  return client;
}

const notCalled: typeof fetch = () => {
  throw new Error('fetch should not be called in these tests');
};

function wallet(address: string): WatchlistWallet {
  return {
    id: 1,
    address,
    chain: 'sol',
    source: 'manual',
    winRate: 0.6,
    pnlMultiplier: 0.33,
    tradeCount: 40,
    active: true,
    addedAt: new Date(0),
    lastReviewedAt: null,
    lastSeenTxHash: null,
    lastSeenActivityAt: null,
  };
}

function stubDeps(statsOverride: Partial<WalletStats> = {}): CommandDeps {
  const stats: WalletStats = {
    walletAddress: ADDRESS,
    winRate: 0.6,
    tokenCount: 40,
    realizedPnlRatio: 0.33,
    realizedProfitUsd: 1234,
    buyCount: 100,
    sellCount: 120,
    avgHoldingPeriodSec: 2702,
    lastTradeAt: 1787666779,
    ...statsOverride,
  };
  return {
    fetchStats: () => Promise.resolve(stats),
    upsertWallet: (input) => Promise.resolve(wallet(input.address)),
    getWallet: () => Promise.resolve(null),
    setWalletActive: () => Promise.resolve(true),
    updateWalletScore: (address) => Promise.resolve(wallet(address)),
    insertScore: () => Promise.resolve(),
    recentScores: () => Promise.resolve([]),
    listActiveWallets: () => Promise.resolve([]),
  };
}
