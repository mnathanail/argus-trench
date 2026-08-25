import { runCli, type RunOptions } from './exec.js';
import { GmgnResponseError } from './errors.js';
import {
  expectArray,
  expectObject,
  expectString,
  toNumberOrNull,
  toStringOrNull,
} from './validate.js';

export type TrenchCategory = 'new_creation' | 'near_completion' | 'completed';

/**
 * Τα gate thresholds ως server-side flags. Ονόματα flag ≠ ονόματα field στο response —
 * βλ. `GATE_FIELD_BY_FLAG`. Επιβεβαιωμένα με πραγματικό call: ζητήθηκαν αυτά τα πέντε και
 * κανένα από τα 60 results δεν παραβίασε τα όριά τους.
 */
export interface GateThresholds {
  maxRugRatio?: number;
  maxBundlerRate?: number;
  maxInsiderRatio?: number;
  maxTopHolderRate?: number;
  minSmartDegenCount?: number;
  maxCreatorCreatedOpenRatio?: number;
  maxTwitterRenameCount?: number;
  maxEntrapmentRatio?: number;
  maxFreshWalletRate?: number;
  maxTop70SniperHoldRate?: number;
  minLiquidity?: number;
  minVolume24h?: number;
}

const THRESHOLD_FLAGS: Readonly<Record<keyof GateThresholds, string>> = {
  maxRugRatio: '--max-rug-ratio',
  maxBundlerRate: '--max-bundler-rate',
  maxInsiderRatio: '--max-insider-ratio',
  maxTopHolderRate: '--max-top-holder-rate',
  minSmartDegenCount: '--min-smart-degen-count',
  maxCreatorCreatedOpenRatio: '--max-creator-created-open-ratio',
  maxTwitterRenameCount: '--max-twitter-rename-count',
  maxEntrapmentRatio: '--max-entrapment-ratio',
  maxFreshWalletRate: '--max-fresh-wallet-rate',
  maxTop70SniperHoldRate: '--max-top70-sniper-hold-rate',
  minLiquidity: '--min-liquidity',
  minVolume24h: '--min-volume-24h',
};

/**
 * Contract knowledge, όχι policy: ποιο response field αντιστοιχεί σε ποιο flag. Το
 * χρειάζεται το client-side σκέλος του gate (ungated κύκλος) για να εφαρμόσει τα ΙΔΙΑ
 * thresholds — αν το mapping ήταν μαντεμένο, οι δύο πλευρές θα μέτραγαν άλλα πράγματα.
 */
export const GATE_FIELD_BY_FLAG: Readonly<Record<keyof GateThresholds, string>> = {
  maxRugRatio: 'rug_ratio',
  maxBundlerRate: 'bundler_trader_amount_rate',
  maxInsiderRatio: 'suspected_insider_hold_rate',
  maxTopHolderRate: 'top_10_holder_rate',
  minSmartDegenCount: 'smart_degen_count',
  maxCreatorCreatedOpenRatio: 'creator_created_open_ratio',
  maxTwitterRenameCount: 'twitter_rename_count',
  maxEntrapmentRatio: 'entrapment_ratio',
  maxFreshWalletRate: 'fresh_wallet_rate',
  maxTop70SniperHoldRate: 'top70_sniper_hold_rate',
  minLiquidity: 'liquidity',
  minVolume24h: 'volume_24h',
};

/** Parsed αριθμητικά του gate. `null` σημαίνει «δεν το έδωσε το API», ΟΧΙ «μηδέν». */
export interface GateMetrics {
  rugRatio: number | null;
  bundlerRate: number | null;
  insiderRate: number | null;
  topHolderRate: number | null;
  smartDegenCount: number | null;
  renownedCount: number | null;
  creatorCreatedOpenRatio: number | null;
  twitterRenameCount: number | null;
  entrapmentRatio: number | null;
  freshWalletRate: number | null;
  top70SniperHoldRate: number | null;
  botDegenRate: number | null;
  devTeamHoldRate: number | null;
  progress: number | null;
  liquidity: number | null;
  marketCap: number | null;
  volume24h: number | null;
  holderCount: number | null;
}

