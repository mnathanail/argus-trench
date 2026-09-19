import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateExitAmountSol, inferExitReason, parseStrategyOrder } from './strategyOrders.js';

// estimateExitAmountSol — 2026-09-17, κοινό μεταξύ του live strategy reconciler
// (collectors/liveStrategyReconciler.ts) ΚΑΙ του exit handler's idempotent-guard
// (realtimeExitHandler.ts) — και τα δύο μαθαίνουν για ένα ήδη-κλεισμένο native order,
// μόνο από διαφορετική αφορμή, και ΠΡΕΠΕΙ να υπολογίζουν το ίδιο πραγματικό pnl.

test('estimateExitAmountSol: applies the real GMGN open/close price ratio to the real entry amount', () => {
  // token διπλασιάστηκε (open 0.001 -> close 0.002) πάνω σε πραγματικό entry 2 SOL
  const result = estimateExitAmountSol(2, 0.001, 0.002);
  assert.equal(result, 4);
});

test('estimateExitAmountSol: a loss ratio scales down correctly', () => {
  // -50%: close τιμή η μισή της open
  const result = estimateExitAmountSol(2, 0.002, 0.001);
  assert.equal(result, 1);
});

test('estimateExitAmountSol: null entry amount -> null (δεν έχουμε πραγματικό baseline)', () => {
  assert.equal(estimateExitAmountSol(null, 0.001, 0.002), null);
});

test('estimateExitAmountSol: null openPrice -> null (δε γίνεται ratio)', () => {
  assert.equal(estimateExitAmountSol(2, null, 0.002), null);
});

test('estimateExitAmountSol: openPrice=0 -> null (θα ήταν διαίρεση με το μηδέν)', () => {
  assert.equal(estimateExitAmountSol(2, 0, 0.002), null);
});

test('estimateExitAmountSol: null closePrice -> null', () => {
  assert.equal(estimateExitAmountSol(2, 0.001, null), null);
});

test('inferExitReason: a reason code containing "loss" maps to stop_loss', () => {
  assert.equal(inferExitReason('loss_stop'), 'stop_loss');
  assert.equal(inferExitReason('LOSS_STOP_TRACE'), 'stop_loss');
});

test('inferExitReason: anything else defaults to trailing_stop (the only other sub-order type we attach)', () => {
  assert.equal(inferExitReason('profit_stop_trace'), 'trailing_stop');
  assert.equal(inferExitReason(''), 'trailing_stop');
  assert.equal(inferExitReason('unknown_code'), 'trailing_stop');
});

// parseStrategyOrder — πραγματικό incident 2026-09-19, trade #1225: το GMGN native
// trailing-stop όντως έκλεισε τη θέση, αλλά το raw response είχε `status: "canceled"`
// (εκτός του τεκμηριωμένου 'open'/'closed' enum) ΚΑΙ απόν top-level `close_price` — και
// τα δύο σιωπηλά χάνονταν πριν αυτή τη διόρθωση, αφήνοντας το trade ανοιχτό επ' αόριστον
// στη βάση μας χωρίς pnl. Το ακριβές (περικομμένο) response σχήμα από το production
// incident, αναπαραγμένο εδώ.
//
// ΣΗΜΑΝΤΙΚΟ (αναθεωρήθηκε την ίδια μέρα): το πραγματικό on-chain sell tx (επιβεβαιωμένο
// στο Solscan από τον χρήστη) έδωσε 0.2809 SOL έναντι 0.05213884 SOL entry, δηλαδή
// +438.75% — ΟΧΙ το +100% που θα έδινε το `check_price` του sub-order (μια πρώτη,
// λανθασμένη εκδοχή αυτού του fix δοκίμασε ακριβώς αυτό το fallback). Κανένα διαθέσιμο
// πεδίο σε αυτό το response σχήμα δεν αποδείχθηκε αξιόπιστο για το πραγματικό pnl, άρα
// το parseStrategyOrder ΔΕΝ μαντεύει closePrice πια — μένει null όταν λείπει το ρητό
// top-level `close_price`, και ο caller (liveStrategyReconciler) σημαδεύει
// needs_manual_exit αντί να κλείσει το trade με λάθος/null pnl.
const REAL_INCIDENT_RESPONSE = {
  order_id: '1debe27d-fa48-4f95-850e-50d1a14b2092',
  status: 'canceled', // ΟΧΙ 'open'/'closed' — αυτό ήταν το raw production response
  strategy_status: 'canceled',
  reason_by: 'trade_finish',
  reason_code: '',
  open_price: '0.00003037281871184',
  // ΣΚΟΠΙΜΑ χωρίς `close_price` — απόν στο πραγματικό response.
  record_high_price: '0.000280721436933271608',
  condition_orders: [
    {
      cid: '0b2507d2-faaa-4e60-ad8d-8f2a80e0070b',
      order_type: 'profit_stop_trace',
      status: 'success',
      check_price: '0.00006074563742368', // επιβεβαιωμένα ΑΝΑΞΙΟΠΙΣΤΟ ως exit price — βλ. πάνω
    },
    {
      cid: '80dacd39-683e-456c-9db1-9f99d643a6c9',
      order_type: 'loss_stop',
      status: 'cancel',
    },
  ],
};

test('parseStrategyOrder: πραγματικό incident response (status="canceled") κανονικοποιείται σε closed, όχι σιωπηλό pass-through', () => {
  const parsed = parseStrategyOrder(REAL_INCIDENT_RESPONSE);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.status, 'closed');
});

test('parseStrategyOrder: closePrice μένει null όταν λείπει το top-level close_price — ΔΕΝ μαντεύει από sub-order πεδία (επιβεβαιωμένα αναξιόπιστα)', () => {
  const parsed = parseStrategyOrder(REAL_INCIDENT_RESPONSE);
  assert.equal(parsed?.closePrice, null);
});

test('parseStrategyOrder: ρητό top-level close_price χρησιμοποιείται κανονικά όταν υπάρχει', () => {
  const withExplicitClosePrice = { ...REAL_INCIDENT_RESPONSE, close_price: '0.00009' };
  const parsed = parseStrategyOrder(withExplicitClosePrice);
  assert.equal(parsed?.closePrice, 0.00009);
});

test('parseStrategyOrder: status="open" παραμένει open (δεν κανονικοποιείται σιωπηλά σε closed)', () => {
  const stillOpen = { ...REAL_INCIDENT_RESPONSE, status: 'open' };
  const parsed = parseStrategyOrder(stillOpen);
  assert.equal(parsed?.status, 'open');
});

test('parseStrategyOrder: το checkPrice του sub-order παραμένει προσβάσιμο (visibility/diagnostics) αλλά ΔΕΝ χρησιμοποιείται πια για pnl', () => {
  const parsed = parseStrategyOrder(REAL_INCIDENT_RESPONSE);
  const successSubOrder = parsed?.conditionOrders.find((o) => o.status === 'success');
  assert.equal(successSubOrder?.checkPrice, 0.00006074563742368);
  // το closePrice παραμένει null ανεξάρτητα — το checkPrice είναι μόνο πληροφοριακό
  assert.equal(parsed?.closePrice, null);
});
