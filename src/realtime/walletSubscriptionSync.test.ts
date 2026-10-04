import assert from 'node:assert/strict';
import { test } from 'node:test';

import { desiredWalletSubscriptions, isRealtimeSignalWallet, planWalletSubscriptions } from './walletSubscriptionSync.js';

test('isRealtimeSignalWallet: bot (< 60″) εκτός· άγνωστο ή 60″+ μέσα· mirror πάντα μέσα', () => {
  assert.equal(isRealtimeSignalWallet({ copyMode: 'signal', avgHoldingSec: 9 }), false);
  assert.equal(isRealtimeSignalWallet({ copyMode: 'signal', avgHoldingSec: 60 }), true);
  assert.equal(isRealtimeSignalWallet({ copyMode: 'signal', avgHoldingSec: null }), true);
  assert.equal(isRealtimeSignalWallet({ copyMode: 'signal' }), true);
  assert.equal(isRealtimeSignalWallet({ copyMode: 'mirror', avgHoldingSec: 5 }), true);
});

test('planWalletSubscriptions: προσθέτει ό,τι λείπει, αφαιρεί ό,τι περισσεύει', () => {
  assert.deepEqual(planWalletSubscriptions(['A', 'B', 'C'], ['B', 'C', 'D']), { add: ['D'], remove: ['A'] });
  assert.deepEqual(planWalletSubscriptions([], []), { add: [], remove: [] });
});

test('desiredWalletSubscriptions: ενεργά μη-bot + wallets ανοιχτών trades (ακόμα κι αν bot/ανενεργά), χωρίς διπλά', () => {
  const d = desiredWalletSubscriptions(
    [
      { address: 'Human', copyMode: 'signal', avgHoldingSec: 3600 },
      { address: 'Bot', copyMode: 'signal', avgHoldingSec: 5 },
      { address: 'Mirror', copyMode: 'mirror', avgHoldingSec: 5 },
    ],
    ['Bot', 'Human', null, 'Old'],
  );
  assert.deepEqual(d.sort(), ['Bot', 'Human', 'Mirror', 'Old']);
});
