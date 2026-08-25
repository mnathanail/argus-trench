/**
 * Migration runner — τρέχει τα .sql του `migrations/` με σειρά ονόματος.
 *
 * Γιατί σε Node και όχι σε psql: το ίδιο σκριπτ τρέχει τοπικά (docker compose),
 * στο CI και ως Railway pre-deploy command, χωρίς να απαιτεί psql binary στο host.
 * Χρειάζεται ΜΟΝΟ το DATABASE_URL.
 *
 *   npm run migrate           # apply pending
 *   npm run migrate:status    # τι έχει εφαρμοστεί / τι λείπει
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { closePool, getPool } from './pool.js';

// src/db/ -> project root -> migrations/  (ίδιο και για dist/db/, ίδιο βάθος)
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Ξεχωριστό lock id ώστε δύο ταυτόχρονα deploys να μη τρέξουν τα ίδια migrations.
const LOCK_ID = 8_142_690_001;

const TRACKING_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

async function appliedFilenames(client: pg.PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function showStatus(client: pg.PoolClient): Promise<void> {
  await client.query(TRACKING_TABLE_SQL);
  const [files, applied] = [await listMigrationFiles(), await appliedFilenames(client)];
  for (const file of files) {
    console.log(`${applied.has(file) ? '✓ applied ' : '· pending '} ${file}`);
  }
  const orphans = [...applied].filter((f) => !files.includes(f));
  for (const file of orphans) {
    console.warn(`! recorded but file missing: ${file}`);
  }
  const pending = files.filter((f) => !applied.has(f)).length;
  console.log(`\n${files.length} migration(s), ${pending} pending.`);
}

async function applyPending(client: pg.PoolClient): Promise<void> {
  await client.query(TRACKING_TABLE_SQL);
  const [files, applied] = [await listMigrationFiles(), await appliedFilenames(client)];
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  for (const file of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Κάθε migration σε δικό του transaction: μια αποτυχία δε ρολάρει πίσω τα
    // προηγούμενα, και το schema_migrations μένει συνεπές με το τι πέρασε.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✓ applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`✗ failed ${file}`);
      throw error;
    }
  }
  console.log(`\nDone — ${pending.length} migration(s) applied.`);
}

async function main(): Promise<void> {
  const statusOnly = process.argv.includes('--status');
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    try {
      await (statusOnly ? showStatus(client) : applyPending(client));
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
