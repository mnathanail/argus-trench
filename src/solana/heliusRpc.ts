/**
 * Ελάχιστος Solana JSON-RPC client πάνω στο Helius (2026-09-30, MIRROR γρήγορη πηγή).
 * Μόνο ό,τι χρειάζεται το mirror: getTransaction (jsonParsed) και getSignaturesForAddress.
 */

export function heliusRpcUrl(apiKey: string): string {
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

export function heliusWsUrl(apiKey: string): string {
  return `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

// ── jsonParsed σχήμα (μόνο τα πεδία που διαβάζουμε) ─────────────────────────────
export interface ParsedAccountKey {
  pubkey: string;
  signer?: boolean;
  writable?: boolean;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface ParsedTransaction {
  blockTime?: number | null;
  slot?: number;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    logMessages?: string[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: ParsedAccountKey[] };
  };
}

export class SolanaRpcError extends Error {}

export async function rpcCall<T>(url: string, method: string, params: unknown[], timeoutMs = 10_000): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new SolanaRpcError(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new SolanaRpcError(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

export async function getParsedTransaction(url: string, signature: string): Promise<ParsedTransaction | null> {
  return rpcCall<ParsedTransaction | null>(url, 'getTransaction', [
    signature,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);
}

/**
 * Αμέσως μετά από ένα `confirmed` logsNotification το getTransaction συχνά επιστρέφει
 * ακόμα null (ο RPC κόμβος δεν το έχει ευρετηριάσει). Ξαναδοκιμάζει με μικρές αναμονές.
 */
export async function getParsedTransactionWithRetry(
  url: string,
  signature: string,
  delaysMs: readonly number[] = [0, 400, 800, 1_500, 3_000, 5_000],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ParsedTransaction | null> {
  let lastError: unknown = null;
  for (const delay of delaysMs) {
    if (delay > 0) await sleep(delay);
    try {
      const tx = await getParsedTransaction(url, signature);
      if (tx !== null) return tx;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError !== null) throw lastError;
  return null;
}

export interface SignatureInfo {
  signature: string;
  blockTime?: number | null;
  err: unknown;
}

export async function getSignaturesForAddress(url: string, address: string, limit: number): Promise<SignatureInfo[]> {
  return rpcCall<SignatureInfo[]>(url, 'getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]);
}
