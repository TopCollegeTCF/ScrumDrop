// Общая обвязка интеграционных тестов API на настоящем PostgreSQL.
// Для каждого тестового файла создаётся отдельная временная база и после удаляется.
// Нужен запущенный PostgreSQL (docker compose up -d или npm run db:local) и права CREATE DATABASE.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before } from 'node:test';
import pg from 'pg';

const baseUrl =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://scrumdrop:scrumdrop@localhost:5432/scrumdrop';
const testDb = `scrumdrop_test_${process.pid}_${Date.now()}`;
const withDb = (url: string, name: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

let server: Server;
export let api: string;
export let pool: pg.Pool;

/** Поднимает сервер на временной базе перед тестами файла и удаляет базу после. */
export function useTestServer() {
  before(async () => {
    const admin = new pg.Client({ connectionString: withDb(baseUrl, 'postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${testDb}`);
    await admin.end();

    process.env.DATABASE_URL = withDb(baseUrl, testDb);
    process.env.BCRYPT_ROUNDS = '4';
    process.env.AUTH_RATE_LIMIT = '1000';
    process.env.DEMO_TOP_UP = 'true';

    const db = await import('../src/db.ts');
    const { runMigrations } = await import('../src/migrate.ts');
    const { createApp } = await import('../src/app.ts');
    pool = db.pool;
    await runMigrations(pool);
    // Повторный прогон миграций ничего не ломает.
    await runMigrations(pool);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
    const admin = new pg.Client({ connectionString: withDb(baseUrl, 'postgres') });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
    await admin.end();
  });
}

/** Мини-клиент с cookie, как браузер. */
export class Player {
  cookie = '';

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(api + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ''] = header.split(';');
      const [name, value = ''] = pair.split('=');
      if (name === 'sd_session') this.cookie = value ? `sd_session=${value}` : '';
    }
    // В тестах ответ проверяется по полям, поэтому any вместо описания всех типов ответа.
    const data: any = response.status === 204 ? null : await response.json();
    return { status: response.status, data, headers: response.headers };
  }

  get = (path: string) => this.call('GET', path);
  post = (path: string, body?: unknown) => this.call('POST', path, body);
  patch = (path: string, body?: unknown) => this.call('PATCH', path, body);
}

let counter = 0;
export async function registered(prefix = 'player') {
  counter += 1;
  const player = new Player();
  const username = `${prefix}${counter}`;
  const res = await player.post('/auth/register', {
    username,
    email: `${username}@example.com`,
    password: 'correct-horse',
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { player, user: res.data.user, username };
}

export async function ledgerMismatches() {
  const { rows } = await pool.query(
    `SELECT u.id FROM users u LEFT JOIN transactions t ON t.user_id = u.id
      GROUP BY u.id, u.balance HAVING u.balance <> COALESCE(SUM(t.amount), 0)`,
  );
  return rows.length;
}
