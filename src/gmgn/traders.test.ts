import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildTradersArgs, parseTradersResponse, traderRejectReason } from './traders.js';

// ⚠️ Fixture φτιαγμένο από το SKILL.md (σχήμα `token holders`), ΟΧΙ πραγματικό response —
// να αντικατασταθεί με την έξοδο του `npm run top-traders-check -- <mint> --raw`.
const FIXTURE = path.join(import.meta.dirname, '__fixtures__/token.traders.doc.json');
const traders = () => parseTradersResponse(JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown);
const NOW = 1759150000;

test('buildTradersArgs asks for top traders by profit', () => {
  assert.deepEqual(buildTradersArgs({ tokenAddress: 'Mint' }), [
    'token', 'traders', '--chain', 'sol', '--address', 'Mint', '--order-by', 'profit', '--direction', 'desc', '--limit', '50',
  ]);
});

test('parseTradersResponse uses the wallet `address`, not the token account, and accepts strings or numbers', () => {
  const [first, , , , dust, holding] = traders();
  assert.equal(first?.address, 'GoodTrader1111111111111111111111111111111111');
  assert.equal(first?.realizedPnl, 2.4);
  assert.equal(holding?.buyCostUsd, 250);
  assert.equal(dust?.endHoldingAt, null, 'end_holding_at 0 = still holding');
});

test('traderRejectReason keeps only profitable, non-sniper wallets that held ≥ 2′', () => {
  const reasons = Object.fromEntries(traders().map((t) => [t.address.slice(0, 6), traderRejectReason(t, NOW)]));
  assert.deepEqual(reasons, {
    GoodTr: null,
    Sniper: 'excluded_tag',
    QuickF: 'short_hold',
    PoolAd: 'not_wallet',
    Dust11: 'small_size',
    StillH: null,
    NoPnl1: 'not_sold',
  });
});

test('traderRejectReason: below 2x realized is rejected', () => {
  const [good] = traders();
  assert.ok(good);
  assert.equal(traderRejectReason({ ...good, realizedPnl: 0.99 }, NOW), 'low_profit');
});
