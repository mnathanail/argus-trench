import { runCli, type RunOptions } from './exec.js';
import { GmgnResponseError } from './errors.js';
import { expectArray, expectObject, toNumber } from './validate.js';

/**
 * Watchdog client (2026-09-17, incident #1193 — βλ. migration 0013/0014, CLAUDE.md
 * "Ό,τι μένει ακόμα ανοιχτό"). Route `portfolio token-balance`, weight 1 (ήδη στο
 * routes.ts, ΚΑΝΕΝΑΣ adapter δεν το χρησιμοποιούσε πριν από αυτό) — `GET
 * /v1/user/wallet_token_balance`.
 *
 * Σκοπός: ένα ΔΕΥΤΕΡΟ, ανεξάρτητο δίχτυ ασφαλείας πάνω σε ΟΛΑ τα ανοιχτά `mode='live'`
 * trades (βλ. liveTradeWatchdog.ts) — όχι μόνο όσα έχουν ενεργό native order (αυτά τα
 * καλύπτει ήδη ο liveStrategyReconciler). Διαβάζει το ΠΡΑΓΜΑΤΙΚΟ on-chain token balance
 * του live wallet· αν είναι 0, η θέση έφυγε από κάπου αλλού (π.χ. το websocket feed
 * πάγωσε σιωπηλά χωρίς 'close' event — καμία heartbeat/staleness ανίχνευση υπάρχει ακόμα
 * στο pumpportalConnection.ts) — βλ. σχόλιο στο liveTradeWatchdog.ts.
 *
 * ΔΙΟΡΘΩΣΗ 2026-09-19 (πραγματικό εύρημα, live production call): το αρχικό parsing
 * (πριν αυτή τη διόρθωση) δοκίμαζε top-level πεδία (`balance`/`token_balance`/`amount`/
 * `ui_amount`) απευθείας στο root object — ΛΑΘΟΣ σχήμα. Το πραγματικό response είναι:
 * ```json
 * { "balances": [ { "wallet_address": "...", "token_address": "...", "balance": "0",
 *                    "decimal": 0, "height": 448450539, "tx_index": 0 } ] }
 * ```
 * δηλαδή ένα **wrapper array `balances`**, με το πραγματικό `balance` (string) μέσα στο
 * ΠΡΩΤΟ στοιχείο — όχι top-level. Αυτό το ασύμφωνο σχήμα (unsafe cast/wrong-shape
 * ανάγνωση) έκανε το `fetchTokenBalance` να πετάει `GmgnResponseError` σε ΚΑΘΕ κλήση,
 * ό,τι κι αν ήταν το πραγματικό balance — επιβεβαιωμένο live: `live-trade-watchdog:
 * fetchTokenBalance απέτυχε` σε κάθε κύκλο των 5 λεπτών, για τρία ανοιχτά live trades
 * (#1243/#1246/#1248) που είχαν ήδη κλείσει χειροκίνητα στο GMGN — ο watchdog δεν
 * μπόρεσε ΠΟΤΕ να τα σημαδέψει `needs_manual_exit`, ίδιο μοτίβο ακριβώς με το #1225
 * (εκεί ήταν το `portfolio info`/SOL wallet schema, εδώ το token-balance schema).
 *
 * Άδειο `balances` array (κανένα token account γι' αυτό το mint) σημαίνει επίσης
 * balance=0 — ΔΕΝ είναι σφάλμα, είναι έγκυρη αναπαράσταση "καμία θέση".
 *
 * Το `decimal` πεδίο ΔΕΝ χρησιμοποιείται εδώ — το `balance` string φαίνεται ήδη
 * human-readable (π.χ. "0"), ίδιο μοτίβο με άλλα string-typed numeric πεδία στο GMGN CLI
 * (βλ. CLAUDE.md, "Verified CLI contract"). Ανεπιβεβαίωτο σε μη-μηδενική τιμή ακόμα — αν
 * ποτέ φανεί raw on-chain base-units τιμή αντί για human-readable, θα χρειαστεί
 * `balance / 10**decimal` εδώ.
 */

export async function fetchTokenBalance(
  walletAddress: string,
  tokenAddress: string,
  options: RunOptions = {},
): Promise<number> {
  const raw = await runCli(
    'portfolio token-balance',
    ['portfolio', 'token-balance', '--chain', 'sol', '--wallet', walletAddress, '--token', tokenAddress],
    options,
  );
  return parseTokenBalance(raw);
}

/** Εξαγόμενο ξεχωριστά ώστε να τεσταρίζεται χωρίς πραγματικό CLI call. Το πραγματικό
 * σχήμα (επιβεβαιωμένο live 2026-09-19): `{ balances: [{ balance: "<string>", ... }] }`.
 * Άδειο array -> 0 (καμία θέση). Παίρνει το ΠΡΩΤΟ στοιχείο — το route φιλτράρει ήδη με
 * `--wallet`/`--token`, άρα δεν αναμένεται ποτέ >1 αποτέλεσμα σε αυτή τη χρήση. */
export function parseTokenBalance(raw: unknown): number {
  const response = expectObject(raw, 'portfolio.token-balance');

  const balancesRaw = response['balances'];
  if (balancesRaw === undefined || balancesRaw === null) {
    throw new GmgnResponseError(`missing 'balances' array in response`, 'portfolio.token-balance');
  }
  const balances = expectArray(balancesRaw, 'portfolio.token-balance.balances');

  if (balances.length === 0) return 0; // κανένα token account γι' αυτό το mint -> balance 0

  const first = expectObject(balances[0], 'portfolio.token-balance.balances[0]');
  const value = first['balance'];
  if (value === undefined || value === null) {
    throw new GmgnResponseError(`missing 'balance' field in balances[0]`, 'portfolio.token-balance.balances[0]');
  }
  return toNumber(value, 'portfolio.token-balance.balances[0].balance');
}
