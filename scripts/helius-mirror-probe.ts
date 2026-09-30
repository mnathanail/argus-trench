import 'dotenv/config';
import { fetchWalletActivity, type WalletActivity } from '../src/gmgn/activity.js';
import { parseWalletTrade } from '../src/mirror/heliusTrade.js';
import { HeliusLogsListener } from '../src/solana/heliusLogsListener.js';
import {
  getParsedTransaction,
  getParsedTransactionWithRetry,
  getSignaturesForAddress,
  heliusRpcUrl,
  heliusWsUrl,
} from '../src/solana/heliusRpc.js';

/**
 * Έλεγχος της Helius πηγής του mirror σε ΠΡΑΓΜΑΤΙΚΑ δεδομένα, πριν το MIRROR_HELIUS=on.
 *
 *   railway run npx tsx scripts/helius-mirror-probe.ts <wallet> [πλήθος=25] [--listen SEC]
 *
 * 1. Τις τελευταίες N συναλλαγές του wallet: τι διαβάζουμε εμείς (αγορά/πώληση, token, SOL,
 *    πρόγραμμα) δίπλα σε ό,τι λέει το GMGN για την ΙΔΙΑ συναλλαγή → διαφορά ποσών.
 * 2. --listen: ανοίγει τη live σύνδεση για SEC δευτερόλεπτα και δείχνει κάθε συναλλαγή που
 *    έρχεται με την καθυστέρηση (block → εμείς).
 */

const args = process.argv.slice(2);
const wallet = args.find((a) => !a.startsWith('--') && a.length > 30);
const limitArg = args.find((a) => /^\d+$/.test(a) && args[args.indexOf(a) - 1] !== '--listen');
const listenIdx = args.indexOf('--listen');
const listenSec = listenIdx >= 0 ? Number(args[listenIdx + 1] ?? 120) : 0;
const limit = limitArg ? Number(limitArg) : 25;
const apiKey = process.env.HELIUS_API_KEY;
if (!wallet || !apiKey) {
  console.error('Χρήση: helius-mirror-probe.ts <wallet> [πλήθος] [--listen SEC]  (χρειάζεται HELIUS_API_KEY)');
  process.exit(1);
}
const rpcUrl = heliusRpcUrl(apiKey);

function pct(a: number, b: number): string {
  if (!(b > 0)) return '—';
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
}

console.log(`\n=== 1. Τελευταίες ${limit} συναλλαγές του ${wallet.slice(0, 8)}: εμείς (Helius) vs GMGN ===`);
const sigs = await getSignaturesForAddress(rpcUrl, wallet, limit);
let gmgn = new Map<string, WalletActivity>();
try {
  const res = await fetchWalletActivity({ wallet, types: ['buy', 'sell'], limit: 50 });
  gmgn = new Map(res.activities.map((a) => [a.txHash, a]));
} catch (error) {
  console.log(`  (GMGN activity απέτυχε: ${error instanceof Error ? error.message : String(error)})`);
}

const solDiffPool: number[] = [];
const solDiffWallet: number[] = [];
const tokDiff: number[] = [];
let trades = 0;
let matched = 0;
const programVsLaunchpad = new Map<string, number>();
const skips = new Map<string, number>();
const oursSigs = new Set<string>();

for (const s of sigs) {
  if (s.err !== null && s.err !== undefined) {
    skips.set('failed', (skips.get('failed') ?? 0) + 1);
    continue;
  }
  let tx: Awaited<ReturnType<typeof getParsedTransaction>>;
  try {
    tx = await getParsedTransaction(rpcUrl, s.signature);
  } catch (error) {
    // Ένα σφάλμα σε μία συναλλαγή δεν σταματά τον έλεγχο — μετράει και φαίνεται.
    skips.set('rpc_error', (skips.get('rpc_error') ?? 0) + 1);
    console.log(`  ${s.signature.slice(0, 8)}  σφάλμα RPC: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`);
    continue;
  }
  const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString().slice(5, 19).replace('T', ' ') : '?';
  if (tx === null) {
    console.log(`  ${when} ${s.signature.slice(0, 8)}  getTransaction=null`);
    continue;
  }
  const p = parseWalletTrade(tx, wallet);
  const g = gmgn.get(s.signature);
  if (!p.ok) {
    skips.set(p.reason, (skips.get(p.reason) ?? 0) + 1);
    if (g) console.log(`  ${when} ${s.signature.slice(0, 8)}  εμείς: ΤΙΠΟΤΑ (${p.reason})  ← GMGN: ${g.eventType} ${g.tokenAddress.slice(0, 8)} sol=${g.quoteAmount}`);
    continue;
  }
  trades += 1;
  oursSigs.add(s.signature);
  const e = p.event;
  let line =
    `  ${when} ${s.signature.slice(0, 8)}  ${e.txType.padEnd(4)} ${e.mint.slice(0, 8)} ` +
    `tok=${e.tokenAmount.toFixed(0)} sol=${e.solAmount.toFixed(4)}(${p.solSource}) wallet=${p.walletSol.toFixed(4)} ` +
    `pool=${p.poolSol?.toFixed(4) ?? '—'} υπόλοιπο=${e.newTokenBalance?.toFixed(0)} ${p.program}`;
  if (g) {
    matched += 1;
    const gq = g.quoteAmount ?? NaN;
    line += `  | GMGN ${g.eventType} tok=${g.tokenAmount?.toFixed(0)} sol=${gq} ${g.launchpadPlatform ?? '?'}` +
      `  Δsol=${pct(e.solAmount, gq)} Δtok=${pct(e.tokenAmount, g.tokenAmount ?? NaN)}`;
    if (gq > 0) {
      if (p.poolSol !== null) solDiffPool.push(Math.abs(p.poolSol - gq) / gq);
      solDiffWallet.push(Math.abs(p.walletSol - gq) / gq);
    }
    if (g.tokenAmount) tokDiff.push(Math.abs(e.tokenAmount - g.tokenAmount) / g.tokenAmount);
    if (g.eventType !== e.txType) line += '  ⚠ ΑΛΛΟΣ ΤΥΠΟΣ';
    const k = `${p.program} ↔ ${g.launchpadPlatform ?? '?'}`;
    programVsLaunchpad.set(k, (programVsLaunchpad.get(k) ?? 0) + 1);
  } else {
    line += '  | GMGN: —';
  }
  console.log(line);
}

