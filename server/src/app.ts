import express from 'express';
import type { RequestHandler } from 'express';
import { config } from './config.ts';
import { pool } from './db.ts';
import { HttpError, errorHandler, notFoundApi } from './http.ts';
import { authRouter } from './routes/auth.ts';
import { casesRouter } from './routes/cases.ts';
import { inventoryRouter } from './routes/inventory.ts';
import { pokerRouter } from './routes/poker.ts';
import { profileRouter } from './routes/profile.ts';
import { walletRouter } from './routes/wallet.ts';
import { loadSession } from './session.ts';

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
};

function isAllowedOrigin(origin: string, host: string | undefined): boolean {
  if (config.corsOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** CORS для отдельного dev-фронтенда (CORS_ORIGINS) и защита от CSRF по заголовку Origin. */
const originGuard: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
  }
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (!safe && origin && !isAllowedOrigin(origin, req.get('host'))) {
    throw new HttpError(403, 'forbidden_origin', 'Запрос с чужого сайта отклонён');
  }
  next();
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(originGuard);
  api.use(express.json({ limit: '16kb' }));
  api.use(loadSession);

  api.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  });
  api.use('/auth', authRouter);
  api.use('/cases', casesRouter);
  api.use('/wallet', walletRouter);
  api.use('/poker', pokerRouter);
  api.use(inventoryRouter);
  api.use(profileRouter);
  api.use(notFoundApi);

  app.use('/api', api);
  app.use(express.static(config.frontendDir, { index: 'index.html' }));
  app.use(errorHandler);
  return app;
}
