import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { isUniqueViolation, pool, withTransaction } from '../db.ts';
import { HttpError, parse, rateLimit } from '../http.ts';
import { clearSessionCookie, createSession, getAuth, setSessionCookie } from '../session.ts';
import { getUserProfile } from '../users.ts';

export const authRouter = Router();

const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: config.authRateLimit });

const usernameSchema = z
  .string({ error: 'Укажите логин' })
  .trim()
  .min(3, 'Логин — от 3 до 32 символов')
  .max(32, 'Логин — от 3 до 32 символов')
  .regex(/^[\p{L}\p{N}_.-]+$/u, 'В логине можно использовать буквы, цифры, точку, дефис и подчёркивание');

const passwordSchema = z
  .string({ error: 'Укажите пароль' })
  .min(8, 'Пароль — минимум 8 символов')
  // bcrypt учитывает только первые 72 байта, длиннее — молча обрезал бы.
  .refine((password) => Buffer.byteLength(password, 'utf8') <= 72, 'Пароль слишком длинный: не больше 72 байт');

const registerSchema = z.object({
  username: usernameSchema,
  email: z
    .string({ error: 'Укажите почту' })
    .trim()
    .toLowerCase()
    .max(254, 'Слишком длинная почта')
    .pipe(z.email('Некорректная почта')),
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Введите имя игрока').max(24, 'Имя — не длиннее 24 символов').optional(),
});

const loginSchema = z.object({
  login: z.string({ error: 'Укажите логин или почту' }).trim().min(1, 'Укажите логин или почту').max(254),
  password: z.string({ error: 'Укажите пароль' }).min(1, 'Укажите пароль').max(1024),
});

// Хеш для сравнения, когда пользователя нет: время ответа не выдаёт, существует ли логин.
let dummyHash: string | undefined;
const getDummyHash = async () => (dummyHash ??= await bcrypt.hash('scrumdrop-dummy-password', config.bcryptRounds));

/** GET /api/auth/session — кто сейчас вошёл. Для гостя user = null (не 401). */
authRouter.get('/session', async (_req, res) => {
  const current = getAuth(res);
  res.json({ user: current ? await getUserProfile(pool, current.userId) : null });
});

/** POST /api/auth/register — создание аккаунта со стартовым бонусом и сразу вход. */
authRouter.post('/register', authLimiter, async (req, res) => {
  const body = parse(registerSchema, req.body);
  const passwordHash = await bcrypt.hash(body.password, config.bcryptRounds);

  let created: { userId: number; session: Awaited<ReturnType<typeof createSession>> };
  try {
    created = await withTransaction(async (db) => {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO users (username, email, password_hash, display_name, last_login_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id`,
        [body.username, body.email, passwordHash, body.displayName ?? null],
      );
      const userId = rows[0]!.id;

      // Стартовый бонус: баланс меняется только вместе с записью в журнал (см. db/README.md).
      if (config.signupBonus > 0) {
        await db.query(
          `WITH updated AS (
             UPDATE users SET balance = balance + $2::bigint WHERE id = $1 RETURNING balance
           )
           INSERT INTO transactions (user_id, type, amount, balance_after)
           SELECT $1, 'signup_bonus', $2::bigint, balance FROM updated`,
          [userId, config.signupBonus],
        );
        await db.query(`INSERT INTO bonuses (user_id, bonus_type, amount) VALUES ($1, 'signup_bonus', $2)`, [
          userId,
          config.signupBonus,
        ]);
      }

      const session = await createSession(db, userId, req.get('user-agent'));
      return { userId, session };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'users_username_unique_ci')) {
      throw new HttpError(409, 'username_taken', 'Этот логин уже занят', { field: 'username' });
    }
    if (isUniqueViolation(error, 'users_email_unique_ci')) {
      throw new HttpError(409, 'email_taken', 'Эта почта уже зарегистрирована', { field: 'email' });
    }
    throw error;
  }

  setSessionCookie(res, created.session);
  res.status(201).json({ user: await getUserProfile(pool, created.userId) });
});

/** POST /api/auth/login — вход по логину или почте. */
authRouter.post('/login', authLimiter, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const { rows } = await pool.query<{ id: number; password_hash: string }>(
    `SELECT id, password_hash FROM users
      WHERE lower(username) = lower($1) OR lower(email) = lower($1)
      LIMIT 1`,
    [body.login],
  );
  const user = rows[0];
  const passwordOk = await bcrypt.compare(body.password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !passwordOk) {
    throw new HttpError(401, 'invalid_credentials', 'Неверный логин или пароль');
  }

  const session = await withTransaction(async (db) => {
    await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()`, [user.id]);
    return createSession(db, user.id, req.get('user-agent'));
  });

  setSessionCookie(res, session);
  res.json({ user: await getUserProfile(pool, user.id) });
});

/** POST /api/auth/logout — завершает текущую сессию. */
authRouter.post('/logout', async (_req, res) => {
  const current = getAuth(res);
  if (current) await pool.query(`DELETE FROM sessions WHERE id = $1`, [current.sessionId]);
  clearSessionCookie(res);
  res.status(204).end();
});
