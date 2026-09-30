import { listWalletsWithOpenMirrorPositions } from '../db/repositories/mirror.js';
import { listMirrorWallets } from '../db/repositories/watchlistWallets.js';
import { HeliusLogsListener } from '../solana/heliusLogsListener.js';
import { getParsedTransactionWithRetry, heliusRpcUrl, heliusWsUrl, type ParsedTransaction } from '../solana/heliusRpc.js';
import type { PumpPortalTradeEvent } from '../realtime/pumpportalEvents.js';
import { parseWalletTrade } from './heliusTrade.js';
import { handleMirrorEvent, type MirrorOutcome } from './mirrorHandler.js';

/**
 * MIRROR — γρήγορη πηγή (2026-09-30). Το PumpPortal δεν στέλνει ΚΑΝΕΝΑ trade του chriskogias
 * (4/4 events ήρθαν από το GMGN poller, που βλέπει με ~15″+ καθυστέρηση). Εδώ: Solana
 * logsSubscribe μέσω Helius → getTransaction → parseWalletTrade → ίδιος handleMirrorEvent
 * (source 'helius'). Το signature κάνει dedupe με τις άλλες δύο πηγές.
 *
 * detail_json: lag_sec (δευτερόλεπτα από το block της συναλλαγής ως τη στιγμή που την
 * επεξεργαστήκαμε — αυτό θα ήταν το live delay), program, sol_source, wallet_sol, pool_sol.
 */

const WALLET_REFRESH_MS = 60_000;

export interface HeliusMirrorSourceDeps {
  fetchTx: (signature: string) => Promise<ParsedTransaction | null>;
  handle: (event: PumpPortalTradeEvent, extraDetail: Record<string, unknown>) => Promise<MirrorOutcome | null>;
  onOutcome: (outcome: MirrorOutcome) => Promise<void>;
  nowMs: () => number;
  log: (line: string) => void;
}

/** Μία υπογραφή → (ίσως) ένα mirror outcome. Εξαγόμενο για tests. */
export async function processHeliusSignature(wallet: string, signature: string, deps: HeliusMirrorSourceDeps): Promise<void> {
  const tx = await deps.fetchTx(signature);
  if (tx === null) {
    deps.log(`[mirror-helius] ${signature.slice(0, 8)}: η συναλλαγή δεν βρέθηκε (getTransaction null)`);
    return;
  }
  const parsed = parseWalletTrade(tx, wallet);
  if (!parsed.ok) {
    // no_token_change / wallet_not_in_tx = απλές μεταφορές κλπ. — θόρυβος, όχι log.
    if (parsed.reason === 'multi_token' || parsed.reason === 'no_sol_change') {
      deps.log(`[mirror-helius] ${signature.slice(0, 8)} ${wallet.slice(0, 8)}: αγνοήθηκε (${parsed.reason})`);
    }
    return;
  }
  const lagSec = parsed.blockTime === null ? null : Math.round((deps.nowMs() / 1000 - parsed.blockTime) * 10) / 10;
  deps.log(
    `[mirror-helius] ${parsed.event.txType} ${parsed.event.mint.slice(0, 8)} ${wallet.slice(0, 8)} ` +
      `sol=${parsed.event.solAmount.toFixed(4)} (${parsed.solSource}) program=${parsed.program} lag=${lagSec ?? '?'}s`,
  );
  const outcome = await deps.handle(parsed.event, {
    lag_sec: lagSec,
    program: parsed.program,
    sol_source: parsed.solSource,
    wallet_sol: parsed.walletSol,
    pool_sol: parsed.poolSol,
  });
  if (outcome !== null) await deps.onOutcome(outcome);
}

async function currentWallets(): Promise<string[]> {
  const mirror = (await listMirrorWallets()).map((w) => w.address);
  const withOpen = await listWalletsWithOpenMirrorPositions();
  return [...new Set([...mirror, ...withOpen])];
}

export interface HeliusMirrorSource {
  addWallet: (address: string) => void;
  close: () => void;
}

export async function startHeliusMirrorSource(
  apiKey: string,
  onOutcome: (outcome: MirrorOutcome) => Promise<void>,
): Promise<HeliusMirrorSource> {
  const rpcUrl = heliusRpcUrl(apiKey);
  const deps: HeliusMirrorSourceDeps = {
    fetchTx: (sig) => getParsedTransactionWithRetry(rpcUrl, sig),
    handle: (event, extra) => handleMirrorEvent(event, 'helius', extra),
    onOutcome,
    nowMs: () => Date.now(),
    log: (line) => console.log(line),
  };
  const listener = new HeliusLogsListener({
    wsUrl: heliusWsUrl(apiKey),
    onSignature: (wallet, signature) => {
      processHeliusSignature(wallet, signature, deps).catch((error) => {
        console.error(`[mirror-helius] ${signature.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });
  listener.setWallets(await currentWallets());
  listener.connect();
  const refresh = setInterval(() => {
    currentWallets()
      .then((wallets) => listener.setWallets(wallets))
      .catch((error) => console.error(`[mirror-helius] refresh wallets: ${error instanceof Error ? error.message : String(error)}`));
  }, WALLET_REFRESH_MS);
  refresh.unref();
  return {
    addWallet: (address) => listener.addWallet(address),
    close: () => {
      clearInterval(refresh);
      listener.close();
    },
  };
}
