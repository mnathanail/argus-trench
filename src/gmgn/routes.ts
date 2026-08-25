/**
 * Route weights, αντιγραμμένα από τις ενότητες "Rate Limit Handling" των skill docs στο
 * `.agents/skills`. Ο limiter είναι κοινός: `rate=20`, `capacity=20` σε ΟΛΑ τα
 * routes, άρα ένα βαρύ poll στο ένα endpoint κλέβει budget από τα άλλα.
 *
 * Πρακτικές συνέπειες για το σχέδιό μας:
 * - `market trenches` = 3 × 2 calls/κύκλο (gated + ungated) = 6.
 * - `portfolio activity` = 3 **ανά wallet**. 50 watchlist wallets = 150 weight, δηλαδή
 *   7.5s στο πλήρες rate. Αυτό είναι το ακριβό κομμάτι του layer 3.
 * - `portfolio profits` = 3 για έως **100 wallets μαζί** — γι' αυτό το scoring πάει batch.
 */
export const ROUTE_WEIGHTS = {
  'market kline': 2,
  'market trending': 1,
  'market trenches': 3,
  'market signal': 3,
  'market hot-searches': 3,
  'market search': 1,
  'portfolio info': 1,
  'portfolio holdings': 5,
  'portfolio activity': 3,
  'portfolio stats': 3,
  'portfolio profits': 3,
  'portfolio token-balance': 1,
  'portfolio created-tokens': 2,
  'track follow-tokens': 3,
  'track follow-token-groups': 1,
  'track follow-wallet': 3,
  'track kol': 1,
  'track smartmoney': 1,
} as const;

export type RouteKey = keyof typeof ROUTE_WEIGHTS;

export const LIMITER_CAPACITY = 20;
export const LIMITER_REFILL_PER_SECOND = 20;
