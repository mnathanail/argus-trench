import 'dotenv/config';
import { LAUNCHPAD_PLATFORMS } from '../src/decision/gateConfig.js';
import { runCli } from '../src/gmgn/exec.js';
import { buildTradersArgs, parseTradersResponse, traderRejectReason } from '../src/gmgn/traders.js';
import { fetchTrenches } from '../src/gmgn/trenches.js';
import { pickRecentGraduated } from '../src/collectors/walletDiscovery.js';

// Χρήση: railway run npm run top-traders-check                 (πιο πρόσφατο graduated token)
//        railway run npm run top-traders-check -- <mint>
//        railway run npm run top-traders-check -- <mint> --raw  (ολόκληρο το JSON, για fixture)
//
// 2026-09-29: επαλήθευση της νέας πηγής wallet discovery (gmgn/traders.ts) σε ΠΡΑΓΜΑΤΙΚΟ
// response: ποια πεδία έρχονται και ποιοι traders περνούν / απορρίπτονται και γιατί.
// Κανένα DB write. Κόστος: 1 `token traders` (weight 5) + 1 trenches αν δεν δοθεί mint.

const args = process.argv.slice(2);
const rawMode = args.includes('--raw');
let mint = args.find((a) => !a.startsWith('--'));
if (mint === undefined) {
  const graduated = await fetchTrenches({ category: 'completed', launchpadPlatforms: LAUNCHPAD_PLATFORMS });
  mint = pickRecentGraduated(graduated, 1)[0]?.tokenAddress;
  if (mint === undefined) throw new Error('κανένα graduated token');
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
