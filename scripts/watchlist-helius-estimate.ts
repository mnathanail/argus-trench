import 'dotenv/config';
import { closePool } from '../src/db/pool.js';
import { listActiveWallets } from '../src/db/repositories/watchlistWallets.js';
import { getSignaturesForAddress, heliusRpcUrl } from '../src/solana/heliusRpc.js';

/**
 * «Πόσα Helius credits θα έκαιγε όλη η watchlist;» (2026-10-01). Μετράει τις ΠΡΑΓΜΑΤΙΚΕΣ
 * συναλλαγές κάθε ενεργού wallet στις τελευταίες N ώρες (getSignaturesForAddress, 1 credit
 * ανά σελίδα των 1000) και εκτιμά το κόστος αν τα παρακολουθούσαμε όπως τον mirror wallet:
 *   - κάθε συναλλαγή (και αποτυχημένη) = μία ειδοποίηση logsSubscribe ≈ 7 KB → 0.14 credits
 *     (2 credits ανά 0.1 MB),
 *   - κάθε επιτυχημένη = getTransaction (1 credit) +30% επαναλήψεις όταν δεν είναι έτοιμη.
 *
 *   railway run npx tsx scripts/watchlist-helius-estimate.ts [ώρες=24]
 *
 * Κόστος του ίδιου του script: ~1 credit ανά wallet (+1 ανά επιπλέον 1000 συναλλαγές).
 */

const hours = Number(process.argv[2] ?? 24);
const MAX_PAGES = 5; // 5000 συναλλαγές ανά wallet αρκούν για εκτίμηση
const NOTIFY_CREDITS = 0.14;
const READ_CREDITS = 1.3;
const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) {
  console.error('Χρειάζεται HELIUS_API_KEY');
  process.exit(1);
}
const url = heliusRpcUrl(apiKey);
const since = Math.floor(Date.now() / 1000) - hours * 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sigsWithRetry(address: string, before?: string) {
  for (const wait of [0, 500, 1_000, 2_000, 4_000]) {
    if (wait > 0) await sleep(wait);
    try {
      return await getSignaturesForAddress(url, address, 1000, before);
    } catch (error) {
      if (error instanceof Error && /HTTP 429/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error('HTTP 429 επίμονα');
}

interface Row { address: string; name: string | null; mode: string; total: number; failed: number; capped: boolean; error?: string }

try {
  const wallets = await listActiveWallets();
  console.log(`\n${wallets.length} ενεργά wallets — μετράω συναλλαγές των τελευταίων ${hours}h…`);
  const rows: Row[] = [];
  let calls = 0;
  for (const [i, w] of wallets.entries()) {
    const row: Row = { address: w.address, name: w.name, mode: w.copyMode ?? 'signal', total: 0, failed: 0, capped: false };
    try {
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const sigs = await sigsWithRetry(w.address, before);
        calls += 1;
        await sleep(125);
        const inWindow = sigs.filter((s) => (s.blockTime ?? 0) >= since);
        row.total += inWindow.length;
        row.failed += inWindow.filter((s) => s.err !== null && s.err !== undefined).length;
        if (inWindow.length < sigs.length || sigs.length < 1000) break;
        if (page === MAX_PAGES - 1) row.capped = true;
        before = sigs.at(-1)!.signature;
      }
    } catch (error) {
      row.error = error instanceof Error ? error.message.slice(0, 80) : String(error);
    }
    rows.push(row);
    if (i > 0 && i % 25 === 0) console.log(`  … ${i}/${wallets.length}`);
  }

  const perDay = (r: Row) => (24 / hours) * (r.total * NOTIFY_CREDITS + (r.total - r.failed) * READ_CREDITS);
  rows.sort((a, b) => perDay(b) - perDay(a));
  const ok = rows.filter((r) => r.error === undefined);
  const sum = (list: Row[]) => list.reduce((s, r) => s + perDay(r), 0);
  const totalTx = ok.reduce((s, r) => s + r.total, 0);
  const totalFailed = ok.reduce((s, r) => s + r.failed, 0);

  console.log('\n=== Τα 15 πιο ενεργά wallets ===');
  console.log('  wallet     όνομα           mode     συναλλαγές (αποτυχ.)   credits/μέρα');
  for (const r of ok.slice(0, 15)) {
    console.log(
      `  ${r.address.slice(0, 8)}  ${(r.name ?? '—').slice(0, 14).padEnd(14)}  ${r.mode.padEnd(7)}  ${String(r.total).padStart(6)}${r.capped ? '+' : ' '} (${String(r.failed).padStart(5)})   ${perDay(r).toFixed(0).padStart(7)}`,
    );
  }
  const medianTx = [...ok].map((r) => r.total).sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? 0;
  const idle = ok.filter((r) => r.total === 0).length;

  console.log('\n--- Σύνοψη ---');
  console.log(`  wallets: ${ok.length} (χωρίς καμία συναλλαγή: ${idle}, σφάλματα: ${rows.length - ok.length})`);
  console.log(`  συναλλαγές σε ${hours}h: ${totalTx} (αποτυχημένες ${totalFailed}) · διάμεσο ανά wallet: ${medianTx}`);
  const day = sum(ok);
  console.log(`  ΕΚΤΙΜΗΣΗ όλη η watchlist: ~${day.toFixed(0)} credits/μέρα → ~${((day * 30) / 1000).toFixed(0)}k/μήνα (όριο 1.000k)`);
  for (const n of [5, 10, 20]) {
    if (ok.length > n) {
      const rest = sum(ok.slice(n));
      console.log(`  χωρίς τα ${n} πιο ενεργά: ~${rest.toFixed(0)}/μέρα → ~${((rest * 30) / 1000).toFixed(0)}k/μήνα`);
    }
  }
  console.log(`\n  (+ = πάνω από ${MAX_PAGES * 1000} συναλλαγές, μετρήθηκαν μέχρι εκεί.) Κόστος αυτού του script: ~${calls} credits.`);
} finally {
  await closePool();
}
process.exit(0);
