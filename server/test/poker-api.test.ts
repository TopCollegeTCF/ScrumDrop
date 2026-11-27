// Покер через API на настоящем PostgreSQL: бай-ин с баланса, игра, выход, проигрыш, журнал.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { Card } from '../src/poker/types.ts';
import { ledgerMismatches, Player, pool, registered, useTestServer } from './harness.ts';
import { rig } from './poker/helpers.ts';

useTestServer();

const h = (s: string) => s.split(' ') as Card[];

/** Никакой кадр не раскрывает колоду или карты ботов до вскрытия. */
function checkHidden(resp: any) {
  const views = [...resp.frames, ...(resp.session ? [resp.session.view] : [])];
  for (const view of views) {
    assert.equal(JSON.stringify(view).includes('deck'), false, 'колода не уходит клиенту');
    const showdown = view.stage === 'finished' && view.result?.showdown;
    for (const seat of view.seats) {
      if (!seat.isYou && !showdown) assert.ok(seat.cards.every((c: unknown) => c === null), 'карты ботов скрыты');
    }
  }
}

async function ok(player: Player, path: string, body?: unknown, status = 200) {
  const res = await player.post(path, body);
  assert.equal(res.status, status, `${path}: ${JSON.stringify(res.data)}`);
  checkHidden(res.data);
  return res.data;
}

const sit = (player: Player, buyIn: number, bots: number, requestId = randomUUID()) =>
  player.post('/poker/sit', { buyIn, bots, requestId });

/** Осторожная игра: чек, колл не больше большого блайнда, иначе фолд — за несколько раздач не проиграть бай-ин. */
const careful = (legal: any) =>
  legal.canCheck ? { type: 'check' } : legal.callAmount <= 2 ? { type: 'call' } : { type: 'fold' };

/** Играет осторожно, пока не сыграет hands раздач. */
async function playPassive(player: Player, start: any, hands: number) {
  let resp = start;
  let played = 0;
  while (resp.session && !resp.closed) {
    const view = resp.session.view;
    if (view.stage === 'finished') {
      played += 1;
      if (played >= hands) break;
      resp = await ok(player, '/poker/next-hand');
      continue;
    }
    assert.ok(view.legal, 'после ответа сервера ход за игроком');
    resp = await ok(player, '/poker/action', careful(view.legal));
  }
  return resp;
}

/** Раздаёт, пока ход не дойдёт до игрока до флопа (боты могли сбросить карты сразу). */
async function untilPreflopTurn(player: Player, start: any) {
  let resp = start;
  for (let i = 0; i < 50 && !(resp.session.view.stage === 'preflop' && resp.session.view.legal); i++) {
    resp = resp.session.view.stage === 'finished'
      ? await ok(player, '/poker/next-hand')
      : await ok(player, '/poker/action', careful(resp.session.view.legal));
  }
  assert.ok(resp.session.view.legal);
  return resp;
}

async function balanceOf(userId: number) {
  const { rows } = await pool.query(`SELECT balance FROM users WHERE id = $1`, [userId]);
  return rows[0].balance as number;
}

