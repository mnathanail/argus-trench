import 'dotenv/config';
import { runCli } from '../src/gmgn/exec.js';
import { buildTradersArgs, parseTradersResponse, traderRejectReason } from '../src/gmgn/traders.js';
import { buildTrendingArgs, parseTrendingResponse } from '../src/gmgn/trending.js';

// Χρήση: railway run npm run top-traders-check                 (1ο token του trending που χρησιμοποιεί το discovery)
//        railway run npm run top-traders-check -- <mint>
//        railway run npm run top-traders-check -- <mint> --raw  (ολόκληρο το JSON, για fixture)
//
// 2026-09-29: επαλήθευση της νέας πηγής wallet discovery (gmgn/traders.ts) σε ΠΡΑΓΜΑΤΙΚΟ
// response: ποια πεδία έρχονται και ποιοι traders περνούν / απορρίπτονται και γιατί.
// Κανένα DB write. Κόστος: 1 `token traders` (weight 5) + 1 trending (weight 1) αν δεν δοθεί mint.

const args = process.argv.slice(2);
const rawMode = args.includes('--raw');
let mint = args.find((a) => !a.startsWith('--'));
if (mint === undefined) {
  const rawTrending = await runCli('market trending', buildTrendingArgs(), {});
  let tokens;
  try {
    tokens = parseTrendingResponse(rawTrending);
  } catch (error) {
    console.log(`❌ trending: άγνωστο σχήμα (${(error as Error).message}). Αρχή response:\n${JSON.stringify(rawTrending).slice(0, 1500)}`);
    process.exit(1);
  }
  console.log(`\nTrending (όπως το discovery): ${tokens.length} tokens`);
  for (const t of tokens.slice(0, 10)) {
    const age = t.creationTimestamp === null ? '?' : `${((Date.now() / 1000 - t.creationTimestamp) / 3600).toFixed(1)}h`;
    console.log(`  ${t.address.slice(0, 8)} ATH $${t.historyHighestMarketCap?.toFixed(0) ?? '?'} ηλικία ${age}`);
  }
  mint = tokens[0]?.address;
  if (mint === undefined) throw new Error('κανένα token στο trending');
}

const raw = await runCli('token traders', buildTradersArgs({ tokenAddress: mint }), {});
if (rawMode) {
  console.log(JSON.stringify(raw));
} else {
  const list = (raw as { list?: Record<string, unknown>[] }).list ?? [];
  console.log(`\nToken ${mint}: ${list.length} traders`);
  const first = list[0];
  if (first !== undefined) {
    const want = ['address', 'addr_type', 'tags', 'maker_token_tags', 'realized_profit', 'realized_pnl', 'history_bought_cost', 'start_holding_at', 'end_holding_at'];
    console.log(`πεδία που χρειαζόμαστε: ${want.map((k) => `${k}${k in first ? '✅' : '❌'}`).join(' ')}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const t of parseTradersResponse(raw)) {
    const held = t.startHoldingAt === null ? '?' : `${Math.round(((t.endHoldingAt ?? nowSec) - t.startHoldingAt) / 60)}′`;
    const reason = traderRejectReason(t, nowSec);
    console.log(
      `  ${t.address.slice(0, 8)} ${reason === null ? '✅ ΠΕΡΝΑΕΙ ' : `✗ ${reason.padEnd(12)}`} ` +
        `pnl ${t.realizedPnl === null ? '?' : `${(t.realizedPnl * 100).toFixed(0)}%`} αγορά $${t.buyCostUsd?.toFixed(0) ?? '?'} ` +
        `κράτημα ${held} tags ${[...t.tags, ...t.makerTokenTags].join(',') || '-'}`,
    );
  }
}
