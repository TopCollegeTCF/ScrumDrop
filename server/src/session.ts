import { createHash, randomBytes } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { config } from './config.ts';
import { pool } from './db.ts';
import type { Queryable } from './db.ts';
import { HttpError } from './http.ts';

export interface Auth {
  userId: number;
  sessionId: number;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Создаёт сессию и возвращает токен для cookie. В БД хранится только SHA-256 токена. */
export async function createSession(db: Queryable, userId: number, userAgent: string | undefined) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, hashToken(token), userAgent?.slice(0, 300) ?? null, expiresAt],
  );
  return { token, expiresAt };
}

export function setSessionCookie(res: Response, session: { token: string; expiresAt: Date }) {
  res.cookie(config.sessionCookie, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires: session.expiresAt,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(config.sessionCookie, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

/** Читает cookie сессии и, если она действующая, кладёт { userId, sessionId } в res.locals.auth. */
export const loadSession: RequestHandler = async (req, res, next) => {
  const token = readCookie(req.headers.cookie, config.sessionCookie);
  if (token && token.length <= 128) {
    const { rows } = await pool.query<{ id: number; user_id: number }>(
      `SELECT id, user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (row) res.locals.auth = { userId: row.user_id, sessionId: row.id } satisfies Auth;
  }
  next();
};

export function getAuth(res: Response): Auth | undefined {
  return res.locals.auth as Auth | undefined;
}

/** Текущий пользователь или 401. */
export function auth(res: Response): Auth {
  const value = getAuth(res);
  if (!value) throw new HttpError(401, 'unauthorized', 'Войдите в аккаунт, чтобы продолжить');
  return value;
}

export const requireAuth: RequestHandler = (_req, res, next) => {
  auth(res);
  next();
};
