import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_SOL_FOR_TRADE_PRICE,
  isDustGraduatedTrade,
  isGraduatedEvent,
  parseTradeEvent,
  priceFromTradeEvent,
} from './pumpportalEvents.js';

const REAL_BUY_EVENT = {
  signature:
    '5EMqqRbMjAPF4tBPNw1TJNv6LcFyFMJ8rhXJfVihaZVSYkvorn2j85o4h222XGDretUX4MR54MsnRUhXuMfT6SiF',
  mint: '5ygJ27k1ZyUBdeR9LeNxQ5vZ4n4togt3kxxcYnHUpump',
  traderPublicKey: '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5',
  txType: 'buy',
  tokenAmount: 30589322.786086,
  solAmount: 2.629842459,
  newTokenBalance: 30589322.786086,
  bondingCurveKey: 'B8b9eismEq7HFU8dhgongN354P6FfhWp81ghvdB8r5yL',
  vTokensInBondingCurve: 596796597.218102,
  vSolInBondingCurve: 53.93797509913754,
  marketCapSol: 90.37915991907988,
  pool: 'pump',
};

test('parseTradeEvent: parses the real, confirmed buy event correctly', () => {
  const parsed = parseTradeEvent(REAL_BUY_EVENT);
  assert.ok(parsed !== null);
  assert.equal(parsed.mint, '5ygJ27k1ZyUBdeR9LeNxQ5vZ4n4togt3kxxcYnHUpump');
  assert.equal(parsed.traderPublicKey, '3JQvkiF2GKfca3ggMPRwTHmzvnj6emReuSFwSrBBonp5');
  assert.equal(parsed.txType, 'buy');
  assert.equal(parsed.pool, 'pump');
});

test('parseTradeEvent: a sell event (same shape, different txType) parses too', () => {
  const sellEvent = { ...REAL_BUY_EVENT, txType: 'sell' };
  const parsed = parseTradeEvent(sellEvent);
  assert.equal(parsed?.txType, 'sell');
});

test('parseTradeEvent: returns null for the subscription-ack message, does not throw', () => {
  const ack = { message: 'Successfully subscribed to keys.' };
  assert.equal(parseTradeEvent(ack), null);
});

test('parseTradeEvent: returns null for garbage input instead of throwing', () => {
  assert.equal(parseTradeEvent(null), null);
  assert.equal(parseTradeEvent('a string'), null);
  assert.equal(parseTradeEvent(42), null);
  assert.equal(parseTradeEvent({}), null);
  assert.equal(parseTradeEvent({ mint: 'onlyMint' }), null);
});

test('priceFromTradeEvent: matches the independently-derived marketCapSol (real event, sanity check)', () => {
  const parsed = parseTradeEvent(REAL_BUY_EVENT);
  assert.ok(parsed !== null);
  const price = priceFromTradeEvent(parsed);
  assert.ok(price !== null);
  assert.ok(parsed.marketCapSol !== undefined);
  const impliedByMarketCap = parsed.marketCapSol / 1_000_000_000;
  assert.ok(
    Math.abs(price - impliedByMarketCap) / impliedByMarketCap < 0.01,
    `price=${price} πολύ μακριά από implied=${impliedByMarketCap}`,
  );
});

test('ΑΛΛΑΓΗ 2026-09-27: once a token migrated off the bonding curve (pool !== "pump"), price comes from the trade itself (solAmount/tokenAmount), not the stale reserves', () => {
  const migrated = { ...REAL_BUY_EVENT, pool: 'raydium' };
  const parsed = parseTradeEvent(migrated);
  assert.ok(parsed !== null);
  assert.equal(isGraduatedEvent(parsed), true);
  assert.equal(priceFromTradeEvent(parsed), REAL_BUY_EVENT.solAmount / REAL_BUY_EVENT.tokenAmount);
});

test('trade-derived price is in the SAME units as the bonding-curve price (SOL per token) — same real event, both formulas within a few %', () => {
  // Ίδιο πραγματικό event: η μέση τιμή εκτέλεσης (solAmount/tokenAmount) και η spot τιμή
  // μετά το trade (vSol/vTokens) πρέπει να είναι της ίδιας τάξης — αλλιώς οι μονάδες
  // διαφέρουν και stop-loss/trailing θα έβγαιναν τελείως λάθος σε graduated tokens.
  const parsed = parseTradeEvent(REAL_BUY_EVENT);
  assert.ok(parsed !== null);
  const spot = priceFromTradeEvent(parsed);
  assert.ok(spot !== null);
  const tradePrice = REAL_BUY_EVENT.solAmount / REAL_BUY_EVENT.tokenAmount;
  assert.ok(Math.abs(tradePrice - spot) / spot < 0.05, `trade=${tradePrice} spot=${spot}`);
});

