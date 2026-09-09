import assert from 'node:assert/strict';
import { test } from 'node:test';

import { subscribeForNewTrade, subscribeOpenTrades } from './subscriptionManager.js';

function fakeConnection() {
  const subscribedTokens: string[] = [];
  const subscribedWallets: string[] = [];
  return {
    subscribedTokens,
    subscribedWallets,
    subscribeToken: (mint: string) => {
      subscribedTokens.push(mint);
    },
    subscribeWallet: (address: string) => {
      subscribedWallets.push(address);
    },
  };
}

test('subscribeOpenTrades: subscribes to every token, and every non-null trigger wallet', () => {
  const conn = fakeConnection();
  subscribeOpenTrades(conn, [
    { tokenAddress: 'TokenA', triggerWalletAddress: 'WalletA' },
    { tokenAddress: 'TokenB', triggerWalletAddress: null },
    { tokenAddress: 'TokenC', triggerWalletAddress: 'WalletC' },
  ]);

  assert.deepEqual(conn.subscribedTokens, ['TokenA', 'TokenB', 'TokenC']);
  assert.deepEqual(conn.subscribedWallets, ['WalletA', 'WalletC']);
});

test('subscribeOpenTrades: an empty list subscribes to nothing, does not throw', () => {
  const conn = fakeConnection();
  subscribeOpenTrades(conn, []);
  assert.equal(conn.subscribedTokens.length, 0);
  assert.equal(conn.subscribedWallets.length, 0);
});

test('subscribeForNewTrade: subscribes to both the token and the wallet when both are given', () => {
  const conn = fakeConnection();
  subscribeForNewTrade(conn, 'TokenA', 'WalletA');
  assert.deepEqual(conn.subscribedTokens, ['TokenA']);
  assert.deepEqual(conn.subscribedWallets, ['WalletA']);
});

test('subscribeForNewTrade: a null trigger wallet subscribes only the token', () => {
  const conn = fakeConnection();
  subscribeForNewTrade(conn, 'TokenA', null);
  assert.deepEqual(conn.subscribedTokens, ['TokenA']);
  assert.equal(conn.subscribedWallets.length, 0);
});
