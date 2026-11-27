// Покер в PostgreSQL: стол, деньги и история.
//
// Каждый запрос — одна транзакция БД:
//   1) блокируем строку игрока (SELECT … FOR UPDATE), чтобы двойной клик или две вкладки
//      не испортили баланс и состояние стола;
//   2) загружаем стол из poker_sessions.state;
//   3) применяем ход игрока, боты отвечают (правила — в session.ts);
//   4) сохраняем стол, пишем историю раздачи, деньги — через bets и transactions.
// Любая ошибка — ROLLBACK, ничего не меняется.
//
// Деньги — те же монеты, что на балансе ScrumDrop: 1 фишка за столом = 1 монета.

import { pool, withTransaction } from '../db.ts';
import type { Queryable } from '../db.ts';
import { HttpError } from '../http.ts';
import {
  checkCanSit,
  closeSummary,
  dealHand,
  ensureVersion,
  foldAndFinish,
  makeConfig,
  newSession,
  playerAct,
  playerStack,
  POKER_RULES,
  sessionInfo,
  takeHandRecord,
  type GameLimits,
  type SessionState,
} from './session.ts';
import type {
  Card,
  HandHistoryItem,
  PlayerAction,
  PokerConfig,
  PublicView,
  SessionClosed,
  TableResponse,
} from './types.ts';

interface GameRow {
  id: number;
  min_bet: number;
  max_bet: number;
  is_active: boolean;
}

interface PlayerRow {
  id: number;
  name: string;
  balance: number;
}

interface SessionRow {
  id: number;
  bet_id: number;
  state: SessionState;
}

interface HandRow {
  id: number;
  hand_no: number;
  hole_cards: Card[];
  board: Card[];
  pot: number;
  invested: number;
  won: number;
  summary: string | null;
  created_at: Date;
}

const limitsOf = (game: GameRow): GameLimits => ({
  minBuyIn: game.min_bet,
  maxBuyIn: game.max_bet,
  isActive: game.is_active,
});

// ---------------------------------------------------------------------------
// Публичные операции (их вызывает routes/poker.ts)
// ---------------------------------------------------------------------------

/** Настройки стола и баланс — для лобби. */
export async function getConfig(userId: number): Promise<PokerConfig> {
  const [game, player] = await Promise.all([getGame(pool), getPlayer(pool, userId, false)]);
  return makeConfig(player.name, player.balance, limitsOf(game));
}

/** Текущий стол, если игрок за ним сидит (например, после перезагрузки страницы). */
export async function getState(userId: number): Promise<TableResponse> {
  const [player, row] = await Promise.all([getPlayer(pool, userId, false), loadSession(pool, userId, false)]);
  return { balance: player.balance, session: row ? sessionInfo(row.id, row.state) : null, frames: [], closed: null };
}

/**
 * Сесть за стол: бай-ин списывается с баланса и сразу начинается первая раздача.
 * Повтор с тем же requestId не списывает бай-ин второй раз.
 */
