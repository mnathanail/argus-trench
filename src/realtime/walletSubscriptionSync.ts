import type { WatchlistWallet } from '../db/repositories/watchlistWallets.js';
import { MIRROR_ENABLED } from '../mirror/mirrorConfig.js';

/**
 * 2026-10-04 (ρητή απόφαση χρήστη, μετά από 4 ώρες με κομμένες συνδρομές PumpPortal): το
 * PumpPortal χρεώνει 0.01 SOL / 10k trades που μας στέλνει, και με ~850 συνδρομημένα
 * wallets (μαζί bots με χιλιάδες συναλλαγές/μέρα) το wallet του API key άδειαζε.
 *
 * 1. Wallets που κρατάνε θέσεις κατά μέσο όρο < 60″ ΔΕΝ μπαίνουν στο realtime feed ούτε
 *    δίνουν σήμα: είναι bots που βγαίνουν πριν προλάβουμε να μπούμε (αντιγράφοντάς τα
 *    γινόμαστε η ρευστότητα της εξόδου τους), και φέρνουν το μεγαλύτερο κόστος.
 * 2. Οι συνδρομές συγχρονίζονται περιοδικά με τη βάση: πριν, ένα wallet που
 *    απενεργοποιούσε το scoring (ή το /unwatch) έμενε συνδρομημένο ως το επόμενο restart.
 */
export const BOT_MAX_AVG_HOLDING_SEC = 60;

export type SignalWalletInput = Pick<WatchlistWallet, 'copyMode'> & { avgHoldingSec?: number | null };

/** Mirror wallets πάντα όσο τρέχει το mirror route (MIRROR_ENABLED· σε παύση από 2026-10-06 →
 * ποτέ). Άγνωστος χρόνος κράτησης = μένει. */
export function isRealtimeSignalWallet(wallet: SignalWalletInput, mirrorEnabled: boolean = MIRROR_ENABLED): boolean {
  if (wallet.copyMode === 'mirror') return mirrorEnabled;
  const hold = wallet.avgHoldingSec;
  return hold === null || hold === undefined || !(hold < BOT_MAX_AVG_HOLDING_SEC);
}

export interface WalletSubscriptionPlan {
  add: string[];
  remove: string[];
}

/** Τι λείπει και τι περισσεύει — καθαρή συνάρτηση, για tests. */
export function planWalletSubscriptions(current: Iterable<string>, desired: Iterable<string>): WalletSubscriptionPlan {
  const cur = new Set(current);
  const want = new Set(desired);
  return {
    add: [...want].filter((a) => !cur.has(a)),
    remove: [...cur].filter((a) => !want.has(a)),
  };
}

/** Τα wallets που ΠΡΕΠΕΙ να είναι συνδρομημένα: ενεργά μη-bot (μαζί τα mirror) + όσα έχουν
 * ανοιχτό trade (χρειάζονται για το exit/σκιές ακόμα κι αν απενεργοποιήθηκαν). */
export function desiredWalletSubscriptions(
  activeWallets: readonly (SignalWalletInput & { address: string })[],
  openTradeWallets: readonly (string | null)[],
  mirrorEnabled: boolean = MIRROR_ENABLED,
): string[] {
  const out = new Set<string>();
  for (const w of activeWallets) if (isRealtimeSignalWallet(w, mirrorEnabled)) out.add(w.address);
  for (const a of openTradeWallets) if (a !== null) out.add(a);
  return [...out];
}