const oldest = sigs.at(-1)?.blockTime ?? 0;
const gmgnMissed = [...gmgn.values()].filter((a) => a.timestamp >= oldest && !oursSigs.has(a.txHash));
console.log('\n--- Σύνοψη ---');
console.log(`  συναλλαγές ${sigs.length}, αγορές/πωλήσεις που διαβάσαμε ${trades}, ίδιες με GMGN ${matched}`);
console.log(`  όχι trade: ${JSON.stringify(Object.fromEntries(skips))}`);
const f = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
console.log(`  διάμεση διαφορά SOL vs GMGN: pool ${f(median(solDiffPool))} · wallet ${f(median(solDiffWallet))} · tokens ${f(median(tokDiff))}`);
console.log(`  πρόγραμμα ↔ launchpad GMGN: ${JSON.stringify(Object.fromEntries(programVsLaunchpad))}`);
console.log(`  GMGN trades στο ίδιο διάστημα που ΔΕΝ διαβάσαμε: ${gmgnMissed.length}`);
for (const a of gmgnMissed.slice(0, 10)) console.log(`    ${a.txHash.slice(0, 8)} ${a.eventType} ${a.tokenAddress.slice(0, 8)} ${a.launchpadPlatform ?? '?'}`);

if (listenSec > 0) {
  console.log(`\n=== 2. Live σύνδεση για ${listenSec}s — κάθε νέα συναλλαγή του wallet με την καθυστέρηση ===`);
  let seen = 0;
  const listener = new HeliusLogsListener({
    wsUrl: heliusWsUrl(apiKey),
    log: (l) => console.log(`  ${l}`),
    onSignature: (w, sig, receivedAtMs) => {
      seen += 1;
      getParsedTransactionWithRetry(rpcUrl, sig)
        .then((tx) => {
          const doneMs = Date.now();
          if (tx === null) return console.log(`  ${sig.slice(0, 8)} getTransaction=null`);
          const bt = tx.blockTime ?? null;
          const notifyLag = bt === null ? '?' : ((receivedAtMs / 1000 - bt)).toFixed(1);
          const totalLag = bt === null ? '?' : ((doneMs / 1000 - bt)).toFixed(1);
          const p = parseWalletTrade(tx, w);
          console.log(
            `  ${sig.slice(0, 8)} ειδοποίηση +${notifyLag}s, έτοιμο +${totalLag}s → ` +
              (p.ok ? `${p.event.txType} ${p.event.mint.slice(0, 8)} sol=${p.event.solAmount.toFixed(4)} ${p.program}` : `όχι trade (${p.reason})`),
          );
        })
        .catch((error) => console.log(`  ${sig.slice(0, 8)} σφάλμα: ${error instanceof Error ? error.message : String(error)}`));
    },
  });
  listener.addWallet(wallet);
  listener.connect();
  await new Promise((r) => setTimeout(r, 5_000));
  console.log(`  ενεργές συνδρομές: ${listener.activeSubscriptions}`);
  await new Promise((r) => setTimeout(r, Math.max(0, listenSec * 1000 - 5_000)));
  listener.close();
  await new Promise((r) => setTimeout(r, 6_000)); // να τελειώσουν τα τελευταία getTransaction
  console.log(`  συναλλαγές που ήρθαν: ${seen}`);
}
process.exit(0);
