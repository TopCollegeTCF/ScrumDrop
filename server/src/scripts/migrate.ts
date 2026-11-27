// npm run db:migrate — применить миграции и справочники к DATABASE_URL.
import { pool } from '../db.ts';
import { runMigrations } from '../migrate.ts';

try {
  await runMigrations(pool, (message) => console.log(message));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
