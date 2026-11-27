import { Router } from 'express';
import { z } from 'zod';
import { parse, requestIdSchema } from '../http.ts';
import * as poker from '../poker/service.ts';
import { POKER_RULES } from '../poker/session.ts';
import { auth } from '../session.ts';

/**
 * Покер (техасский холдем против ботов) — /api/poker. Все методы требуют входа:
 * бай-ин списывается с баланса монет игрока, выигрыш возвращается на него же.
 * Express 5 сам передаёт ошибки из async-обработчиков в errorHandler.
 */
export const pokerRouter = Router();

const sitSchema = z.object({
  buyIn: z.number({ error: 'Укажите бай-ин' }).int('Бай-ин — целое число монет'),
  bots: z
    .number({ error: 'Укажите число соперников' })
    .int('Число соперников — целое')
    .min(1, `Соперников может быть от 1 до ${POKER_RULES.maxBots}`)
    .max(POKER_RULES.maxBots, `Соперников может быть от 1 до ${POKER_RULES.maxBots}`),
  requestId: requestIdSchema,
});

const actionSchema = z
  .object({
    type: z.enum(['fold', 'check', 'call', 'raise', 'allin'], { error: 'Неизвестное действие' }),
    amount: z.number({ error: 'Сумма рейза — число' }).int('Сумма рейза — целое число').optional(),
  })
  .refine((action) => action.type !== 'raise' || action.amount !== undefined, {
    message: 'Укажите сумму рейза',
    path: ['amount'],
  });

const historySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(12),
});

/** GET /api/poker/config — бай-ин, блайнды, соперники и баланс — для лобби. */
pokerRouter.get('/config', async (_req, res) => {
  res.json(await poker.getConfig(auth(res).userId));
});

/** GET /api/poker/state — текущий стол или session: null. */
pokerRouter.get('/state', async (_req, res) => {
  res.json(await poker.getState(auth(res).userId));
});

/** POST /api/poker/sit { buyIn, bots, requestId } — сесть за стол. */
pokerRouter.post('/sit', async (req, res) => {
  const { userId } = auth(res);
  const body = parse(sitSchema, req.body);
  const result = await poker.sit(userId, body);
  res.status(result.repeated ? 200 : 201).json(result);
});

/** POST /api/poker/action { type, amount? } — ход игрока; amount у raise — «рейз до». */
pokerRouter.post('/action', async (req, res) => {
  const { userId } = auth(res);
  const action = parse(actionSchema, req.body);
  res.json(await poker.act(userId, action.type === 'raise' ? { type: 'raise', amount: action.amount } : { type: action.type }));
});

/** POST /api/poker/next-hand — следующая раздача. */
pokerRouter.post('/next-hand', async (_req, res) => {
  res.json(await poker.nextHand(auth(res).userId));
});

/** POST /api/poker/leave — встать из-за стола, фишки возвращаются на баланс. */
pokerRouter.post('/leave', async (_req, res) => {
  res.json(await poker.leave(auth(res).userId));
});

/** GET /api/poker/history?limit=12 — последние раздачи, новые сверху. */
pokerRouter.get('/history', async (req, res) => {
  const { userId } = auth(res);
  const { limit } = parse(historySchema, req.query);
  res.json({ hands: await poker.history(userId, limit) });
});
