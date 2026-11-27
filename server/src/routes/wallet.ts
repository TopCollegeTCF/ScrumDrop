import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, withTransaction } from '../db.ts';
import { HttpError, parse, requestIdSchema } from '../http.ts';
import { auth } from '../session.ts';

export const walletRouter = Router();

const TOP_UP_PRESETS = [100, 300, 500].filter((amount) => amount <= config.topUpMax);

const topUpSchema = z.object({
  amount: z
    .number({ error: 'Укажите сумму пополнения' })
    .int('Сумма — целое число монет')
    .min(1, 'Сумма должна быть больше нуля')
    .max(config.topUpMax, `За один раз можно пополнить не больше ${config.topUpMax} монет`),
  requestId: requestIdSchema,
});

interface TransactionRow {
  id: number;
  type: string;
  amount: number;
  balance_after: number;
  created_at: Date;
  case_name: string | null;
  game_name: string | null;
}

const toTransaction = (row: TransactionRow) => ({
  id: row.id,
  type: row.type,
  amount: row.amount,
  balanceAfter: row.balance_after,
  createdAt: row.created_at.toISOString(),
  caseName: row.case_name,
  gameName: row.game_name,
});

/** GET /api/wallet — баланс, настройки пополнения и последние операции журнала. */
walletRouter.get('/', async (_req, res) => {
  const { userId } = auth(res);
  const [balance, journal] = await Promise.all([
    pool.query<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [userId]),
    pool.query<TransactionRow>(
      `SELECT t.id, t.type, t.amount, t.balance_after, t.created_at,
              c.name AS case_name, g.name AS game_name
         FROM transactions t
         LEFT JOIN case_openings o ON o.id = t.opening_id
         LEFT JOIN cases c ON c.id = o.case_id
         LEFT JOIN bets b ON b.id = t.bet_id
         LEFT JOIN games g ON g.id = b.game_id
        WHERE t.user_id = $1
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT 50`,
      [userId],
    ),
  ]);
  res.json({
    balance: balance.rows[0]?.balance ?? 0,
    topUp: { enabled: config.demoTopUp, max: config.topUpMax, presets: TOP_UP_PRESETS },
    transactions: journal.rows.map(toTransaction),
  });
});

/**
 * POST /api/wallet/top-up — демо-пополнение виртуальных монет (без карты и реальных денег).
 * requestId защищает от двойного начисления при повторе запроса.
 */
walletRouter.post('/top-up', async (req, res) => {
  const { userId } = auth(res);
  if (!config.demoTopUp) {
    throw new HttpError(403, 'top_up_disabled', 'Пополнение пока недоступно');
  }
  const body = parse(topUpSchema, req.body);

  const result = await withTransaction(async (db) => {
    // Блокируем строку игрока: параллельные пополнения с тем же requestId выполнятся по очереди.
    await db.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);

    const existing = await db.query<TransactionRow>(
      `SELECT id, type, amount, balance_after, created_at, NULL AS case_name, NULL AS game_name
         FROM transactions WHERE user_id = $1 AND request_id = $2`,
      [userId, body.requestId],
    );
    const previous = existing.rows[0];
    if (previous) {
      if (previous.type !== 'top_up' || previous.amount !== body.amount) {
        throw new HttpError(409, 'request_id_reused', 'Этот requestId уже использован для другой операции');
      }
      const { rows } = await db.query<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [userId]);
      return { transaction: toTransaction(previous), balance: rows[0]!.balance, repeated: true };
    }

    const { rows } = await db.query<TransactionRow>(
      `WITH updated AS (
         UPDATE users SET balance = balance + $2::bigint WHERE id = $1 RETURNING balance
       )
       INSERT INTO transactions (user_id, type, amount, balance_after, request_id)
       SELECT $1, 'top_up', $2::bigint, balance, $3 FROM updated
       RETURNING id, type, amount, balance_after, created_at, NULL AS case_name, NULL AS game_name`,
      [userId, body.amount, body.requestId],
    );
    const row = rows[0]!;
    return { transaction: toTransaction(row), balance: row.balance_after, repeated: false };
  });

  res.status(result.repeated ? 200 : 201).json(result);
});
