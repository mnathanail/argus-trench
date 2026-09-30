import 'dotenv/config';
import { PAPER_ASSUMED_FEES_PCT, PAPER_ASSUMED_SLIPPAGE_PCT } from '../src/decision/paperTradingConfig.js';
import { copyResult, splitEpisodes, walletResult, type Episode, type WalletTrade } from '../src/mirror/copyReplay.js';
import { parseWalletTrade } from '../src/mirror/heliusTrade.js';
import { getParsedTransaction, getSignaturesForAddress, heliusRpcUrl, type SignatureInfo } from '../src/solana/heliusRpc.js';

/**
 * Πραγματικές on-chain συναλλαγές ενός wallet (Helius — ό,τι δείχνει και το Solscan) και
 * «τι θα έβγαινε» με κάθε τρόπο αντιγραφής. Μόνο Pump.fun / PumpSwap με SOL (όπως το mirror).
 *
 *   railway run npx tsx scripts/wallet-onchain-replay.ts <wallet> [ώρες=24] [--max 4000]
 *
 * Credits Helius: ~1 ανά συναλλαγή (+1 ανά 1000 υπογραφές).
 */

const args = process.argv.slice(2);
const wallet = args.find((a) => a.length > 30);
const hours = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a) && args[args.indexOf(a) - 1] !== '--max') ?? 24);
const maxIdx = args.indexOf('--max');
const maxTx = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 4000;
const apiKey = process.env.HELIUS_API_KEY;
if (!wallet || !apiKey) {
  console.error('Χρήση: wallet-onchain-replay.ts <wallet> [ώρες] [--max N]  (χρειάζεται HELIUS_API_KEY)');
  process.exit(1);
}
const url = heliusRpcUrl(apiKey);
const since = Math.floor(Date.now() / 1000) - hours * 3600;

// 1. Υπογραφές στο παράθυρο
const sigs: SignatureInfo[] = [];
let before: string | undefined;
for (;;) {
  const page = await getSignaturesForAddress(url, wallet, 1000, before);
  if (page.length === 0) break;
  for (const s of page) if ((s.blockTime ?? 0) >= since) sigs.push(s);
  const last = page.at(-1)!;
  if ((last.blockTime ?? 0) < since || page.length < 1000 || sigs.length >= maxTx) break;
  before = last.signature;
}
const ok = sigs.filter((s) => s.err === null || s.err === undefined).slice(0, maxTx);
console.log(`\n${wallet.slice(0, 8)}: ${sigs.length} συναλλαγές στις τελευταίες ${hours}h (${sigs.length - ok.length} αποτυχημένες) — διαβάζω ${ok.length}…`);

