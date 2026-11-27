// npm run db:local — PostgreSQL 16 без Docker (embedded-postgres), для разработки.
// Данные хранятся в server/.pgdata. Логин, пароль, порт и имя базы берутся из DATABASE_URL.
// Остановка — Ctrl+C. После запуска в другом терминале: npm run dev.
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { config, serverDir } from '../config.ts';

const url = new URL(config.databaseUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
  console.error(`db:local запускает базу только на этом компьютере, а DATABASE_URL указывает на ${url.hostname}.`);
  process.exit(1);
}

const databaseDir = path.join(serverDir, '.pgdata');
const database = decodeURIComponent(url.pathname.slice(1)) || 'scrumdrop';
const port = Number(url.port || 5432);

const postgres = new EmbeddedPostgres({
  databaseDir,
  port,
  user: decodeURIComponent(url.username) || 'scrumdrop',
  password: decodeURIComponent(url.password) || 'scrumdrop',
  authMethod: 'scram-sha-256',
  persistent: true,
  // UTF-8 и локаль с поддержкой кириллицы: lower('Вася') = 'вася', как в Docker-образе.
  initdbFlags: ['--encoding=UTF8', process.platform === 'win32' ? '--locale=en-US' : '--locale=en_US.UTF-8'],
  onLog: () => {},
  onError: (error) => console.error('[postgres]', error),
});

try {
  if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) {
    console.log(`Создаю кластер PostgreSQL в ${databaseDir}…`);
    await postgres.initialise();
  }
  await postgres.start();

  const client = postgres.getPgClient();
  await client.connect();
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  await client.end();
  if (!rowCount) {
    await postgres.createDatabase(database);
    console.log(`Создана база ${database}.`);
  }

  console.log(`PostgreSQL работает: postgresql://${url.username}:***@localhost:${port}/${database}`);
  console.log('Теперь в другом терминале: npm run dev. Остановить базу — Ctrl+C.');
} catch (error) {
  console.error('Не удалось запустить локальный PostgreSQL:', error instanceof Error ? error.message : error);
  console.error(`Если порт ${port} занят, поменяйте его в DATABASE_URL (server/.env).`);
  await postgres.stop().catch(() => {});
  process.exit(1);
}

// Держим процесс живым; embedded-postgres сам останавливает базу при выходе (Ctrl+C).
setInterval(() => {}, 1 << 30);
