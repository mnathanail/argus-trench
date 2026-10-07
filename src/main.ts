import { runDiscoveryCycle } from './collectors/discovery.js';
import { runExitResolverCycle } from './collectors/exitResolver.js';
import { runLiveStrategyReconcilerCycle } from './collectors/liveStrategyReconciler.js';
import { runLiveTradeWatchdogCycle } from './collectors/liveTradeWatchdog.js';
import { runDailyDigestCycle } from './collectors/dailyDigest.js';
import {
  DISCOVERY_INTERVAL_MS,
  DISCOVERY_INITIAL_DELAY_MS,
  DISCOVERY_RETRY_BACKOFF_MS,
  DISCOVERY_NEW_CREATION_INTERVAL_MS,
  DISCOVERY_NEW_CREATION_INITIAL_DELAY_MS,
  DISCOVERY_NEW_CREATION_RETRY_BACKOFF_MS,
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
  LIVE_STRATEGY_RECONCILER_INTERVAL_MS,
  LIVE_STRATEGY_RECONCILER_INITIAL_DELAY_MS,
  LIVE_STRATEGY_RECONCILER_RETRY_BACKOFF_MS,
  LIVE_TRADE_WATCHDOG_INTERVAL_MS,
  LIVE_TRADE_WATCHDOG_INITIAL_DELAY_MS,
  LIVE_TRADE_WATCHDOG_RETRY_BACKOFF_MS,
} from './collectors/intervals.js';
import { runWalletScoringCycle } from './collectors/scoring.js';
import { runWalletDiscoveryCycle } from './collectors/walletDiscovery.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { listActiveWallets } from './db/repositories/watchlistWallets.js';
import { listOpenTradesWithWallet } from './db/repositories/paperTrades.js';
import { logicVersion } from './decision/gateConfig.js';
import { LIVE_KILL_SWITCH_CONSEC_LOSSES } from './decision/paperTradingConfig.js';
import { msUntilNextAthensTime } from './util/athensTime.js';
import { PumpPortalConnection } from './realtime/pumpportalConnection.js';
import { HeliusPriceFeed } from './realtime/heliusPriceFeed.js';
import type { RealtimeFeed } from './realtime/realtimeFeed.js';
import { subscribeAllActiveWallets, subscribeOpenTrades, unsubscribeIfNoLongerNeeded } from './realtime/subscriptionManager.js';
import { desiredWalletSubscriptions, isRealtimeSignalWallet, planWalletSubscriptions } from './realtime/walletSubscriptionSync.js';
import { handleRealtimeTradeEvent } from './realtime/realtimeExitHandler.js';
import { handleRealtimeEntryEvent } from './realtime/realtimeEntryHandler.js';
import { handleMirrorEvent, setMirrorSubscriber, type MirrorOutcome } from './mirror/mirrorHandler.js';
import { MIRROR_POLL_INTERVAL_MS, runMirrorPollCycle } from './mirror/mirrorPoller.js';
import { startHeliusMirrorSource } from './mirror/heliusMirrorSource.js';
import { MIRROR_ENABLED } from './mirror/mirrorConfig.js';
import { SignatureDedupe, startHeliusSignalSource } from './realtime/heliusSignalSource.js';
import { WALLET_DISCOVERY_ENABLED } from './collectors/walletDiscovery.js';
import type { PumpPortalTradeEvent } from './realtime/pumpportalEvents.js';
import { expireMirrorShadows, handleMirrorShadowTick, hasActiveShadow, refreshMirrorShadows } from './mirror/mirrorShadow.js';
import { runScheduler, SharedCooldown, type LoopDefinition } from './scheduler.js';
import { createBotFromEnv, runBot } from './telegram/bot.js';
import { formatPercent, short } from './telegram/commands.js';
import { activateTradeProxyIfConfigured } from './util/tradeProxy.js';

