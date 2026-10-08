import 'dotenv/config';
import { closePool, getPool } from '../src/db/pool.js';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT } from '../src/mirror/heliusTrade.js';
import { decodeBondingCurve, locatePool, parsedTokenAmount, type PoolRpc } from '../src/realtime/heliusPriceFeed.js';
import {
  getMultipleAccounts,
  getParsedTransaction,
  getTokenAccountsByOwner,
  getTokenLargestAccounts,
  heliusRpcUrl,
} from '../src/solana/heliusRpc.js';

/**
 * 2026-10-08 — διάγνωση: γιατί trades μας έδειξαν κορυφή χιλιάδων SOL σε tokens με ATH ~$10–50k.
 *
 *   railway run npx tsx scripts/price-probe.ts <mint> [<mint> …]
 *
 * Ανά token (~6 credits Helius):
 *  1. mint: πρόγραμμα (Token / Token-2022), supply, decimals.
 *  2. Οι μεγαλύτεροι κάτοχοι: ποσό, owner, και σε ποιο πρόγραμμα ανήκει ο owner.
 *  3. Τι διαλέγει σήμερα το `locatePool` (curve ή PumpSwap) και η τιμή/market cap που θα έδινε.
 *  4. Τα trades μας στο token (είσοδος / κορυφή / έξοδος σε SOL mcap) και η συναλλαγή του σήματος:
 *     τα υπόλοιπα του αντισυμβαλλόμενου που χρησιμοποίησε το withPoolPrice.
 * Δεν αλλάζει τίποτα.
 */

const mints = process.argv.slice(2).filter((a) => a.length > 30);
const apiKey = process.env.HELIUS_API_KEY;
if (mints.length === 0 || !apiKey) {
  console.error('Χρήση: price-probe.ts <mint> [<mint> …]  (χρειάζεται HELIUS_API_KEY)');
  process.exit(1);
}
const url = heliusRpcUrl(apiKey);
const rpc: PoolRpc = {
  largest: (mint) => getTokenLargestAccounts(url, mint),
  accounts: (addresses, encoding) => getMultipleAccounts(url, addresses, encoding),
  tokenAccountsByOwner: (owner, mint) => getTokenAccountsByOwner(url, owner, mint),
};
const short = (a: string | null | undefined) => (a ? a.slice(0, 8) : '—');
const programName = (p: string | undefined) =>
  p === PUMP_PROGRAM ? 'PUMP.FUN' : p === PUMP_AMM_PROGRAM ? 'PUMPSWAP' : p === '11111111111111111111111111111111' ? 'system(wallet)' : short(p);
type Parsed = { parsed?: { info?: { owner?: string; supply?: string; decimals?: number; tokenAmount?: { amount: string; decimals: number } } } };

