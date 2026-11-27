import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(serverDir, '..');

// server/.env подхватывается, но не перекрывает переменные окружения процесса.
const envFile = path.join(serverDir, '.env');
if (existsSync(envFile)) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function str(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Переменная ${name}=${raw}: нужно целое число от ${min} до ${max}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`Переменная ${name}=${raw}: ожидается true или false`);
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: int('PORT', 3000, 0, 65535),
  host: str('HOST', '0.0.0.0'),
  databaseUrl: str('DATABASE_URL', 'postgresql://scrumdrop:scrumdrop@localhost:5432/scrumdrop'),
  migrateOnStart: bool('DB_MIGRATE_ON_START', true),

  sessionCookie: 'sd_session',
  sessionTtlDays: int('SESSION_TTL_DAYS', 30, 1, 365),
  cookieSecure: bool('COOKIE_SECURE', isProduction),
  bcryptRounds: int('BCRYPT_ROUNDS', 11, 4, 15),
  authRateLimit: int('AUTH_RATE_LIMIT', 30, 1, 100_000),

  signupBonus: int('SIGNUP_BONUS', 100, 0, 1_000_000),
  demoTopUp: bool('DEMO_TOP_UP', !isProduction),
  topUpMax: int('TOP_UP_MAX', 1000, 1, 1_000_000),
  maxUpgradeLevel: 1,

  corsOrigins: str('CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
  trustProxy: int('TRUST_PROXY', 0, 0, 10),

  frontendDir: path.resolve(repoRoot, str('FRONTEND_DIR', 'frontend')),
  migrationsDir: path.join(repoRoot, 'db', 'migrations'),
  seedFile: path.join(repoRoot, 'db', 'seed.sql'),
} as const;