// 2. Ανάγνωση — μία-μία, ~8/δευτ. (το δωρεάν πλάνο του Helius δίνει 429 σε ριπές), με
// επανάληψη στο 429 (0.5 → 1 → 2 → 4 → 8″). Έτσι δεν "κλέβουμε" όριο από τον live listener.
const trades: WalletTrade[] = [];
const skips = new Map<string, number>();
const bump = (k: string) => skips.set(k, (skips.get(k) ?? 0) + 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchWithRetry(sig: string) {
  for (const wait of [0, 500, 1_000, 2_000, 4_000, 8_000]) {
    if (wait > 0) await sleep(wait);
    try {
      return await getParsedTransaction(url, sig);
    } catch (error) {
      if (error instanceof Error && /HTTP 429/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error('HTTP 429 επίμονα');
}
for (let i = 0; i < ok.length; i += 1) {
  const s = ok[i]!;
  let tx;
  try {
    tx = await fetchWithRetry(s.signature);
  } catch (error) {
    bump('rpc_error');
    if ((skips.get('rpc_error') ?? 0) <= 3) console.log(`  σφάλμα ${s.signature.slice(0, 8)}: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
    continue;
  }
  await sleep(125);
  if (tx === null) {
    bump('δεν βρέθηκε');
    continue;
  }
  const p = parseWalletTrade(tx, wallet);
  if (!p.ok) {
    bump(p.reason);
    continue;
  }
  if (p.program === 'other') {
    bump('άλλο launchpad/DEX');
    continue;
  }
  trades.push({
    mint: p.event.mint,
    txType: p.event.txType,
    sol: p.event.solAmount,
    tokens: p.event.tokenAmount,
    balanceAfter: p.event.newTokenBalance ?? 0,
    blockTime: p.blockTime ?? 0,
    signature: p.event.signature,
  });
  if (i > 0 && i % 100 === 0) console.log(`  … ${i}/${ok.length}`);
}
console.log(`  Pump.fun trades με SOL: ${trades.length} · όχι trade: ${JSON.stringify(Object.fromEntries(skips))}`);

// 3. Επεισόδια και αποτελέσματα
const { episodes, incomplete } = splitEpisodes(trades);
const opts = { buySol: 0.1, slippagePct: PAPER_ASSUMED_SLIPPAGE_PCT, feesPct: PAPER_ASSUMED_FEES_PCT };
const f = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
const pc = (v: number | null) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);

interface Agg { n: number; wallet: number; walletIn: number; all: number; allIn: number; first: number; firstIn: number; wWins: number; aWins: number; fWins: number }
const agg = (): Agg => ({ n: 0, wallet: 0, walletIn: 0, all: 0, allIn: 0, first: 0, firstIn: 0, wWins: 0, aWins: 0, fWins: 0 });
const add = (a: Agg, ep: Episode) => {
  const w = walletResult(ep);
  const al = copyResult(ep, 'all', opts);
  const fi = copyResult(ep, 'first', opts);
  a.n += 1;
  a.wallet += w.pnlSol; a.walletIn += w.solIn; if (w.pnlSol > 0) a.wWins += 1;
  a.all += al.pnlSol; a.allIn += al.solIn; if (al.pnlSol > 0) a.aWins += 1;
  a.first += fi.pnlSol; a.firstIn += fi.solIn; if (fi.pnlSol > 0) a.fWins += 1;
  return { w, al, fi };
};

const closed = episodes.filter((e) => e.closed);
const open = episodes.filter((e) => !e.closed);
console.log(`\n=== ${closed.length} κλειστές θέσεις του (ελλιπείς, αγορασμένες πριν το παράθυρο: ${incomplete}) ===`);
console.log('  ώρα         token     αγορές  ΑΥΤΟΣ (SOL, %)     | ΑΝΤΙΓΡΑΦΗ ΟΛΩΝ (0.1/αγορά) | ΜΟΝΟ 1η (0.1)');
const total = agg();
const byBuys = new Map<string, Agg>();
for (const ep of closed) {
  const { w, al, fi } = add(total, ep);
  const bucket = w.buys === 1 ? '1 αγορά' : w.buys <= 3 ? '2-3 αγορές' : '4+ αγορές';
  add(byBuys.get(bucket) ?? (byBuys.set(bucket, agg()), byBuys.get(bucket)!), ep);
  const when = new Date(ep.startTime * 1000).toISOString().slice(5, 16).replace('T', ' ');
  const mins = ((ep.endTime - ep.startTime) / 60).toFixed(0);
  console.log(
    `  ${when} ${ep.mint.slice(0, 8)}  ${String(w.buys).padStart(3)}  ${f(w.pnlSol).padStart(8)} ${pc(w.pnlPct).padStart(6)} (${mins}′)` +
      `  | ${f(al.pnlSol).padStart(7)} ${pc(al.pnlPct).padStart(6)}  | ${f(fi.pnlSol).padStart(7)} ${pc(fi.pnlPct).padStart(6)}`,
  );
}

const line = (label: string, a: Agg) =>
  `  ${label.padEnd(12)} θέσεις ${String(a.n).padStart(3)} | αυτός ${f(a.wallet)} SOL (${pc(a.walletIn > 0 ? a.wallet / a.walletIn : null)}, wins ${a.wWins})` +
  ` | όλες ${f(a.all)} SOL (μέσα ${a.allIn.toFixed(1)}, wins ${a.aWins}) | μόνο 1η ${f(a.first)} SOL (μέσα ${a.firstIn.toFixed(1)}, wins ${a.fWins})`;
console.log('\n--- Σύνοψη κλειστών ---');
console.log(line('ΣΥΝΟΛΟ', total));
for (const k of ['1 αγορά', '2-3 αγορές', '4+ αγορές']) if (byBuys.has(k)) console.log(line(k, byBuys.get(k)!));

if (open.length > 0) {
  const o = agg();
  for (const ep of open) add(o, ep);
  console.log(`\n  ακόμα ανοιχτές (αποτίμηση στην τελευταία τιμή του): ${line('ανοιχτές', o).trim()}`);
}
console.log('\nΣημ.: «αυτός» = SOL από/προς το pool, χωρίς τα δικά του fees. Αντιγραφή: +3% slippage στην αγορά, −2% fees.');
process.exit(0);