activateTradeProxyIfConfigured(); // ΠΡΩΤΟ, πριν από οτιδήποτε άλλο — βλ. σχόλιο στο module.

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
let successfulDiscoveryNewCreationCycles = 0;

/**
 * Optional — undefined αν λείπει το PUMPPORTAL_API_KEY (π.χ. τοπικό dev, ή πριν να
 * ρυθμιστεί σε ένα deploy). Κάθε σημείο που το χρησιμοποιεί (walletActivity,
 * exitResolver) το δέχεται ως optional παράμετρο και απλά δεν κάνει τίποτα realtime αν
 * λείπει — καθαρό polling fallback, καμία αλλαγή συμπεριφοράς.
 */
const pumpportalApiKey = config.pumpportalApiKey();
/** 2026-09-30 — MIRROR: ειδοποίηση μόνο σε άνοιγμα/κλείσιμο θέσης (και από τις δύο πηγές). */
async function notifyMirrorOutcome(m: MirrorOutcome | null): Promise<void> {
  if (m === null) return;
  if (m.kind === 'opened') {
    // Σκιά trailing: τιμές του token σε πραγματικό χρόνο (PumpPortal token ticks).
    realtimeConnection?.subscribeToken(m.token);
    await refreshMirrorShadows().catch((error) => console.error(`[mirror-shadow] refresh: ${String(error)}`));
    await notify(`🪞 MIRROR paper — άνοιξε ${short(m.token)} ακολουθώντας ${m.walletName ?? short(m.wallet)} (${m.ourSol} SOL)`);
  } else if (m.kind === 'closed') {
    const emoji = m.pnlSol > 0 ? '🟢' : '🔴';
    await notify(
      `🪞 ${emoji} MIRROR paper — έκλεισε ${short(m.token)} (${m.walletName ?? short(m.wallet)}): ` +
        `${m.pnlPct === null ? '—' : formatPercent(m.pnlPct, true)}, ${m.pnlSol >= 0 ? '+' : ''}${m.pnlSol.toFixed(4)} SOL ` +
        `· αγορές ${m.buyCount}, πωλήσεις ${m.sellCount}`,
    );
  }
}
// `let`, όχι `const` — το onTradeEvent callback χρειάζεται να αναφέρεται στο ίδιο το
// realtimeConnection (για unsubscribe μετά από κλείσιμο), αλλά δημιουργείται μέσα στην
// ίδια του τη δήλωση. Δουλεύει σωστά χάρη σε closure: το callback καλείται ΜΟΝΟ αργότερα
// (όταν έρθει πραγματικό event), μέχρι τότε η ανάθεση θα έχει ήδη ολοκληρωθεί.
/**
 * Entry path για ένα σήμα αγοράς (PumpPortal ή Helius). 2026-10-07: ό,τι φτάσει πρώτο από τις
 * δύο πηγές κερδίζει — `signalDedupe` (η ίδια υπογραφή δεν περνάει δεύτερη φορά).
 */
