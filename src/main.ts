import { runDiscoveryCycle } from './collectors/discovery.js';
import { runExitResolverCycle } from './collectors/exitResolver.js';
import { runDailyDigestCycle } from './collectors/dailyDigest.js';
import {
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_INITIAL_DELAY_MS,
  DISCOVERY_RETRY_BACKOFF_MS,
  DAILY_DIGEST_INTERVAL_MS,
  EXIT_RESOLVER_INITIAL_DELAY_MS,
  EXIT_RESOLVER_INTERVAL_MS,
  WALLET_DISCOVERY_INTERVAL_MS,
  WALLET_DISCOVERY_INITIAL_DELAY_MS,
  WALLET_DISCOVERY_RETRY_BACKOFF_MS,
  WALLET_SCORING_INTERVAL_MS,
  WALLET_SCORING_INITIAL_DELAY_MS,
  WALLET_SCORING_RETRY_BACKOFF_MS,
  EXIT_RESOLVER_RETRY_BACKOFF_MS,
} from './collectors/intervals.js';
import { runWalletScoringCycle } from './collectors/scoring.js';
import { runWalletDiscoveryCycle } from './collectors/walletDiscovery.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { listActiveWallets } from './db/repositories/watchlistWallets.js';
import { listOpenTradesWithWallet } from './db/repositories/paperTrades.js';
import { logicVersion } from './decision/gateConfig.js';
import { msUntilNextAthensTime } from './util/athensTime.js';
import { PumpPortalConnection } from './realtime/pumpportalConnection.js';
import { subscribeAllActiveWallets, subscribeOpenTrades } from './realtime/subscriptionManager.js';
import { handleRealtimeTradeEvent } from './realtime/realtimeExitHandler.js';
import { handleRealtimeEntryEvent } from './realtime/realtimeEntryHandler.js';
import { runScheduler, SharedCooldown, type LoopDefinition } from './scheduler.js';
import { createBotFromEnv, runBot } from './telegram/bot.js';
import { formatPercent, short } from './telegram/commands.js';

/**
 * Entrypoint. Ένα process για όλα (απόφαση 2026-08-25): Telegram bot + οι collector loops
 * της Φάσης 1. Καμία συναλλαγή — `GMGN_ALLOW_AUTOMATED_TRADES` μένει unset μέχρι τη Φάση 5,
 * και κανένα wallet δεν είναι δεμένο στο API key.
 */
