import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';

z.config(z.locales.ru());

/** Ошибка, которую можно показать пользователю: статус, машинный код и русское сообщение. */
export class HttpError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Проверяет данные схемой zod; при ошибке — 400 с понятным сообщением и именем поля. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join('.') || undefined;
  throw new HttpError(400, 'validation_error', issue?.message ?? 'Некорректные данные', field ? { field } : undefined);
}

export const requestIdSchema = z.uuid({ error: 'requestId должен быть UUID' });

/** Простое ограничение частоты запросов в памяти процесса (по IP). */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
    }
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      throw new HttpError(429, 'too_many_requests', 'Слишком много попыток. Попробуйте через несколько минут.');
    }
    next();
  };
}

export const notFoundApi: RequestHandler = (req) => {
  throw new HttpError(404, 'not_found', `Нет такого метода API: ${req.method} ${req.originalUrl}`);
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    return;
  }

  const type = (error as { type?: string } | null)?.type;
  if (type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Тело запроса — некорректный JSON' } });
    return;
  }
  if (type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Слишком большой запрос' } });
    return;
  }

  console.error(`${req.method} ${req.originalUrl}:`, error);
  res.status(500).json({ error: { code: 'internal_error', message: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' } });
};