const signalDedupe = new SignatureDedupe();
function runEntryForSignal(event: PumpPortalTradeEvent, connection: RealtimeFeed): void {
  if (event.txType !== 'buy') return;
  if (!signalDedupe.claim(event.signature)) return;
  handleRealtimeEntryEvent(event, connection)
    .then(async (entry) => {
      if (entry === null) return;
      if (entry.experiment.length > 0) {
        console.log(`[realtime-entry] paper πείραμα [${entry.experiment.join(',')}] ${short(entry.tokenAddress)}`);
        return;
      }
      // ΔΙΟΡΘΩΣΗ 2026-09-18 (πραγματικό εύρημα): πριν, το kill-switch ενεργοποιούνταν
      // σιωπηλά μέσα στο checkLiveRiskGate — ο χρήστης το μάθαινε μόνο από το επόμενο
      // daily digest (ή ένα ήδη-μπαγιάτικο digest, ακριβώς αυτό που τον μπέρδεψε
      // 2026-09-17 βράδυ). Proactive alert ΑΜΕΣΩΣ, μία φορά (killSwitchJustTriggered
      // είναι true ΜΟΝΟ την πρώτη φορά που ενεργοποιείται, βλ. liveRiskGate.ts).
      if (entry.killSwitchJustTriggered) {
        await notify(
          `🔴 Live trading kill-switch ΕΝΕΡΓΟΠΟΙΗΘΗΚΕ ΤΩΡΑ — ${LIVE_KILL_SWITCH_CONSEC_LOSSES} συνεχόμενες ζημιές.\n` +
            `Κανένα νέο live trade μέχρι /resume_live. Δες /trades για λεπτομέρειες.`,
        );
      }
      const walletLabel = entry.walletName ?? short(entry.walletAddress);
      const modeLabel =
        entry.mode === 'live'
          ? '💰 LIVE'
          : entry.graduated
            ? '📝 paper (graduated)'
            : entry.onDemandGate
              ? '📝 paper (on-demand gate)'
              : '📝 paper';
      await notify(
        `⚡🎯 νέο trade (${event.signalSource ?? 'realtime'}) ${modeLabel} — ${short(entry.tokenAddress)} | wallet ${walletLabel} ` +
          `| entry ${entry.entryPrice.toPrecision(4)} — δες /trades`,
      );
    })
    .catch((error) => {
      console.error(
        `[realtime] σφάλμα στο entry handler: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

/**
 * Ένα price tick (trade στο token ή, από 2026-10-07, αλλαγή λογαριασμού του pool μέσω Helius)
 * → έξοδοι ανοιχτών θέσεων (+ σκιές mirror όσο είναι ενεργό). Entry και exit είναι ΔΥΟ
 * ανεξάρτητες αλυσίδες· κάθε σφάλμα πιάνεται εδώ, δεν ρίχνει ποτέ το process.
 */
function onPriceTick(event: PumpPortalTradeEvent, feed: RealtimeFeed): void {
  handleRealtimeTradeEvent(event, feed)
    .then(async (outcomes) => {
      for (const o of outcomes) {
        if (o.type === 'closed') {
          // 2026-10-06: τα trades του paper πειράματος μόνο στη βάση (θα ήταν δεκάδες/μέρα).
          if (o.experiment === true) continue;
          const outcomeEmoji = o.pnlPct > 0 ? '🟢' : '🔴';
          await notify(
            `⚡ ${outcomeEmoji} ${o.exitReason} μέσω realtime — ${short(o.tokenAddress)} ` +
              `pnl ${formatPercent(o.pnlPct, true)} — δες /trades`,
          );
        } else {
          // Πραγματική πώληση απέτυχε — η θέση παραμένει ανοιχτή, πραγματικό
          // κεφάλαιο ακόμα εκτεθειμένο. Ρητό αίτημα χρήστη 2026-09-15: ξεκάθαρο
          // μήνυμα (πλήρες token address, όχι μόνο short — χρειάζεται για
          // χειροκίνητη προσπάθεια), καμία αυτόματη επανάληψη.
          await notify(
            `🚨 ΠΡΑΓΜΑΤΙΚΗ πώληση ΑΠΕΤΥΧΕ — χρειάζεται χειροκίνητη προσοχή\n` +
              `Token: ${o.tokenAddress}\n` +
              `Trade ID: ${o.tradeId}\n` +
              `Σφάλμα: ${o.errorMessage}\n` +
              `Χειροκίνητη προσπάθεια: railway run npm run close-manual-exit -- ${o.tradeId}`,
          );
        }
      }
    })
    .catch((error) => {
      console.error(
        `[realtime] σφάλμα στο exit handler: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

  // 2026-09-30 — MIRROR route: ανεξάρτητη τρίτη αλυσίδα (paper). Ειδοποίηση μόνο σε
  // άνοιγμα/κλείσιμο θέσης — οι ενδιάμεσες αγορές/πωλήσεις γράφονται στο mirror_events.
  // Σκιά trailing των mirror θέσεων — μόνο καταγραφή, ποτέ πραγματική έξοδος.
  // 2026-10-06 (ρητή απόφαση χρήστη): mirror σε παύση — βλ. MIRROR_ENABLED.
  if (MIRROR_ENABLED) handleMirrorShadowTick(event)
    .then(async (closed) => {
      for (const c of closed) {
        console.log(
          `[mirror-shadow] #${c.positionId} ${c.token.slice(0, 8)} έξοδος σκιάς: ${c.reason} ` +
            `${c.pnlPct === null ? '' : `${(c.pnlPct * 100).toFixed(1)}%`}`,
        );
        if (!hasActiveShadow(c.token) ) await unsubscribeIfNoLongerNeeded(feed, c.token);
      }
    })
    .catch((error) => {
      console.error(`[mirror-shadow] σφάλμα: ${error instanceof Error ? error.message : String(error)}`);
    });

}

let realtimeConnection: RealtimeFeed | undefined;
// Rate limit για το PumpPortal low-balance alert — το connection ξαναδοκιμάζει κάθε 5
// λεπτά, δεν θέλουμε Telegram μήνυμα σε κάθε προσπάθεια.
const PUMPPORTAL_BALANCE_ALERT_INTERVAL_MS = 60 * 60_000;
let lastPumpportalBalanceAlertAt = 0;
// 2026-10-07 (ρητή απόφαση χρήστη: «δεν κάνω άλλο top-up στο PumpPortal»): με HELIUS_API_KEY
// οι τιμές για τις εξόδους έρχονται από το Helius (accountSubscribe, δωρεάν) και τα σήματα από
// το heliusSignalSource. Το PumpPortal μόνο αν REALTIME_FEED=pumpportal.
const heliusApiKey = config.heliusApiKey();
const useHeliusFeed = heliusApiKey !== undefined && process.env.REALTIME_FEED !== 'pumpportal';
realtimeConnection = useHeliusFeed
  ? new HeliusPriceFeed({
      apiKey: heliusApiKey,
      onTick: (event) => {
        if (realtimeConnection) onPriceTick(event, realtimeConnection);
      },
    })
  : pumpportalApiKey
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
        onPriceTick(event, realtimeConnection);

        if (MIRROR_ENABLED) handleMirrorEvent(event, 'pumpportal')
          .then(notifyMirrorOutcome)
          .catch((error) => {
            console.error(`[mirror] σφάλμα: ${error instanceof Error ? error.message : String(error)}`);
          });

        runEntryForSignal(event, realtimeConnection);
      },
      log: (message) => console.log(message),
      onInsufficientBalance: () => {
        const now = Date.now();
        if (now - lastPumpportalBalanceAlertAt < PUMPPORTAL_BALANCE_ALERT_INTERVAL_MS) return;
        lastPumpportalBalanceAlertAt = now;
        notify(
          `🚨 PumpPortal: οι συνδρομές απορρίφθηκαν — το wallet του PUMPPORTAL_API_KEY έχει κάτω από 0.02 SOL.\n` +
            `Χωρίς αυτό ΔΕΝ γίνονται live entries ούτε γρήγορα exits (stop-loss/trailing).\n` +
            `Το PumpPortal χρεώνει 0.01 SOL ανά 10.000 trades — φόρτωσε το wallet (π.χ. 0.1 SOL). ` +
            `Νέα προσπάθεια αυτόματα κάθε 5 λεπτά, δεν χρειάζεται restart.`,
        ).catch((error) => {
          console.error(`[realtime] αποτυχία αποστολής PumpPortal balance alert: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
    })
  : undefined;

// 2026-09-30 — MIRROR γρήγορη πηγή (Helius logsSubscribe). Μόνο με MIRROR_HELIUS=on.
const heliusMirror =
  MIRROR_ENABLED && heliusApiKey !== undefined && config.mirrorHeliusEnabled()
    ? await startHeliusMirrorSource(heliusApiKey, notifyMirrorOutcome).catch((error) => {
        console.error(`[mirror-helius] δεν ξεκίνησε: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      })
    : undefined;
console.log(
  MIRROR_ENABLED ? '[main] mirror: ενεργό' : '[main] mirror: ΣΕ ΠΑΥΣΗ (MIRROR_ENABLED=false) — καμία πηγή, κανένα tick, δεδομένα ανέγγιχτα',
);
if (MIRROR_ENABLED) console.log(
  `[main] mirror πηγές: pumpportal=${realtimeConnection ? 'ναι' : 'όχι'} gmgn=${heliusMirror ? 'όχι (υπάρχει helius)' : 'ναι'} ` +
    `helius=${heliusMirror ? 'ναι' : heliusApiKey === undefined ? 'όχι (λείπει HELIUS_API_KEY)' : 'όχι (MIRROR_HELIUS≠on)'}`,
);
// Νέο /mirror wallet → συνδρομή αμέσως σε όσες realtime πηγές υπάρχουν.
const connectionForMirror = realtimeConnection;
setMirrorSubscriber((address) => {
  if (!MIRROR_ENABLED) return;
  connectionForMirror?.subscribeWallet(address);
  heliusMirror?.addWallet(address);
});

if (realtimeConnection) {
  realtimeConnection.connect();
  // Σκιές trailing που τρέχουν ακόμα (μετά από restart) → ξανά token ticks.
  const shadowTokens = MIRROR_ENABLED ? await refreshMirrorShadows().catch(() => [] as string[]) : [];
  for (const token of shadowTokens) realtimeConnection.subscribeToken(token);
  const openTargets = await listOpenTradesWithWallet();
  subscribeOpenTrades(realtimeConnection, openTargets);
  const activeWallets = await listActiveWallets();
  // 2026-10-04: χωρίς τα bots (μέσος χρόνος κράτησης < 60″) — βλ. walletSubscriptionSync.ts.
  const signalWallets = activeWallets.filter((w) => isRealtimeSignalWallet(w));
  subscribeAllActiveWallets(
    realtimeConnection,
    signalWallets.map((w) => w.address),
  );
  console.log(
    `[main] realtime: συνδρομή σε ${openTargets.length} ήδη ανοιχτά trades και ` +
      `${signalWallets.length} ενεργά wallets μετά το startup (${activeWallets.length - signalWallets.length} bots εκτός)`,
  );
  console.log(`[main] realtime πηγή τιμών: ${useHeliusFeed ? 'Helius (accountSubscribe)' : 'PumpPortal'}`);
} else {
  console.log('[main] realtime: ούτε HELIUS_API_KEY ούτε PUMPPORTAL_API_KEY — μόνο polling, καμία websocket σύνδεση');
}

// 2026-10-07 — δεύτερη πηγή σημάτων watchlist: Helius (βλ. realtime/heliusSignalSource.ts). Το
// PumpPortal δεν στέλνει τις αγορές όσων αγοράζουν μέσω Axiom/Photon/Padre. Χρειάζεται και το
// PumpPortal connection (token ticks για τις εξόδους).
const heliusSignals =
  heliusApiKey !== undefined && config.heliusSignalsEnabled() && realtimeConnection !== undefined
    ? await startHeliusSignalSource({
        apiKey: heliusApiKey,
        dedupe: signalDedupe,
        onEvent: (event) => {
          if (realtimeConnection) runEntryForSignal(event, realtimeConnection);
        },
        onBudgetExhausted: (u) => {
          notify(
            `⚠️ Helius: το ημερήσιο όριο credits (${u.used}/${u.limit}) τελείωσε — μέχρι τα μεσάνυχτα UTC ` +
              `χωρίς νέα σήματα (οι έξοδοι συνεχίζουν). (HELIUS_DAILY_CREDIT_BUDGET)`,
          ).catch((error) => console.error(`[helius-signal] alert: ${String(error)}`));
        },
        dailyCreditBudget: config.heliusDailyCreditBudget(),
        walletDailyFetches: config.heliusWalletDailyFetches(),
      }).catch((error) => {
        console.error(`[helius-signal] δεν ξεκίνησε: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      })
    : undefined;
console.log(
  `[main] σήματα Helius: ${heliusSignals ? `ναι (όριο ${config.heliusDailyCreditBudget()} credits/μέρα, ${config.heliusWalletDailyFetches()}/wallet)` : 'όχι'}`,
);

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
    // Σύσταση 1 (2026-09-23) — δεύτερος, ανεξάρτητος discovery κύκλος για
    // category: 'new_creation', ίδιο σχήμα με το βασικό discovery loop πάνω. Βλ.
    // DISCOVERY_NEW_CREATION_INTERVAL_MS στο intervals.ts για γιατί το interval είναι
    // πιο αργό (5 λεπτά) από το near_completion discovery — ΕΠΙΠΛΕΟΝ load πάνω στο ήδη
    // ευαίσθητο shared rate budget, προστέθηκε ΑΜΕΣΩΣ μετά τη σειρά rate-limit fixes
    // αυτής της εβδομάδας. Αν το πρόβλημα επανεμφανιστεί, αυτό το loop είναι το πρώτο
    // σημείο να ελεγχθεί/απενεργοποιηθεί — αφαίρεση αυτού του entry είναι μηδενικού
    // ρίσκου για τα near_completion/gated_pool/sample_window δεδομένα (βλ. migration
    // 0015: ξεχωριστή στήλη category, όχι ανάμεικτη με το candidate_source).
    name: 'discovery-new-creation',
    intervalMs: DISCOVERY_NEW_CREATION_INTERVAL_MS,
    initialDelayMs: DISCOVERY_NEW_CREATION_INITIAL_DELAY_MS,
    retryBackoffMs: DISCOVERY_NEW_CREATION_RETRY_BACKOFF_MS,
    run: async () => {
      const result = await runDiscoveryCycle({ category: 'new_creation' });
      successfulDiscoveryNewCreationCycles += 1;
      if (successfulDiscoveryNewCreationCycles % 10 === 0) {
        console.log(
          `[discovery-new-creation] cycles=${successfulDiscoveryNewCreationCycles} ` +
            `gated=${result.gatedCandidates} sampled=${result.sampledCandidates} ` +
            `(pass=${result.sampledPassed} fail=${result.sampledFailed}) rows=${result.rowsWritten}`,
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
      // 2026-10-07 (ρητή απόφαση χρήστη): η watchlist κόπηκε στα ~250 καλύτερα για το free plan
      // του Helius — δεν προστίθενται νέα wallets μέχρι να το αλλάξουμε (WALLET_DISCOVERY_ENABLED).
      if (!WALLET_DISCOVERY_ENABLED) return;
      const result = await runWalletDiscoveryCycle({ realtimeConnection });
      console.log(
        `[wallet-discovery] tokens=${result.tokensScanned} traders=${result.tradersSeen} ` +
          `rejected=${JSON.stringify(result.rejected)} candidates=${result.uniqueCandidates} ` +
          `discovered=${result.discovered} belowThreshold=${result.belowThreshold} ` +
          `alreadyKnown=${result.alreadyKnown} failures=${result.failures}`,
      );
      if (result.discovered > 0) {
        await notify(`🔎 ${result.discovered} νέο(α) top_trader wallet(s) προστέθηκαν στη watchlist`);
      }
    },
  },
  // 2026-09-29: το κανάλι 'gmgn-smartmoney' σταμάτησε (ρητή απόφαση χρήστη) — βλ. σχόλιο στο
  // collectors/gmgnSmartMoney.ts. Το holder-risk φίλτρο του τρέχει πλέον στις realtime αγορές.
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
    name: 'live-strategy-reconciler',
    intervalMs: LIVE_STRATEGY_RECONCILER_INTERVAL_MS,
    initialDelayMs: LIVE_STRATEGY_RECONCILER_INITIAL_DELAY_MS,
    retryBackoffMs: LIVE_STRATEGY_RECONCILER_RETRY_BACKOFF_MS,
    run: async () => {
      const result = await runLiveStrategyReconcilerCycle(realtimeConnection);
      if (result.checked === 0 && result.failures === 0) return;
      console.log(
        `[live-strategy-reconciler] checked=${result.checked} closed=${result.closed} ` +
          `fallback=${result.fallbackActivated} failures=${result.failures}`,
      );
      for (const alert of result.alerts) await notify(alert);
    },
  },
  // 2026-10-04 — συνδρομές wallets = βάση (ενεργά μη-bot + mirror + όσα έχουν ανοιχτό trade).
  {
    name: 'realtime-wallet-sync',
    intervalMs: 10 * 60_000,
    initialDelayMs: 5 * 60_000,
    run: async () => {
      if (!realtimeConnection) return;
      const [active, open] = await Promise.all([listActiveWallets(), listOpenTradesWithWallet()]);
      const desired = desiredWalletSubscriptions(active, open.map((t) => t.triggerWalletAddress));
      const plan = planWalletSubscriptions(realtimeConnection.walletSubscriptions(), desired);
      for (const a of plan.add) realtimeConnection.subscribeWallet(a);
      for (const a of plan.remove) realtimeConnection.unsubscribeWallet(a);
      if (plan.add.length > 0 || plan.remove.length > 0) {
        console.log(`[realtime-wallet-sync] +${plan.add.length} −${plan.remove.length} → ${desired.length} wallets`);
      }
    },
  },
  // 2026-09-30 — MIRROR: δεύτερη πηγή από το GMGN για τα mirror wallets (βλ. mirrorPoller.ts).
  {
    name: 'mirror-poll',
    intervalMs: MIRROR_POLL_INTERVAL_MS,
    initialDelayMs: 20_000,
    run: async () => {
      if (!MIRROR_ENABLED) return;
      await expireMirrorShadows().catch((error) => console.error(`[mirror-shadow] expire: ${String(error)}`));
      // 2026-10-04: με ενεργό Helius το GMGN poll έφερνε μόνο duplicates και ήταν η κύρια
      // αιτία των GMGN IP bans (72/170 σε 4 ώρες) — δεν τρέχει πια όσο δουλεύει το Helius.
      if (heliusMirror !== undefined) return;
      const result = await runMirrorPollCycle();
      if (result.newActivities === 0 && result.failures === 0) return;
      const counts = new Map<string, number>();
      for (const o of result.outcomes) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
      console.log(
        `[mirror-poll] wallets=${result.wallets} new=${result.newActivities} ` +
          `outcomes=${JSON.stringify(Object.fromEntries(counts))} failures=${result.failures}`,
      );
      for (const o of result.outcomes) await notifyMirrorOutcome(o);
    },
  },
  {
    name: 'live-trade-watchdog',
    intervalMs: LIVE_TRADE_WATCHDOG_INTERVAL_MS,
    initialDelayMs: LIVE_TRADE_WATCHDOG_INITIAL_DELAY_MS,
    retryBackoffMs: LIVE_TRADE_WATCHDOG_RETRY_BACKOFF_MS,
    run: async () => {
      const result = await runLiveTradeWatchdogCycle();
      if (result.checked === 0 && result.failures === 0) return;
      console.log(
        `[live-trade-watchdog] checked=${result.checked} flagged=${result.flaggedForManualExit} ` +
          `failures=${result.failures}`,
      );
      for (const alert of result.alerts) await notify(alert);
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