const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[main] ${signal} — shutting down`);
    controller.abort();
  });
}

const bot = createBotFromEnv(controller.signal);
const me = await bot.client.getMe();
console.log(`[main] telegram bot @${me.username ?? me.id} connected`);
console.log(`[main] logic_version = ${logicVersion()}`);

if (bot.allowedChatIds.length === 0) {
  console.warn(
    '[main] TELEGRAM_CHAT_ID is empty — every command will be refused. ' +
      'Send a message to the bot and read the chat id from the rejection log.',
  );
}

/** Τα alerts πάνε στο πρώτο allowlisted chat· χωρίς allowlist δεν έχουμε πού. */
async function notify(text: string): Promise<void> {
  const target = bot.allowedChatIds[0];
  if (target === undefined) {
    console.warn(`[alert, undelivered — no TELEGRAM_CHAT_ID]\n${text}`);
    return;
  }
  await bot.client.sendMessage(target, text, controller.signal);
}

const cooldown = new SharedCooldown();
let successfulDiscoveryCycles = 0;

/**
 * Optional — undefined αν λείπει το PUMPPORTAL_API_KEY (π.χ. τοπικό dev, ή πριν να
 * ρυθμιστεί σε ένα deploy). Κάθε σημείο που το χρησιμοποιεί (walletActivity,
 * exitResolver) το δέχεται ως optional παράμετρο και απλά δεν κάνει τίποτα realtime αν
 * λείπει — καθαρό polling fallback, καμία αλλαγή συμπεριφοράς.
 */
const pumpportalApiKey = config.pumpportalApiKey();
// `let`, όχι `const` — το onTradeEvent callback χρειάζεται να αναφέρεται στο ίδιο το
// realtimeConnection (για unsubscribe μετά από κλείσιμο), αλλά δημιουργείται μέσα στην
// ίδια του τη δήλωση. Δουλεύει σωστά χάρη σε closure: το callback καλείται ΜΟΝΟ αργότερα
// (όταν έρθει πραγματικό event), μέχρι τότε η ανάθεση θα έχει ήδη ολοκληρωθεί.
let realtimeConnection: PumpPortalConnection | undefined;
realtimeConnection = pumpportalApiKey
  ? new PumpPortalConnection({
      apiKey: pumpportalApiKey,
      onTradeEvent: (event) => {
        if (!realtimeConnection) return;
        // ΚΡΙΣΙΜΟ: fire-and-forget με explicit .catch — ένα ασύλληπτο rejection εδώ θα
        // ρίξει ΟΛΟΚΛΗΡΟ το process (ίδιο μάθημα με το readyState crash σήμερα). Ένα
        // σφάλμα σε ΕΝΑ event δεν πρέπει ποτέ να σταματήσει τα υπόλοιπα — το periodic
        // exit-resolver παραμένει δίχτυ ασφαλείας για ό,τι χάσει ένα τέτοιο σφάλμα.
        // Το notify() είναι ΜΕΣΑ στην ίδια .then() (όχι ξεχωριστό await μετά) ώστε ένα
        // πρόβλημα στην αποστολή Telegram να πιάνεται ΚΙ ΑΥΤΟ από το ίδιο .catch.
        //
        // Entry και exit είναι ΔΥΟ ανεξάρτητες αλυσίδες, ΟΧΙ μία μετά την άλλη — ένα
        // πρόβλημα στη μία δεν πρέπει ποτέ να εμποδίσει την άλλη (π.χ. ένα trade που
        // μόλις άνοιξε στο ΙΔΙΟ token με ένα trade που κλείνει, και τα δύο πρέπει να
        // προχωρήσουν ανεξάρτητα).
        handleRealtimeTradeEvent(event, realtimeConnection)
          .then(async (closedResults) => {
            for (const r of closedResults) {
              const outcome = r.pnlPct > 0 ? '🟢' : '🔴';
              await notify(
                `⚡ ${outcome} ${r.exitReason} μέσω realtime — ${short(r.tokenAddress)} ` +
                  `pnl ${formatPercent(r.pnlPct, true)} — δες /trades`,
              );
            }
          })
          .catch((error) => {
            console.error(
              `[realtime] σφάλμα στο exit handler: ${error instanceof Error ? error.message : String(error)}`,
            );
          });

        handleRealtimeEntryEvent(event, realtimeConnection)
          .then(async (entry) => {
            if (entry === null) return;
            const walletLabel = entry.walletName ?? short(entry.walletAddress);
            await notify(
              `⚡🎯 νέο trade (realtime) — ${short(entry.tokenAddress)} | wallet ${walletLabel} ` +
                `| entry ${entry.entryPrice.toPrecision(4)} — δες /trades`,
            );
          })
          .catch((error) => {
            console.error(
              `[realtime] σφάλμα στο entry handler: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      },
      log: (message) => console.log(message),
    })
  : undefined;

if (realtimeConnection) {
  realtimeConnection.connect();
  const openTargets = await listOpenTradesWithWallet();
  subscribeOpenTrades(realtimeConnection, openTargets);
  const activeWallets = await listActiveWallets();
  subscribeAllActiveWallets(
    realtimeConnection,
    activeWallets.map((w) => w.address),
  );
  console.log(
    `[main] realtime: συνδρομή σε ${openTargets.length} ήδη ανοιχτά trades και ` +
      `${activeWallets.length} ενεργά wallets μετά το startup`,
  );
} else {
  console.log('[main] realtime: PUMPPORTAL_API_KEY λείπει — μόνο polling, καμία websocket σύνδεση');
}

