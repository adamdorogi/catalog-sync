import { pool, runMigrations } from '@catalog-sync/shared';

try {
  const applied = await runMigrations();
  console.log(applied.length ? applied.join('\n') : 'schema up to date');
} finally {
  await pool.end();
}
