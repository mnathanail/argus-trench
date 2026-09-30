import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';
import { fetchWalletActivity, type WalletActivity } from '../src/gmgn/activity.js';
import { delay } from '../src/util/delay.js';

// Χρήση: railway run npm run wallet-buys-check -- <wallet> [μέρες=3]
//
// 2026-09-30 (ρητό αίτημα χρήστη): πόσες αγορές έκανε ΠΡΑΓΜΑΤΙΚΑ ένα wallet (GMGN
// `portfolio activity`, on-chain) και πόσες από αυτές πήραμε εμείς — και για όσες δεν
// πήραμε, τι λέει η βάση για το token (gate απέρριψε / δεν αξιολογήθηκε ποτέ / άλλο wallet
// το πήρε πρώτο / όχι Pump.fun). Read-only. Κόστος: weight 3 ανά σελίδα των 50 αγορών.

const MAX_PAGES = 30;

interface TokenRow {
  token_address: string;
  passed: boolean;
  fail_reasons: string | null;
  sources: string | null;
  ours: boolean;
  any_trade: boolean;
}

const wallet = process.argv[2];
const days = Number(process.argv[3] ?? 3);
if (wallet === undefined || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
  console.error('Χρήση: npm run wallet-buys-check -- <wallet> [μέρες]');
  process.exit(1);
}
const cutoffSec = Math.floor(Date.now() / 1000) - days * 86_400;
const pool = getPool();

try {
  const buys: WalletActivity[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetchWalletActivity({ wallet, types: ['buy'], limit: 50, cursor });
    buys.push(...res.activities.filter((a) => a.timestamp >= cutoffSec));
    const reachedCutoff = res.activities.some((a) => a.timestamp < cutoffSec);
    if (reachedCutoff || res.nextCursor === null) break;
    cursor = res.nextCursor;
    await delay(1_500);
  }

  const tokens = [...new Set(buys.map((b) => b.tokenAddress))];
  const { rows } = await pool.query<TokenRow>(
    `SELECT d.token_address,
            bool_or(d.gate_passed)                                         AS passed,
            string_agg(DISTINCT d.gate_fail_reason, '; ')                  AS fail_reasons,
            string_agg(DISTINCT d.candidate_source, ',')                   AS sources,
            bool_or(pt.id IS NOT NULL AND d.trigger_wallet_address = $2)   AS ours,
            bool_or(pt.id IS NOT NULL)                                     AS any_trade
       FROM decision_log d
       LEFT JOIN paper_trades pt ON pt.decision_log_id = d.id
      WHERE d.token_address = ANY($1::text[])
      GROUP BY 1`,
    [tokens, wallet],
  );
  const byToken = new Map(rows.map((r) => [r.token_address, r]));

  const classify = (b: WalletActivity): string => {
    const r = byToken.get(b.tokenAddress);
    if (r?.ours) return 'πήραμε (από αυτό το wallet)';
    if (r?.any_trade) return 'πήραμε (από άλλο wallet)';
    // Το activity δεν φέρνει launchpad (επιβεβαιωμένο fixture) — τα Pump.fun mints τελειώνουν σε "pump".
    if (!b.tokenAddress.endsWith('pump')) return 'μάλλον όχι Pump.fun (mint χωρίς κατάληξη pump)';
    if (r === undefined) return 'δεν αξιολογήθηκε ποτέ (graduated / εκτός feed / δεν το είδαμε)';
    if (!r.passed) return `gate απέρριψε: ${(r.fail_reasons ?? '?').split(';')[0]?.replace(/[\d.]+/g, '#').trim()}`;
    return 'gate πέρασε, κανένα trade';
  };

  console.log(`\n=== ${wallet.slice(0, 8)} — αγορές τις τελευταίες ${days} μέρες (GMGN): ${buys.length}, μοναδικά tokens ${tokens.length} ===`);
  const byDay = new Map<string, WalletActivity[]>();
  for (const b of buys) {
    const day = new Date(b.timestamp * 1000).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), b]);
  }
  for (const [day, list] of [...byDay.entries()].sort()) {
    const uniq = new Map(list.map((b) => [b.tokenAddress, b]));
    const counts = new Map<string, number>();
    for (const b of uniq.values()) counts.set(classify(b), (counts.get(classify(b)) ?? 0) + 1);
    console.log(`\n  ${day}: ${list.length} αγορές σε ${uniq.size} tokens`);
    for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${k}`);
  }
} finally {
  await closePool();
}
