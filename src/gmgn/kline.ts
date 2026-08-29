import { runCli, type RunOptions } from './exec.js';
import { expectArray, expectObject, toNumber } from './validate.js';

/**
 * ⚠️ ΜΗ ΕΠΑΛΗΘΕΥΜΕΝΟ ακόμα με πραγματικό call — σε αντίθεση με τα trenches/holders/
 * walletStats/activity, που έχουν όλα δοκιμαστεί πραγματικά (βλ. "Verified CLI contract"
 * στο CLAUDE.md). Τα flags και το response shape παρακάτω είναι λογική παραδοχή βάσει
 * του pattern των άλλων routes, ΟΧΙ επιβεβαιωμένα. Πριν εμπιστευτείς το exit-resolver σε
 * ζωντανά δεδομένα, έλεγξε με `gmgn-cli market kline --help` (ή τα `.agents/skills`
 * docs) ότι τα flags/field names παρακάτω ταιριάζουν, και διόρθωσε ό,τι διαφέρει — ίδια
 * διαδικασία με αυτή που αποκάλυψε τα `near_completion`/`event_type`/`tx_hash` λάθη.
 */
export interface Candle {
  /** Unix seconds. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface FetchKlineOptions extends RunOptions {
  tokenAddress: string;
  chain?: string;
  /** Unix seconds. */
  from: number;
  to?: number;
  /** GMGN requires a resolution; 1m preserves the exit tiers' timing detail. */
  resolution?: string;
}

export function buildKlineArgs(options: FetchKlineOptions): string[] {
  const args = [
    'market',
    'kline',
    '--chain',
    options.chain ?? 'sol',
    '--address',
    options.tokenAddress,
    '--resolution',
    options.resolution ?? '1m',
    '--from',
    String(options.from),
  ];
  if (options.to !== undefined) args.push('--to', String(options.to));
  if (options.resolution !== undefined) args.push('--resolution', options.resolution);
  return args;
}

export async function fetchKline(options: FetchKlineOptions): Promise<Candle[]> {
  const raw = await runCli('market kline', buildKlineArgs(options), options);
  return parseKlineResponse(raw);
}

export function parseKlineResponse(raw: unknown): Candle[] {
  // Υπόθεση: array απευθείας ή κάτω από 'candles' — ό,τι ταιριάζει το κρατάμε, χωρίς να
  // σκάσουμε σε ένα από τα δύο σχήματα, ΑΛΛΑ σκάμε δυνατά αν είναι κάτι τρίτο εντελώς
  // (ίδια φιλοσοφία με τα υπόλοιπα validators — βλ. validate.ts).
  const list = Array.isArray(raw)
    ? raw
    : expectArray(expectObject(raw, 'response')['candles'] ?? [], 'candles');
  return list.map((item, index) => parseCandle(item, `candles[${index}]`));
}

function parseCandle(item: unknown, path: string): Candle {
  const row = expectObject(item, path);
  return {
    timestamp: toNumber(row['timestamp'] ?? row['time'], `${path}.timestamp`),
    open: toNumber(row['open'], `${path}.open`),
    high: toNumber(row['high'], `${path}.high`),
    low: toNumber(row['low'], `${path}.low`),
    close: toNumber(row['close'], `${path}.close`),
  };
}
