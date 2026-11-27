import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.ts';
import { HttpError, parse } from '../http.ts';
import { auth } from '../session.ts';
import { getUserProfile } from '../users.ts';

// Роутер монтируется в корень /api, поэтому вход проверяется в каждом обработчике (auth(res)),
// а не через router.use — иначе 401 получали бы и чужие маршруты, например /api/cases.
export const profileRouter = Router();

const profilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Введите имя игрока').max(24, 'Имя — не длиннее 24 символов').optional(),
    avatar: z.string().regex(/^[a-z0-9_]{1,64}$/, 'Такой аватарки нет').optional(),
  })
  .refine((body) => body.displayName !== undefined || body.avatar !== undefined, 'Нечего сохранять');

const reactionSchema = z.object({
  timeMs: z
    .number({ error: 'timeMs — время реакции в миллисекундах' })
    .int('timeMs — целое число')
    .min(1, 'Слишком маленькое время')
    .max(60_000, 'Слишком большое время'),
});

/** GET /api/me — профиль текущего игрока. */
profileRouter.get('/me', async (_req, res) => {
  res.json({ user: await getUserProfile(pool, auth(res).userId) });
});

/** PATCH /api/me — имя игрока и аватарка (код кейса из каталога). */
profileRouter.patch('/me', async (req, res) => {
  const { userId } = auth(res);
  const body = parse(profilePatchSchema, req.body);

  if (body.avatar !== undefined) {
    const { rowCount } = await pool.query(`SELECT 1 FROM cases WHERE code = $1 AND is_active`, [body.avatar]);
    if (!rowCount) throw new HttpError(400, 'validation_error', 'Такой аватарки нет', { field: 'avatar' });
  }

  await pool.query(
    `UPDATE users
        SET display_name = COALESCE($2, display_name),
            avatar = COALESCE($3, avatar)
      WHERE id = $1`,
    [userId, body.displayName ?? null, body.avatar ?? null],
  );
  res.json({ user: await getUserProfile(pool, userId) });
});

/** POST /api/games/reaction — результат «Теста реакции»; сохраняется, если это рекорд. */
profileRouter.post('/games/reaction', async (req, res) => {
  const { userId } = auth(res);
  const { timeMs } = parse(reactionSchema, req.body);
  const updated = await pool.query<{ reaction_best_ms: number }>(
    `UPDATE users SET reaction_best_ms = $2
      WHERE id = $1 AND (reaction_best_ms IS NULL OR reaction_best_ms > $2)
      RETURNING reaction_best_ms`,
    [userId, timeMs],
  );
  if (updated.rows[0]) {
    res.json({ timeMs, bestMs: updated.rows[0].reaction_best_ms, isRecord: true });
    return;
  }
  const { rows } = await pool.query<{ reaction_best_ms: number }>(`SELECT reaction_best_ms FROM users WHERE id = $1`, [
    userId,
  ]);
  res.json({ timeMs, bestMs: rows[0]?.reaction_best_ms ?? timeMs, isRecord: false });
});
