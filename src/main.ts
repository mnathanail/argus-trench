import { runDiscoveryCycle } from './collectors/discovery.js';
import {
  DISCOVERY_INTERVAL_MS,
  WALLET_ACTIVITY_INTERVAL_MS,
  WALLET_DISCOVERY_INTERVAL_MS,
  WALLET_SCORING_INTERVAL_MS,
} from './collectors/intervals.js';
import { runWalletScoringCycle } from './collectors/scoring.js';
import { runWalletActivityCycle } from './collectors/walletActivity.js';
import { runWalletDiscoveryCycle } from './collectors/walletDiscovery.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { logicVersion } from './decision/gateConfig.js';
import { runScheduler, SharedCooldown, type LoopDefinition } from './scheduler.js';
import { createBotFromEnv, runBot } from './telegram/bot.js';

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

const loops: LoopDefinition[] = [
  {
    name: 'discovery',
    intervalMs: DISCOVERY_INTERVAL_MS,
    run: async () => {
      const result = await runDiscoveryCycle();
      console.log(
        `[discovery] gated=${result.gatedCandidates} sampled=${result.sampledCandidates} ` +
          `(pass=${result.sampledPassed} fail=${result.sampledFailed}) rows=${result.rowsWritten}`,
      );
    },
  },
  {
    name: 'wallet-activity',
    intervalMs: WALLET_ACTIVITY_INTERVAL_MS,
    run: async () => {
      const result = await runWalletActivityCycle();
      if (result.walletsPolled === 0) return;
      console.log(
        `[wallet-activity] wallets=${result.walletsPolled} newBuys=${result.newBuys} ` +
          `signals=${result.signalsRecorded}`,
      );
      if (result.signalsRecorded > 0) {
        await notify(`🎯 ${result.signalsRecorded} signal(s) καταγράφηκαν (Φάση 1: χωρίς trade)`);
      }
    },
  },
  {
    name: 'wallet-scoring',
    intervalMs: WALLET_SCORING_INTERVAL_MS,
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
    run: async () => {
      const result = await runWalletDiscoveryCycle();
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
