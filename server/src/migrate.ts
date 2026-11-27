import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { config } from './config.ts';

const LOCK_ID = 7_240_001; // pg_advisory_lock: две копии сервера не будут мигрировать одновременно

/**
 * Применяет db/migrations/*.sql по порядку и затем db/seed.sql.
 * Применённые файлы записываются в schema_migrations. Если 001_init.sql уже выполнил
 * docker-entrypoint (таблица users есть, а записи нет), миграция просто отмечается.
 */
export async function runMigrations(pool: Pool, log: (message: string) => void = () => {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const files = (await readdir(config.migrationsDir)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();

    if (files.includes('001_init.sql') && !applied.has('001_init.sql')) {
      const { rows: check } = await client.query<{ exists: boolean }>(
        `SELECT to_regclass('public.users') IS NOT NULL AS exists`,
      );
      if (check[0]?.exists) {
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', ['001_init.sql']);
        applied.add('001_init.sql');
        log('Миграция 001_init.sql уже была применена (docker-entrypoint) — отмечена.');
      }
    }

    for (const file of files) {
      if (applied.has(file)) continue;
      log(`Применяю миграцию ${file}…`);
      await runSqlFile(client, path.join(config.migrationsDir, file));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }

    await runSqlFile(client, config.seedFile);
    log('База данных готова: миграции и справочники применены.');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

async function runSqlFile(client: { query: (sql: string) => Promise<unknown> }, file: string) {
  const sql = await readFile(file, 'utf8');
  try {
    await client.query(sql);
  } catch (error) {
    // SQL-файлы сами открывают BEGIN; после ошибки соединение нужно вывести из прерванной транзакции.
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`Ошибка в ${path.basename(file)}: ${(error as Error).message}`, { cause: error });
  }
}
