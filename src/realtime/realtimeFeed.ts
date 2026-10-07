/**
 * 2026-10-07 — ό,τι χρειάζεται το realtime pipeline από μια πηγή τιμών/σημάτων. Το υλοποιούν
 * το `PumpPortalConnection` (ιστορικά) και το `HeliusPriceFeed` (από 2026-10-07 η default
 * πηγή — ο χρήστης δεν κάνει άλλο top-up στο PumpPortal).
 */
export interface RealtimeFeed {
  connect(): void;
  close(): void;
  subscribeWallet(address: string): void;
  unsubscribeWallet(address: string): void;
  subscribeToken(mint: string): void;
  unsubscribeToken(mint: string): void;
  walletSubscriptions(): string[];
}
