import { createApp } from './app.ts';
import { config } from './config.ts';
import { pool } from './db.ts';
import { runMigrations } from './migrate.ts';

function explainDbError(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === '28P01' || code === '3D000') {
    console.error(
      `\nНе удалось подключиться к PostgreSQL (${code}).\n` +
        `Проверьте DATABASE_URL и что база запущена:\n` +
        `  docker compose up -d      — из корня проекта, если есть Docker\n` +
        `  npm run db:local          — локальный PostgreSQL без Docker (в отдельном терминале)\n`,
    );
  }
}

try {
  if (config.migrateOnStart) await runMigrations(pool, (message) => console.log(message));
  else await pool.query('SELECT 1');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  explainDbError(error);
  await pool.end();
  process.exit(1);
}

const server = createApp().listen(config.port, config.host, () => {
  console.log(`ScrumDrop запущен: http://localhost:${config.port}`);
  if (config.demoTopUp) console.log('Демо-пополнение монет включено (DEMO_TOP_UP=true).');
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Останавливаю сервер…');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