const loops: LoopDefinition[] = [
  {
    name: 'discovery',
    intervalMs: DISCOVERY_INTERVAL_MS,
    initialDelayMs: DISCOVERY_INITIAL_DELAY_MS,
    retryBackoffMs: DISCOVERY_RETRY_BACKOFF_MS,
    run: async () => {
      const result = await runDiscoveryCycle();
      successfulDiscoveryCycles += 1;
      if (successfulDiscoveryCycles % 10 === 0) {
        console.log(
          `[discovery] cycles=${successfulDiscoveryCycles} gated=${result.gatedCandidates} ` +
            `sampled=${result.sampledCandidates} (pass=${result.sampledPassed} ` +
            `fail=${result.sampledFailed}) rows=${result.rowsWritten}`,
        );
      }
    },
  },
  {
    name: 'wallet-scoring',
    intervalMs: WALLET_SCORING_INTERVAL_MS,
    initialDelayMs: WALLET_SCORING_INITIAL_DELAY_MS,
    retryBackoffMs: WALLET_SCORING_RETRY_BACKOFF_MS,
    run: async () => {
      const result = await runWalletScoringCycle();
      if (result.walletsScored === 0 && result.failures === 0) return;
      console.log(
        `[wallet-scoring] scored=${result.walletsScored} failures=${result.failures} ` +
          `alerts=${result.alerts.length}`,
      );
      for (const alert of result.alerts) await notify(alert);
    },
  },
  {
    name: 'wallet-discovery',
    intervalMs: WALLET_DISCOVERY_INTERVAL_MS,
    initialDelayMs: WALLET_DISCOVERY_INITIAL_DELAY_MS,
    exclusive: true,
    // Αυξανόμενο retry αντί για σταθερό 60s — βλ. intervals.ts για το σκεπτικό.
    retryBackoffMs: WALLET_DISCOVERY_RETRY_BACKOFF_MS,
    run: async () => {
      const result = await runWalletDiscoveryCycle({ realtimeConnection });
      console.log(
        `[wallet-discovery] tokens=${result.tokensScanned} candidates=${result.uniqueCandidates} ` +
          `discovered=${result.discovered} belowThreshold=${result.belowThreshold} ` +
          `alreadyKnown=${result.alreadyKnown} failures=${result.failures}`,
      );
      if (result.discovered > 0) {
        await notify(`🔎 ${result.discovered} νέο(α) smart_money wallet(s) προστέθηκαν στη watchlist`);
      }
    },
  },
  {
    name: 'exit-resolver',
    intervalMs: EXIT_RESOLVER_INTERVAL_MS,
    initialDelayMs: EXIT_RESOLVER_INITIAL_DELAY_MS,
    retryBackoffMs: EXIT_RESOLVER_RETRY_BACKOFF_MS,
    run: async () => {
      const result = await runExitResolverCycle(realtimeConnection);
      if (result.openTrades === 0 && result.closed === 0 && result.failures === 0) return;
      console.log(
        `[exit-resolver] open=${result.openTrades} closed=${result.closed} failures=${result.failures}` +
          (result.failureReasons.length > 0
            ? ` reasons=${result.failureReasons.slice(0, 3).join(' | ')}`
            : ''),
      );
      if (result.closed > 0) {
        await notify(`📉 ${result.closed} log_only trade(s) έκλεισαν — δες /trades για λεπτομέρειες`);
      }
    },
  },
  {
    name: 'daily-digest',
    intervalMs: DAILY_DIGEST_INTERVAL_MS,
    // Υπολογίζεται ΤΩΡΑ, στο startup — πόσα ms μέχρι το επόμενο 00:05 τοπική ώρα
    // Αθήνας. Timezone-aware (DST-safe), βλ. util/athensTime.ts. Κάθε redeploy
    // ξαναϋπολογίζει από την αρχή, άρα παραμένει σωστό ακόμα και με συχνά restarts.
    initialDelayMs: msUntilNextAthensTime(0, 5),
    run: async () => {
      const message = await runDailyDigestCycle();
      await notify(message);
    },
  },
];

console.log(
  `[main] starting ${loops.length} collector loop(s) + telegram bot` +
    (config.automatedTradesAllowed() ? ' — ⚠️ AUTOMATED TRADES ENABLED' : ' — trading disabled'),
);

try {
  await Promise.all([runBot(bot), runScheduler({ loops, cooldown, signal: controller.signal })]);
} finally {
  await closePool();
  console.log('[main] stopped');
}
