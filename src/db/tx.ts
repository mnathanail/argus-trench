import type pg from 'pg';
import { getPool } from './pool.js';

/**
 * Ό,τι μπορεί να εκτελέσει query: το pool ή ένας client μέσα σε transaction. Τα
 * repositories δέχονται αυτό ώστε το ίδιο function να δουλεύει και standalone και ως
 * μέρος μεγαλύτερου transaction, χωρίς διπλή υλοποίηση.
 */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

export function db(explicit?: Queryable): Queryable {
  return explicit ?? getPool();
}
