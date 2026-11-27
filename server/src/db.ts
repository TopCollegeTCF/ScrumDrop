import pg from 'pg';
import type { PoolClient } from 'pg';
import { config } from './config.ts';

// BIGINT (суммы, id, count) приходят строкой; монеты далеко от 2^53, поэтому переводим в number.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (value: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`BIGINT ${value} не помещается в number`);
  return number;
});

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (error) => {
  console.error('PostgreSQL: ошибка простаивающего соединения', error);
});

/** То, через что можно выполнять запросы: пул или соединение внутри транзакции. */
export type Queryable = Pick<PoolClient, 'query'>;

/** Выполняет fn в одной транзакции БД: COMMIT при успехе, ROLLBACK при любой ошибке. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

interface PgError {
  code?: string;
  constraint?: string;
}

/** Нарушение уникальности (23505), при желании — конкретного индекса/ограничения. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = error as PgError | null;
  return pgError?.code === '23505' && (constraint === undefined || pgError.constraint === constraint);
}
