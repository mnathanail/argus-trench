import { runCli, type RunOptions } from './exec.js';
import { expectArray, expectObject, toNumber } from './validate.js';

/**
 * Verified against the real GMGN CLI contract (2026-08-30):
 *
 * gmgn-cli market kline --help:
 *   --chain <chain> --address <address> --resolution <resolution> --from <timestamp>
 *   --to <timestamp>
 *
 * Real live response shape (Solana USDC, 1m candles):
 *   { list: [{ time: 1788119220000, open: "1.0001", close: "0.9999", high: "1.0001", low: "0.9999", volume: "33.0", source: "", amount: "33.0" }] }
 *
 * Το κλειδί είναι `list`, όχι `candles`, τα `time`/`open`/`close`/`high`/`low` είναι
 * numeric strings και το `time` είναι ms epoch. Κρατάμε το adapter robust σε both
 * `list` και `candles` ώστε να μην σπάσει αν η κανονικοποίηση αλλάξει ξανά.
 */
export interface Candle {
  /** Milliseconds since epoch — same as GMGN `time` field. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface FetchKlineOptions extends RunOptions {
  tokenAddress: string;
  chain?: string;
  /** GMGN CLI requires Unix seconds for --from/--to. The raw API response uses ms in `time`. */
  from: number;
  to?: number;
  /** GMGN requires a resolution; 1m preserves the exit tiers' timing detail. */
  resolution?: string;
}

export interface KlineParseContext {
  tokenAddress?: string;
  from?: number;
  to?: number;
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
  return args;
}

export async function fetchKline(options: FetchKlineOptions): Promise<Candle[]> {
  const raw = await runCli('market kline', buildKlineArgs(options), options);
  return parseKlineResponse(raw, {
    tokenAddress: options.tokenAddress,
    from: options.from,
    to: options.to,
    resolution: options.resolution,
  });
}

export function parseKlineResponse(raw: unknown, context: KlineParseContext = {}): Candle[] {
  const response: Record<string, unknown> | null =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(response?.['list'])
      ? response['list']
      : Array.isArray(response?.['candles'])
        ? response['candles']
        : [];

  if (list.length === 0) {
    console.warn(
      `kline returned 0 candles for ${context.tokenAddress ?? 'unknown'}, from=${context.from ?? 'unknown'}, to=${context.to ?? 'unknown'}, resolution=${context.resolution ?? 'unknown'}, raw response: ${JSON.stringify(raw)}`,
    );
  }

  return expectArray(list, 'kline.list|kline.candles').map((item, index) => parseCandle(item, `list[${index}]`));
}

function parseCandle(item: unknown, path: string): Candle {
  const row = expectObject(item, path);
  return {
    timestamp: toNumber(row['time'] ?? row['timestamp'], `${path}.time`),
    open: toNumber(row['open'], `${path}.open`),
    high: toNumber(row['high'], `${path}.high`),
    low: toNumber(row['low'], `${path}.low`),
    close: toNumber(row['close'], `${path}.close`),
  };
}
