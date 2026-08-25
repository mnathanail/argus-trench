import pg from 'pg';
import { config } from '../config.js';

/**
 * Managed Postgres (Railway public proxy, Supabase κ.λπ.) σερβίρει certs που δεν
 * επικυρώνονται από το default CA store του Node. Όταν το URL ζητά ρητά SSL,
 * κρατάμε την κρυπτογράφηση αλλά χαλαρώνουμε την επικύρωση — αλλιώς το pg σκάει με
 * SELF_SIGNED_CERT_IN_CHAIN. Οι internal συνδέσεις μέσα στο Railway
 * (*.railway.internal) δε χρειάζονται SSL καθόλου, οπότε δε μπαίνει sslmode εκεί.
 */
function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  const mode = new URL(connectionString).searchParams.get('sslmode');
  if (mode === undefined || mode === null || mode === 'disable') return undefined;
  return { rejectUnauthorized: false };
}

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = config.databaseUrl();
    const ssl = sslFor(connectionString);
    pool = new pg.Pool(ssl ? { connectionString, ssl } : { connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}