test('priceFromTradeEvent: returns null instead of dividing by zero on a degenerate vTokensInBondingCurve', () => {
  const degenerate = { ...REAL_BUY_EVENT, vTokensInBondingCurve: 0 };
  const parsed = parseTradeEvent(degenerate);
  assert.ok(parsed !== null);
  assert.equal(priceFromTradeEvent(parsed), null);
});

// ΔΙΟΡΘΩΣΗ 2026-09-27 — πραγματικό σχήμα event για ήδη-αποφοιτημένο token (Railway log,
// token BPHarSVwpav5SpxMoqb9cePBnCM1PAznBS1Srqohpump, 2026-09-27T07:34:21Z): το PumpPortal
// παραλείπει ΕΝΤΕΛΩΣ vTokensInBondingCurve/vSolInBondingCurve/marketCapSol/pool αντί να
// στέλνει άλλες/null τιμές — πριν τη διόρθωση, parseTradeEvent το απέρριπτε σιωπηλά (null).
const GRADUATED_TOKEN_EVENT = {
  signature:
    '3vN1nUYnfXbxWvz9BEXQeqpvGSHU9wUiC2E1oPCBRShnv6bp8eXAJyi3fFV3q88NBnvhwEojkC1KqfN46xLNTBmM',
  mint: 'BPHarSVwpav5SpxMoqb9cePBnCM1PAznBS1Srqohpump',
  traderPublicKey: '9pQVwXk2G6y4B5Wn7hM1XyzRJ4Dq3rF8LmN0oT6sVbUe',
  txType: 'buy',
  tokenAmount: 12345.6789,
  solAmount: 0.05,
};

test('parseTradeEvent: no longer discards a real post-graduation event missing all 4 bonding-curve fields', () => {
  const parsed = parseTradeEvent(GRADUATED_TOKEN_EVENT);
  assert.ok(parsed !== null, 'ένα πραγματικό, καλοσχηματισμένο event δεν πρέπει να απορρίπτεται');
  assert.equal(parsed.mint, 'BPHarSVwpav5SpxMoqb9cePBnCM1PAznBS1Srqohpump');
  assert.equal(parsed.txType, 'buy');
  assert.equal(parsed.vTokensInBondingCurve, undefined);
  assert.equal(parsed.vSolInBondingCurve, undefined);
  assert.equal(parsed.marketCapSol, undefined);
  assert.equal(parsed.pool, undefined);
});

test('ΑΛΛΑΓΗ 2026-09-27: real post-graduation shape (bonding-curve fields absent) gets a trade-derived price', () => {
  const parsed = parseTradeEvent(GRADUATED_TOKEN_EVENT);
  assert.ok(parsed !== null);
  assert.equal(isGraduatedEvent(parsed), true);
  assert.equal(priceFromTradeEvent(parsed), GRADUATED_TOKEN_EVENT.solAmount / GRADUATED_TOKEN_EVENT.tokenAmount);
});

test('graduated dust trade (below MIN_SOL_FOR_TRADE_PRICE, e.g. the real 0.000987 SOL one) gives NO price — never a garbage stop-loss trigger', () => {
  const parsed = parseTradeEvent({ ...GRADUATED_TOKEN_EVENT, solAmount: 0.000987653 });
  assert.ok(parsed !== null);
  assert.ok(0.000987653 < MIN_SOL_FOR_TRADE_PRICE);
  assert.equal(priceFromTradeEvent(parsed), null);
  assert.equal(isDustGraduatedTrade(parsed), true);
});

test('graduated trade with non-positive tokenAmount gives no price (no divide-by-zero), and is NOT dust', () => {
  const parsed = parseTradeEvent({ ...GRADUATED_TOKEN_EVENT, tokenAmount: 0 });
  assert.ok(parsed !== null);
  assert.equal(priceFromTradeEvent(parsed), null);
  assert.equal(isDustGraduatedTrade(parsed), false);
});

test('bonding-curve events are never "graduated" and a tiny bonding-curve trade still gets its reserve price', () => {
  const parsed = parseTradeEvent({ ...REAL_BUY_EVENT, solAmount: 0.0001 });
  assert.ok(parsed !== null);
  assert.equal(isGraduatedEvent(parsed), false);
  assert.equal(isDustGraduatedTrade(parsed), false);
  assert.notEqual(priceFromTradeEvent(parsed), null);
});

test('parseTradeEvent: still rejects an event missing a REQUIRED core field, even without the bonding-curve fields', () => {
  const { mint: _mint, ...missingMint } = GRADUATED_TOKEN_EVENT;
  assert.equal(parseTradeEvent(missingMint), null);
});

test('parseTradeEvent: rejects a present-but-wrong-typed optional bonding-curve field (defensive, not just absence)', () => {
  const wrongType = { ...GRADUATED_TOKEN_EVENT, pool: 12345 };
  assert.equal(parseTradeEvent(wrongType), null);
});