export async function sit(
  userId: number,
  input: { buyIn: number; bots: number; requestId: string },
): Promise<TableResponse> {
  return withTransaction(async (db) => {
    const player = await getPlayer(db, userId, true);
    const game = await getGame(db);

    const previous = await db.query<{ game_id: number; amount: number }>(
      `SELECT game_id, amount FROM bets WHERE user_id = $1 AND request_id = $2`,
      [userId, input.requestId],
    );
    const prev = previous.rows[0];
    if (prev) {
      if (prev.game_id !== game.id || prev.amount !== input.buyIn) {
        throw new HttpError(409, 'request_id_reused', 'Этот requestId уже использован для другой операции');
      }
      const row = await loadSession(db, userId, false);
      return {
        balance: player.balance,
        session: row ? sessionInfo(row.id, row.state) : null,
        frames: [],
        closed: null,
        repeated: true,
      };
    }

    const seated = (await loadSession(db, userId, false)) !== null;
    checkCanSit(input.buyIn, limitsOf(game), player.balance, seated);

    // Деньги: баланс → стол.
    const bet = await db.query<{ id: number }>(
      `INSERT INTO bets (user_id, game_id, request_id, amount, bet_data)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        userId,
        game.id,
        input.requestId,
        input.buyIn,
        JSON.stringify({
          kind: 'poker_table',
          buyIn: input.buyIn,
          bots: input.bots,
          smallBlind: POKER_RULES.smallBlind,
          bigBlind: POKER_RULES.bigBlind,
        }),
      ],
    );
    const betId = bet.rows[0]!.id;
    await moveMoney(db, userId, betId, 'bet', -input.buyIn);

    const state = newSession(player.name, input.buyIn, input.bots);
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO poker_sessions (user_id, bet_id, state) VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [userId, betId, JSON.stringify(state)],
    );
    const row: SessionRow = { id: inserted.rows[0]!.id, bet_id: betId, state };
    return { ...(await saveAndRespond(db, userId, row, dealHand(state))), repeated: false };
  });
}

/** Ход игрока: fold / check / call / raise / allin. */
export async function act(userId: number, action: PlayerAction): Promise<TableResponse> {
  return withTransaction(async (db) => {
    await getPlayer(db, userId, true);
    const row = await requireSession(db, userId);
    return saveAndRespond(db, userId, row, playerAct(row.state, action));
  });
}

/** Следующая раздача за тем же столом. */
export async function nextHand(userId: number): Promise<TableResponse> {
  return withTransaction(async (db) => {
    await getPlayer(db, userId, true);
    const row = await requireSession(db, userId);
    if (row.state.table.stage !== 'finished') {
      throw new HttpError(409, 'hand_in_progress', 'Текущая раздача ещё не закончилась');
    }
    const game = await getGame(db);
    if (!game.is_active) {
      throw new HttpError(403, 'game_disabled', 'Покер отключён администратором — можно только встать из-за стола');
    }
    return saveAndRespond(db, userId, row, dealHand(row.state));
  });
}

/** Встать из-за стола: фишки со стола возвращаются на баланс. */
export async function leave(userId: number): Promise<TableResponse> {
  return withTransaction(async (db) => {
    await getPlayer(db, userId, true);
    const row = await requireSession(db, userId);
    const frames = foldAndFinish(row.state);
    await recordHand(db, userId, row);
    const closed = await closeSession(db, userId, row, playerStack(row.state) > 0 ? 'leave' : 'bust');
    const { balance } = await getPlayer(db, userId, false);
    return { balance, session: null, frames, closed };
  });
}

/** Последние раздачи игрока, новые сверху. */
export async function history(userId: number, limit: number): Promise<HandHistoryItem[]> {
  const { rows } = await pool.query<HandRow>(
    `SELECT id, hand_no, hole_cards, board, pot, invested, won,
            result_data->>'summary' AS summary, created_at
       FROM poker_hands
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    handNo: r.hand_no,
    holeCards: r.hole_cards,
    board: r.board,
    pot: r.pot,
    invested: r.invested,
    won: r.won,
    summary: r.summary ?? '',
    createdAt: r.created_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Внутренние шаги
// ---------------------------------------------------------------------------

/**
 * Общий конец запроса: закончившуюся раздачу пишем в историю; если у игрока
 * не осталось фишек — закрываем сессию; иначе сохраняем стол.
 */
async function saveAndRespond(db: Queryable, userId: number, row: SessionRow, frames: PublicView[]): Promise<TableResponse> {
  let closed: SessionClosed | null = null;
  if ((await recordHand(db, userId, row)) && playerStack(row.state) === 0) {
    closed = await closeSession(db, userId, row, 'bust');
  }
  if (!closed) {
    await db.query(`UPDATE poker_sessions SET state = $2::jsonb, updated_at = now() WHERE id = $1`, [
      row.id,
      JSON.stringify(row.state),
    ]);
  }
  const { balance } = await getPlayer(db, userId, false);
  return { balance, session: sessionInfo(row.id, row.state), frames, closed };
}

/** Записывает закончившуюся раздачу в poker_hands. Возвращает true, если запись была. */
async function recordHand(db: Queryable, userId: number, row: SessionRow): Promise<boolean> {
  const rec = takeHandRecord(row.state);
  if (!rec) return false;
  await db.query(
    `INSERT INTO poker_hands (session_id, user_id, hand_no, hole_cards, board, pot, invested, won, result_data)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb)`,
    [
      row.id,
      userId,
      rec.handNo,
      JSON.stringify(rec.holeCards),
      JSON.stringify(rec.board),
      rec.pot,
      rec.invested,
      rec.won,
      JSON.stringify(rec.resultData),
    ],
  );
  return true;
}

/** Деньги: стол → баланс. Рассчитывает ставку в bets и закрывает сессию. */
async function closeSession(
  db: Queryable,
  userId: number,
  row: SessionRow,
  reason: SessionClosed['reason'],
): Promise<SessionClosed> {
  const { closed, betResult } = closeSummary(row.state, reason);
  if (closed.cashOut > 0) await moveMoney(db, userId, row.bet_id, 'win', closed.cashOut);
  // won — со стола вернулись фишки (даже если меньше бай-ина), lost — всё проиграно.
  await db.query(
    `UPDATE bets SET payout = $2, status = $3, settled_at = now(), result_data = $4::jsonb WHERE id = $1`,
    [row.bet_id, closed.cashOut, closed.cashOut > 0 ? 'won' : 'lost', JSON.stringify(betResult)],
  );
  await db.query(
    `UPDATE poker_sessions
        SET status = 'closed', state = $2::jsonb, updated_at = now(), closed_at = now()
      WHERE id = $1`,
    [row.id, JSON.stringify(row.state)],
  );
  return closed;
}

/**
 * Меняет баланс и пишет запись в журнал одним запросом, как и остальной ScrumDrop:
 * users.balance — кеш, transactions — источник истины. Баланс не уходит в минус.
 */
async function moveMoney(db: Queryable, userId: number, betId: number, type: 'bet' | 'win', amount: number) {
  const { rows } = await db.query<{ balance_after: number }>(
    `WITH updated AS (
       UPDATE users SET balance = balance + $3::bigint
        WHERE id = $1 AND balance + $3::bigint >= 0
        RETURNING balance
     )
     INSERT INTO transactions (user_id, bet_id, type, amount, balance_after)
     SELECT $1::bigint, $2::bigint, $4::text, $3::bigint, balance FROM updated
     RETURNING balance_after`,
    [userId, betId, amount, type],
  );
  const row = rows[0];
  if (!row) throw new HttpError(402, 'insufficient_funds', 'Недостаточно монет на балансе');
  return row.balance_after;
}

// ---------------------------------------------------------------------------
// Чтение из БД
// ---------------------------------------------------------------------------

async function getGame(db: Queryable): Promise<GameRow> {
  const { rows } = await db.query<GameRow>(`SELECT id, min_bet, max_bet, is_active FROM games WHERE code = $1`, [
    POKER_RULES.gameCode,
  ]);
  const game = rows[0];
  if (!game) {
    throw new HttpError(503, 'poker_not_configured', 'Покер не настроен: в таблице games нет игры poker (см. db/seed.sql)');
  }
  return game;
}

/** forUpdate = true блокирует строку игрока до конца транзакции. */
async function getPlayer(db: Queryable, userId: number, forUpdate: boolean): Promise<PlayerRow> {
  const { rows } = await db.query<PlayerRow>(
    `SELECT id, COALESCE(display_name, username) AS name, balance FROM users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  const player = rows[0];
  if (!player) throw new HttpError(401, 'unauthorized', 'Войдите в аккаунт, чтобы продолжить');
  return player;
}

async function loadSession(db: Queryable, userId: number, forUpdate: boolean): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT id, bet_id, state FROM poker_sessions
      WHERE user_id = $1 AND status = 'active'${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  return rows[0] ?? null;
}

async function requireSession(db: Queryable, userId: number): Promise<SessionRow> {
  const row = await loadSession(db, userId, true);
  if (!row) throw new HttpError(404, 'not_seated', 'Вы не сидите за столом');
  ensureVersion(row.state);
  return row;
}