describe('покер', () => {
  test('гостю покер недоступен', async () => {
    const guest = new Player();
    assert.equal((await guest.get('/poker/config')).status, 401);
    assert.equal((await guest.get('/poker/state')).status, 401);
    assert.equal((await sit(guest, 40, 1)).status, 401);
  });

  test('настройки стола: блайнды 1/2, бай-ин 40–400, баланс монет игрока', async () => {
    const { player, username } = await registered('pkcfg');
    const { status, data } = await player.get('/poker/config');
    assert.equal(status, 200);
    assert.equal(data.playerName, username);
    assert.equal(data.balance, 100);
    assert.equal(data.smallBlind, 1);
    assert.equal(data.bigBlind, 2);
    assert.equal(data.minBuyIn, 40);
    assert.equal(data.maxBuyIn, 400);
    assert.equal(data.isActive, true);
    assert.equal(data.bots.length, data.maxBots);
    assert.equal('demoMode' in data, false);
    const state = await player.get('/poker/state');
    assert.deepEqual(state.data, { balance: 100, session: null, frames: [], closed: null });
  });

  test('проверка бай-ина и полей посадки', async () => {
    const { player } = await registered('pkval');
    let res = await sit(player, 30, 1);
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'invalid_buy_in');
    res = await sit(player, 200, 1);
    assert.equal(res.status, 402);
    assert.equal(res.data.error.code, 'insufficient_funds');
    assert.deepEqual(res.data.error.details, { buyIn: 200, balance: 100 });
    res = await sit(player, 40, 0);
    assert.equal(res.status, 400);
    assert.equal(res.data.error.details.field, 'bots');
    res = await player.post('/poker/sit', { buyIn: 40, bots: 1 });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.details.field, 'requestId');
    assert.equal((await player.post('/poker/action', { type: 'call' })).status, 404);
    assert.equal(await balanceOf((await player.get('/me')).data.user.id), 100);
  });

  test('сел, сыграл, встал: бай-ин списан, фишки вернулись, всё в журнале', async () => {
    const { player, user } = await registered('pkplay');
    const requestId = randomUUID();
    const first = await sit(player, 100, 3, requestId);
    assert.equal(first.status, 201, JSON.stringify(first.data));
    checkHidden(first.data);
    assert.equal(first.data.balance, 0);
    assert.equal(first.data.repeated, false);
    assert.equal(first.data.session.buyIn, 100);
    assert.equal(first.data.session.view.seats.length, 4);
    assert.equal(first.data.session.view.bigBlind, 2);

    // Повтор того же запроса (сбой сети) не списывает бай-ин второй раз.
    const again = await sit(player, 100, 3, requestId);
    assert.equal(again.status, 200);
    assert.equal(again.data.repeated, true);
    assert.equal(again.data.session.id, first.data.session.id);
    assert.equal(again.data.balance, 0);
    assert.equal((await sit(player, 100, 3)).status, 409, 'второй стол с новым requestId нельзя');

    const { rows: bets } = await pool.query(
      `SELECT b.amount, b.status, b.request_id, g.code FROM bets b JOIN games g ON g.id = b.game_id WHERE b.user_id = $1`,
      [user.id],
    );
    assert.deepEqual(bets, [{ amount: 100, status: 'pending', request_id: requestId, code: 'poker' }]);

    const nextTooEarly = first.data.session.view.stage === 'finished' ? null : await player.post('/poker/next-hand');
    if (nextTooEarly) assert.equal(nextTooEarly.status, 409);

    const played = await playPassive(player, first.data, 6);
    assert.equal(played.closed, null, 'осторожной игрой за 6 раздач не проиграть 100');
    const stack = played.session.view.seats.find((s: any) => s.isYou).stack;
    const handsPlayed = played.session.stats.handsPlayed;
    assert.ok(handsPlayed >= 6);

    const left = await ok(player, '/poker/leave');
    assert.equal(left.session, null);
    assert.equal(left.closed.reason, 'leave');
    assert.equal(left.closed.cashOut, stack);
    assert.equal(left.closed.profit, stack - 100);
    assert.equal(left.balance, stack);
    assert.equal(await balanceOf(user.id), stack);
    assert.equal((await player.get('/poker/state')).data.session, null);
    assert.equal((await player.post('/poker/leave')).status, 404);

    const { rows: settled } = await pool.query(
      `SELECT amount, payout, status, settled_at IS NOT NULL AS settled, result_data->>'reason' AS reason
         FROM bets WHERE user_id = $1`,
      [user.id],
    );
    assert.deepEqual(settled, [{ amount: 100, payout: stack, status: 'won', settled: true, reason: 'leave' }]);

    const { rows: journal } = await pool.query(
      `SELECT type, amount FROM transactions WHERE user_id = $1 AND bet_id IS NOT NULL ORDER BY id`,
      [user.id],
    );
    assert.deepEqual(journal, [
      { type: 'bet', amount: -100 },
      { type: 'win', amount: stack },
    ]);

    const wallet = await player.get('/wallet');
    assert.equal(wallet.data.transactions[0].gameName, 'Покер (Техасский холдем)');

    const historyRes = await player.get('/poker/history?limit=100');
    assert.equal(historyRes.status, 200);
    assert.equal(historyRes.data.hands.length, handsPlayed);
    const lastHand = historyRes.data.hands[0];
    assert.equal(lastHand.holeCards.length, 2);
    assert.ok(lastHand.summary.length > 0);
    const { rows: count } = await pool.query(`SELECT count(*)::int AS n FROM poker_hands WHERE user_id = $1`, [user.id]);
    assert.equal(count[0].n, handsPlayed);
    assert.equal(await ledgerMismatches(), 0);
  });

  test('ход по правилам: неизвестное действие, рейз без суммы и вне диапазона', async () => {
    const { player } = await registered('pkmove');
    const start = await sit(player, 100, 1);
    assert.equal(start.status, 201);
    const resp = await untilPreflopTurn(player, start.data);
    const legal = resp.session.view.legal;

    let res = await player.post('/poker/action', { type: 'jump' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.message, 'Неизвестное действие');
    res = await player.post('/poker/action', { type: 'raise' });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.details.field, 'amount');
    res = await player.post('/poker/action', { type: 'raise', amount: legal.maxRaiseTo + 1 });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'invalid_move');
    assert.equal((await player.post('/poker/next-hand')).status, 409);

    // Ошибочные ходы ничего не изменили.
    const state = await player.get('/poker/state');
    assert.deepEqual(state.data.session.view, resp.session.view);
    await ok(player, '/poker/leave');
    assert.equal(await ledgerMismatches(), 0);
  });

  test('проиграл все фишки: сессия закрывается, ставка проиграна, выигрыша в журнале нет', async () => {
    const { player, user } = await registered('pkbust');
    const start = await sit(player, 40, 1);
    assert.equal(start.status, 201);
    const resp = await untilPreflopTurn(player, start.data);

    // Подтасовываем колоду в базе: у бота тузы, у игрока 7-2, борд игроку не помогает.
    // Стек бота больше, чтобы олл-ин игрока покрывался целиком.
    const { rows } = await pool.query(`SELECT id, state FROM poker_sessions WHERE user_id = $1 AND status = 'active'`, [
      user.id,
    ]);
    const state = rows[0].state;
    rig(state.table, [h('7c 2d'), h('As Ah')], h('Kd Qs 9h 4c 3s'));
    state.table.seats[1].stack += 1000;
    await pool.query(`UPDATE poker_sessions SET state = $2 WHERE id = $1`, [rows[0].id, state]);

    const playerStack = resp.session.view.seats.find((s: any) => s.isYou).stack;
    const end = await ok(player, '/poker/action', { type: 'allin' });
    assert.equal(end.closed.reason, 'bust');
    assert.equal(end.closed.cashOut, 0);
    assert.equal(end.closed.profit, -40);
    assert.equal(end.session.view.stage, 'finished', 'последняя раздача видна до выхода в лобби');
    assert.equal(end.session.view.result.showdown, true);
    assert.ok(playerStack > 0);
    assert.equal(end.balance, 60);
    assert.equal((await player.get('/poker/state')).data.session, null);

    const { rows: bet } = await pool.query(`SELECT payout, status, result_data->>'reason' AS reason FROM bets WHERE user_id = $1`, [
      user.id,
    ]);
    assert.deepEqual(bet, [{ payout: 0, status: 'lost', reason: 'bust' }]);
    const { rows: wins } = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'win'`, [
      user.id,
    ]);
    assert.equal(wins[0].n, 0);
    // Можно сесть снова.
    assert.equal((await sit(player, 40, 1)).status, 201);
    assert.equal(await ledgerMismatches(), 0);
  });

  test('две одновременные посадки — один бай-ин', async () => {
    const { player, user } = await registered('pkrace');
    const results = await Promise.all([sit(player, 50, 2), sit(player, 50, 2)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(await balanceOf(user.id), 50);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM poker_sessions WHERE user_id = $1`, [user.id]);
    assert.equal(rows[0].n, 1);
    await ok(player, '/poker/leave');
    assert.equal(await ledgerMismatches(), 0);
  });

  test('админ выключил покер: сесть и раздать нельзя, встать можно', async () => {
    const { player } = await registered('pkoff');
    const start = await sit(player, 40, 1);
    assert.equal(start.status, 201);
    await pool.query(`UPDATE games SET is_active = false WHERE code = 'poker'`);
    try {
      const other = await registered('pkoff');
      const res = await sit(other.player, 40, 1);
      assert.equal(res.status, 403);
      assert.equal(res.data.error.code, 'game_disabled');
      assert.equal((await other.player.get('/poker/config')).data.isActive, false);
      const left = await ok(player, '/poker/leave');
      assert.equal(left.closed.reason, 'leave');
    } finally {
      await pool.query(`UPDATE games SET is_active = true WHERE code = 'poker'`);
    }
    assert.equal(await ledgerMismatches(), 0);
  });

  test('стол виден только владельцу', async () => {
    const a = await registered('pkown');
    const b = await registered('pkown');
    assert.equal((await sit(a.player, 40, 1)).status, 201);
    assert.equal((await b.player.get('/poker/state')).data.session, null);
    assert.equal((await b.player.post('/poker/leave')).status, 404);
    assert.deepEqual((await b.player.get('/poker/history')).data.hands, []);
    await ok(a.player, '/poker/leave');
  });
});
