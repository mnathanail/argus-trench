import { countOpenTradesForToken, type OpenTradeSubscriptionTarget } from '../db/repositories/paperTrades.js';
import type { Queryable } from '../db/tx.js';
import type { PumpPortalConnection } from './pumpportalConnection.js';

/** Μόνο ό,τι χρειαζόμαστε από τη σύνδεση — επιτρέπει fake object στα tests χωρίς να
 * χρειάζεται ολόκληρο PumpPortalConnection με πραγματικό socket. */
type SubscribeCapable = Pick<PumpPortalConnection, 'subscribeToken' | 'subscribeWallet'>;
type UnsubscribeCapable = Pick<PumpPortalConnection, 'unsubscribeToken'>;

/**
 * Καλείται μία φορά στο startup — συνδρομές για ΟΛΑ τα ήδη ανοιχτά trades. Χρειάζεται
 * γιατί μια φρέσκια σύνδεση ξεκινάει πάντα με μηδέν subscriptions, ασχέτως τι υπήρχε στη
 * βάση πριν το τελευταίο restart. Καθαρή function — τα δεδομένα (`targets`) έρχονται ήδη
 * fetched από τον caller, ώστε να τεσταρίζεται χωρίς πραγματική DB.
 */
export function subscribeOpenTrades(
  connection: SubscribeCapable,
  targets: readonly OpenTradeSubscriptionTarget[],
): void {
  for (const target of targets) {
    connection.subscribeToken(target.tokenAddress);
    if (target.triggerWalletAddress !== null) {
      connection.subscribeWallet(target.triggerWalletAddress);
    }
  }
}

/** Καλείται αμέσως μετά το άνοιγμα ενός νέου trade (walletActivity.ts). */
export function subscribeForNewTrade(
  connection: SubscribeCapable,
  tokenAddress: string,
  triggerWalletAddress: string | null,
): void {
  connection.subscribeToken(tokenAddress);
  // Wallets ΔΕΝ κάνουν ποτέ unsubscribe εδώ (βλ. unsubscribeIfNoLongerNeeded) — είναι
  // μικρό, φραγμένο σύνολο (~100 στη watchlist μας), ασφαλές να μείνουν
  // συνδρομημένα για όλη τη διάρκεια του process. Το subscribeWallet είναι ήδη
  // idempotent, άρα αυτό δεν κοστίζει τίποτα αν το ίδιο wallet εμφανιστεί ξανά.
  if (triggerWalletAddress !== null) {
    connection.subscribeWallet(triggerWalletAddress);
  }
}

/**
 * Καλείται αμέσως μετά το κλείσιμο ενός trade (exitResolver.ts, ή ο event-driven
 * exit handler). Unsubscribe ΜΟΝΟ αν κανένα ΑΛΛΟ ανοιχτό trade δεν χρειάζεται ακόμα το
 * ίδιο token — δύο ξεχωριστά trades στο ίδιο token θα ήταν σπάνιο αλλά όχι αδύνατο.
 *
 * `conn` — ΠΕΡΑΣΕ το ΙΔΙΟ transaction client αν το close που μόλις έγινε ήταν μέρος
 * transaction (π.χ. ο realtime handler): χωρίς αυτό, το μέτρημα θα έτρεχε σε ΑΛΛΗ
 * σύνδεση που δε βλέπει ακόμα το δικό μας uncommitted close — θα μετρούσε λάθος το
 * trade που μόλις κλείσαμε σαν ακόμα ανοιχτό, και δε θα έκανε ποτέ unsubscribe.
 * Επιβεβαιωμένο πραγματικό εύρημα πλήρους ελέγχου 2026-09-09.
 */
export async function unsubscribeIfNoLongerNeeded(
  connection: UnsubscribeCapable,
  tokenAddress: string,
  conn?: Queryable,
): Promise<void> {
  const stillNeeded = await countOpenTradesForToken(tokenAddress, conn);
  if (stillNeeded === 0) {
    connection.unsubscribeToken(tokenAddress);
  }
}