const pool = getPool();
try {
  for (const mint of mints) {
    console.log(`\n══════ ${mint}`);
    const [mintInfo] = await getMultipleAccounts(url, [mint], 'jsonParsed');
    const mi = (mintInfo?.data as Parsed | undefined)?.parsed?.info;
    console.log(
      `mint: πρόγραμμα ${short(mintInfo?.owner)} (${mintInfo?.owner?.startsWith('TokenzQd') ? 'Token-2022' : 'Token'}) · ` +
        `supply ${mi?.supply && mi.decimals !== undefined ? (Number(mi.supply) / 10 ** mi.decimals).toLocaleString('en') : '—'} · decimals ${mi?.decimals ?? '—'}`,
    );

    const largest = await getTokenLargestAccounts(url, mint);
    const infos = await getMultipleAccounts(url, largest.map((l) => l.address), 'jsonParsed');
    const owners = infos.map((i) => (i?.data as Parsed | undefined)?.parsed?.info?.owner ?? null);
    const uniq = [...new Set(owners.filter((o): o is string => o !== null))];
    const ownerInfos = await getMultipleAccounts(url, uniq, 'base64');
    const progOf = new Map(uniq.map((o, i) => [o, ownerInfos[i]?.owner]));
    console.log('μεγαλύτεροι κάτοχοι (token account · ποσό · owner · πρόγραμμα του owner):');
    largest.slice(0, 8).forEach((l, i) => {
      const o = owners[i] ?? null;
      console.log(`  ${short(l.address)}  ${String(Math.round(l.uiAmount ?? 0)).padStart(13)}  ${short(o)}  ${programName(o === null ? undefined : progOf.get(o))}`);
    });
    for (const [i, o] of uniq.entries()) {
      if (progOf.get(o) !== PUMP_PROGRAM) continue;
      const raw = ownerInfos[i]?.data;
      const buf = Array.isArray(raw) && typeof raw[0] === 'string' ? Buffer.from(raw[0], 'base64') : null;
      if (buf === null || buf.length < 49) continue;
      const s = decodeBondingCurve(buf);
      console.log(
        `  curve ${short(o)}: len ${buf.length} · vTok ${s?.virtualTokenReserves.toFixed(0)} · vSol ${s?.virtualSolReserves.toFixed(3)} · ` +
          `realTok ${(Number(buf.readBigUInt64LE(24)) / 1e6).toFixed(0)} · realSol ${(Number(buf.readBigUInt64LE(32)) / 1e9).toFixed(3)} · ` +
          `supply ${(Number(buf.readBigUInt64LE(40)) / 1e6).toFixed(0)} · complete ${buf.readUInt8(48)} → mcap ${s ? ((s.virtualSolReserves / s.virtualTokenReserves) * 1e9).toFixed(1) : '—'} SOL`,
      );
    }

    const loc = await locatePool(mint, rpc);
    if (loc === null) console.log('locatePool: ΤΙΠΟΤΑ (καμία τιμή)');
    else if (loc.kind === 'curve')
      console.log(`locatePool: CURVE ${short(loc.curve)} → mcap ${((loc.state.virtualSolReserves / loc.state.virtualTokenReserves) * 1e9).toFixed(1)} SOL`);
    else
      console.log(
        `locatePool: PUMPSWAP pool ${short(loc.pool)} base ${short(loc.base)} (${loc.baseUi.toFixed(0)} tokens) quote ${short(loc.quote)} (${loc.quoteSol.toFixed(3)} wSOL) ` +
          `→ mcap ${((loc.quoteSol / loc.baseUi) * 1e9).toFixed(1)} SOL`,
      );

    const { rows } = await pool.query<{ id: string; entry: string; peak: string | null; exit: string | null; sig: string | null; src: string | null }>(
      `SELECT id, simulated_entry_price * 1e9 AS entry, peak_price_since_entry * 1e9 AS peak, simulated_exit_price * 1e9 AS exit,
              entry_timing_json->'signal'->>'signature' AS sig, entry_timing_json->>'signal_source' AS src
         FROM paper_trades WHERE token_address = $1 ORDER BY entry_at`,
      [mint],
    );
    for (const r of rows) {
      console.log(
        `trade #${r.id} (${r.src ?? '?'}): mcap SOL είσοδος ${Number(r.entry).toFixed(1)} · κορυφή ${r.peak ? Number(r.peak).toFixed(1) : '—'} · έξοδος ${r.exit ? Number(r.exit).toFixed(1) : '—'}`,
      );
      if (r.sig === null || r.src !== 'helius') continue;
      const tx = await getParsedTransaction(url, r.sig);
      if (tx === null || tx.meta === null) {
        console.log(`  σήμα ${short(r.sig)}: δεν βρέθηκε`);
        continue;
      }
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
      const programs = keys.filter((k) => k === PUMP_PROGRAM || k === PUMP_AMM_PROGRAM).map(programName);
      console.log(`  σήμα ${short(r.sig)}: προγράμματα ${[...new Set(programs)].join(',') || '—'}`);
      for (const post of tx.meta.postTokenBalances ?? []) {
        if (post.mint !== mint && post.mint !== WSOL_MINT) continue;
        const pre = (tx.meta.preTokenBalances ?? []).find((p) => p.accountIndex === post.accountIndex);
        const amt = (b: typeof post | undefined) => (b === undefined ? 0 : (parsedTokenAmount({ parsed: { info: { tokenAmount: b.uiTokenAmount } } }) ?? 0));
        const idx = post.owner ? keys.indexOf(post.owner) : -1;
        const lam = idx >= 0 ? `${((tx.meta.postBalances[idx] ?? 0) / 1e9).toFixed(3)} SOL` : '—';
        console.log(
          `    ${post.mint === WSOL_MINT ? 'wSOL ' : 'token'} owner ${short(post.owner)} (${programName(post.owner ? progOf.get(post.owner) : undefined)}): ` +
            `${amt(pre).toFixed(0)} → ${amt(post).toFixed(0)} · lamports του owner ${lam}`,
        );
      }
    }
  }
} finally {
  await closePool();
}
process.exit(0);