export interface TrenchCandidate {
  tokenAddress: string;
  symbol: string | null;
  launchpadPlatform: string | null;
  creator: string | null;
  createdTimestamp: number | null;
  gate: GateMetrics;
  /** Ό,τι γράφεται στο `decision_log.gate_snapshot_json` — raw, χωρίς απώλειες. */
  raw: Record<string, unknown>;
}

export interface FetchTrenchesOptions extends RunOptions {
  chain?: string;
  category: TrenchCategory;
  launchpadPlatforms?: readonly string[];
  thresholds?: GateThresholds;
}

export function buildTrenchesArgs(options: FetchTrenchesOptions): string[] {
  const args = ['market', 'trenches', '--chain', options.chain ?? 'sol', '--type', options.category];

  for (const platform of options.launchpadPlatforms ?? []) {
    args.push('--launchpad-platform', platform);
  }
  for (const [key, flag] of Object.entries(THRESHOLD_FLAGS)) {
    const value = options.thresholds?.[key as keyof GateThresholds];
    if (value !== undefined) args.push(flag, String(value));
  }
  // Το `--limit` αγνοείται από το CLI (ζητήθηκε 3, γύρισε 60), γι' αυτό δε το στέλνουμε.
  return args;
}

export async function fetchTrenches(options: FetchTrenchesOptions): Promise<TrenchCandidate[]> {
  const raw = await runCli('market trenches', buildTrenchesArgs(options), options);
  return parseTrenchesResponse(raw, options.category);
}

export function parseTrenchesResponse(raw: unknown, category: TrenchCategory): TrenchCandidate[] {
  const root = expectObject(raw, 'response');
  // Το πραγματικό CLI επιστρέφει top-level `near_completion` χωρίς `data` wrapper. Τα
  // skill docs υπόσχονται `data.pump`. Δεχόμαστε και τα δύο σχήματα ώστε μια αλλαγή
  // στην κανονικοποίηση του CLI να μη μας ρίξει σιωπηλά στο μηδέν.
  const container = isObject(root['data']) ? (root['data'] as Record<string, unknown>) : root;
  const alias = category === 'near_completion' ? 'pump' : category;
  const list = container[category] ?? container[alias];

  if (list === undefined) {
    throw new GmgnResponseError(
      `no "${category}" (or "${alias}") key; got [${Object.keys(container).join(', ')}]`,
      'trenches',
    );
  }
  return expectArray(list, `trenches.${category}`).map((item, index) =>
    parseCandidate(item, `trenches.${category}[${index}]`),
  );
}

function parseCandidate(item: unknown, path: string): TrenchCandidate {
  const row = expectObject(item, path);
  const num = (field: string): number | null => toNumberOrNull(row[field], `${path}.${field}`);

  return {
    tokenAddress: expectString(row['address'], `${path}.address`),
    symbol: toStringOrNull(row['symbol']),
    launchpadPlatform: toStringOrNull(row['launchpad_platform']),
    creator: toStringOrNull(row['creator']),
    createdTimestamp: num('created_timestamp'),
    gate: {
      rugRatio: num('rug_ratio'),
      bundlerRate: num('bundler_trader_amount_rate'),
      insiderRate: num('suspected_insider_hold_rate'),
      topHolderRate: num('top_10_holder_rate'),
      smartDegenCount: num('smart_degen_count'),
      renownedCount: num('renowned_count'),
      creatorCreatedOpenRatio: num('creator_created_open_ratio'),
      twitterRenameCount: num('twitter_rename_count'),
      entrapmentRatio: num('entrapment_ratio'),
      freshWalletRate: num('fresh_wallet_rate'),
      top70SniperHoldRate: num('top70_sniper_hold_rate'),
      botDegenRate: num('bot_degen_rate'),
      devTeamHoldRate: num('dev_team_hold_rate'),
      progress: num('progress'),
      liquidity: num('liquidity'),
      marketCap: num('market_cap'),
      volume24h: num('volume_24h'),
      holderCount: num('holder_count'),
    },
    raw: row,
  };
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
