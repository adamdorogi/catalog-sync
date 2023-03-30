import pg, { type PoolClient } from 'pg';
import { config } from './config.js';

export type Queryable = Pick<PoolClient, 'query'>;

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on('error', (error) => console.error('idle database connection failed', error.message));

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
