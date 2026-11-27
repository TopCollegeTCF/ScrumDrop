// Интеграционные тесты API на настоящем PostgreSQL (временная база, см. harness.ts).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { api, ledgerMismatches, Player, pool, registered, useTestServer } from './harness.ts';

useTestServer();

describe('аккаунт', () => {
  test('регистрация: стартовые 100 монет, бонус в журнале и в bonuses, сразу вход', async () => {
    const player = new Player();
    const res = await player.post('/auth/register', {
      username: 'Demo',
      email: 'Demo@Example.com',
      password: 'correct-horse',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.user.username, 'Demo');
    assert.equal(res.data.user.email, 'demo@example.com');
    assert.equal(res.data.user.displayName, 'Demo');
    assert.equal(res.data.user.balance, 100);
    assert.deepEqual(res.data.user.stats, { opened: 0, uniqueItems: 0 });
    assert.match(player.cookie, /^sd_session=/);

    const session = await player.get('/auth/session');
    assert.equal(session.data.user.username, 'Demo');

    const { rows } = await pool.query(
      `SELECT t.type, t.amount, t.balance_after, b.bonus_type
         FROM users u JOIN transactions t ON t.user_id = u.id JOIN bonuses b ON b.user_id = u.id
        WHERE u.username = 'Demo'`,
    );
    assert.deepEqual(rows, [{ type: 'signup_bonus', amount: 100, balance_after: 100, bonus_type: 'signup_bonus' }]);
  });

  test('логин и почта уникальны без учёта регистра', async () => {
    const player = new Player();
    const sameName = await player.post('/auth/register', {
      username: 'demo',
      email: 'other@example.com',
      password: 'correct-horse',
    });
    assert.equal(sameName.status, 409);
    assert.equal(sameName.data.error.code, 'username_taken');

    const sameEmail = await player.post('/auth/register', {
      username: 'other',
      email: 'DEMO@example.com',
      password: 'correct-horse',
    });
    assert.equal(sameEmail.status, 409);
    assert.equal(sameEmail.data.error.code, 'email_taken');
  });

  test('проверка полей регистрации с русскими сообщениями', async () => {
    const player = new Player();
    const short = await player.post('/auth/register', { username: 'ab', email: 'a@b.ru', password: 'correct-horse' });
    assert.equal(short.status, 400);
    assert.equal(short.data.error.details.field, 'username');
    assert.match(short.data.error.message, /Логин/);

    const weak = await player.post('/auth/register', { username: 'abc', email: 'a@b.ru', password: '123' });
    assert.equal(weak.status, 400);
    assert.equal(weak.data.error.details.field, 'password');

    const email = await player.post('/auth/register', { username: 'abc', email: 'не почта', password: 'correct-horse' });
    assert.equal(email.status, 400);
    assert.equal(email.data.error.details.field, 'email');
  });

  test('вход по логину или почте, неверный пароль, выход', async () => {
    const player = new Player();
    const wrong = await player.post('/auth/login', { login: 'demo', password: 'wrong-password' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.error.message, 'Неверный логин или пароль');

    const unknown = await player.post('/auth/login', { login: 'nobody', password: 'wrong-password' });
    assert.equal(unknown.status, 401);

    const byName = await player.post('/auth/login', { login: 'DEMO', password: 'correct-horse' });
    assert.equal(byName.status, 200);
    assert.equal(byName.data.user.username, 'Demo');

    const byEmail = await new Player().post('/auth/login', { login: 'demo@example.com', password: 'correct-horse' });
    assert.equal(byEmail.status, 200);

    assert.equal((await player.post('/auth/logout')).status, 204);
    assert.equal(player.cookie, '');
    assert.equal((await player.get('/auth/session')).data.user, null);
    assert.equal((await player.get('/me')).status, 401);
  });

  test('подделанная cookie не даёт доступа', async () => {
    const player = new Player();
    player.cookie = 'sd_session=forged-token';
    assert.equal((await player.get('/me')).status, 401);
  });

  test('профиль: имя и аватарка сохраняются на сервере', async () => {
    const { player } = await registered();
    const res = await player.patch('/me', { displayName: '  Звёздный игрок ', avatar: 'moon' });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.displayName, 'Звёздный игрок');
    assert.equal(res.data.user.avatar, 'moon');
    assert.equal(res.data.user.avatarImage, 'cases/4.jpg');

    assert.equal((await player.patch('/me', { avatar: 'no_such_case' })).status, 400);
    assert.equal((await player.patch('/me', { displayName: '' })).status, 400);
    assert.equal((await player.patch('/me', {})).status, 400);
  });
});

describe('кейсы', () => {
  test('каталог: 10 кейсов по 30 монет, предметы с редкостью и шансами', async () => {
    const res = await new Player().get('/cases');
    assert.equal(res.status, 200);
    assert.equal(res.data.cases.length, 10);
    const orbit = res.data.cases[0];
    assert.equal(orbit.code, 'orbit');
    assert.equal(orbit.name, 'Орбита');
    assert.equal(orbit.price, 30);
    assert.equal(orbit.image, 'cases/0.jpg');
    assert.deepEqual(orbit.items, [
      { code: 'star', name: 'Звезда', rarity: 'common', chance: 0.75 },
      { code: 'crystal', name: 'Кристалл', rarity: 'rare', chance: 0.25 },
    ]);
    assert.equal((await new Player().get('/cases/unknown')).status, 404);
  });

  test('гость не может открыть кейс', async () => {
    const res = await new Player().post('/cases/orbit/open', { requestId: randomUUID() });
    assert.equal(res.status, 401);
  });

  test('открытие: −30 монет, предмет из этого кейса, запись в инвентаре и истории', async () => {
    const { player } = await registered();
    const requestId = randomUUID();
    const res = await player.post('/cases/orbit/open', { requestId });
    assert.equal(res.status, 201);
    assert.equal(res.data.balance, 70);
    assert.equal(res.data.repeated, false);
    assert.equal(res.data.opening.case.code, 'orbit');
    assert.ok(['star', 'crystal'].includes(res.data.opening.item.code));

    const inventory = await player.get('/inventory');
    assert.equal(inventory.data.items.length, 1);
    assert.equal(inventory.data.items[0].id, res.data.opening.inventoryItemId);
    assert.equal(inventory.data.summary[0].count, 1);

    const history = await player.get('/history');
    assert.equal(history.data.openings.length, 1);
    assert.equal(history.data.openings[0].price, 30);
    assert.equal(history.data.openings[0].case.name, 'Орбита');

    const me = await player.get('/me');
    assert.equal(me.data.user.balance, 70);
    assert.deepEqual(me.data.user.stats, { opened: 1, uniqueItems: 1 });
  });

  test('повтор того же requestId возвращает прежний результат без второго списания', async () => {
    const { player } = await registered();
    const requestId = randomUUID();
    const first = await player.post('/cases/leaf/open', { requestId });
    const again = await player.post('/cases/leaf/open', { requestId });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.data.repeated, true);
    assert.equal(again.data.opening.id, first.data.opening.id);
    assert.equal(again.data.opening.item.code, first.data.opening.item.code);
    assert.equal(again.data.balance, 70);
    assert.equal((await player.get('/inventory')).data.items.length, 1);

    const otherCase = await player.post('/cases/orbit/open', { requestId });
    assert.equal(otherCase.status, 409);
  });

  test('параллельный повтор одного requestId — одно списание', async () => {
    const { player } = await registered();
    const requestId = randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => player.post('/cases/moon/open', { requestId })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 201]);
    assert.equal(new Set(results.map((r) => r.data.opening.id)).size, 1);
    assert.equal((await player.get('/me')).data.user.balance, 70);
  });

  test('готовность спринта: три открытия за 90 оставляют 10, четвёртое отклоняется', async () => {
    const { player } = await registered();
    for (const code of ['orbit', 'leaf', 'orbit']) {
      assert.equal((await player.post(`/cases/${code}/open`, { requestId: randomUUID() })).status, 201);
    }
    const fourth = await player.post('/cases/orbit/open', { requestId: randomUUID() });
    assert.equal(fourth.status, 402);
    assert.equal(fourth.data.error.code, 'insufficient_funds');
    assert.equal(fourth.data.error.message, 'Недостаточно монет. Для открытия нужно 30.');
    assert.equal(fourth.data.error.details.balance, 10);

    const history = await player.get('/history');
    assert.equal(history.data.openings.length, 3);
    const inventory = await player.get('/inventory');
    const total = inventory.data.summary.reduce((sum: number, row: { count: number }) => sum + row.count, 0);
    assert.equal(total, 3);
    assert.equal((await player.get('/me')).data.user.balance, 10);
  });

  test('при балансе 30 из двух одновременных открытий проходит одно', async () => {
    const { player, user } = await registered();
    await pool.query(
      `WITH updated AS (UPDATE users SET balance = balance - 70 WHERE id = $1 RETURNING balance)
       INSERT INTO transactions (user_id, type, amount, balance_after)
       SELECT $1, 'admin_adjust', -70, balance FROM updated`,
      [user.id],
    );
    const results = await Promise.all(
      [1, 2].map(() => player.post('/cases/prism/open', { requestId: randomUUID() })),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 402]);
    assert.equal((await player.get('/me')).data.user.balance, 0);
    assert.equal((await player.get('/history')).data.openings.length, 1);
  });

  test('история и инвентарь видны только владельцу', async () => {
    const a = await registered('owner');
    const b = await registered('stranger');
    await a.player.post('/cases/flora/open', { requestId: randomUUID() });
    assert.equal((await b.player.get('/history')).data.openings.length, 0);
    assert.equal((await b.player.get('/inventory')).data.items.length, 0);

    const itemId = (await a.player.get('/inventory')).data.items[0].id;
    assert.equal((await b.player.post(`/inventory/${itemId}/upgrade`)).status, 404);
  });
});

describe('апгрейдер, кошелёк, мини-игра', () => {
  test('улучшение до +1 один раз', async () => {
    const { player } = await registered();
    const opened = await player.post('/cases/eclipse/open', { requestId: randomUUID() });
    const id = opened.data.opening.inventoryItemId;

    const upgraded = await player.post(`/inventory/${id}/upgrade`);
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.data.item.upgradeLevel, 1);
    assert.equal(upgraded.data.item.canUpgrade, false);

    const again = await player.post(`/inventory/${id}/upgrade`);
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'already_upgraded');
    assert.equal((await player.post('/inventory/999999/upgrade')).status, 404);
    assert.equal((await player.post('/inventory/abc/upgrade')).status, 400);

    const summary = (await player.get('/inventory')).data.summary;
    assert.equal(summary[0].upgradeLevel, 1);
  });

  test('демо-пополнение: начисление, журнал и защита от повтора', async () => {
    const { player } = await registered();
    const requestId = randomUUID();
    const first = await player.post('/wallet/top-up', { amount: 300, requestId });
    assert.equal(first.status, 201);
    assert.equal(first.data.balance, 400);

    const again = await player.post('/wallet/top-up', { amount: 300, requestId });
    assert.equal(again.status, 200);
    assert.equal(again.data.repeated, true);
    assert.equal(again.data.balance, 400);

    assert.equal((await player.post('/wallet/top-up', { amount: 500, requestId })).status, 409);
    assert.equal((await player.post('/wallet/top-up', { amount: 0, requestId: randomUUID() })).status, 400);
    assert.equal((await player.post('/wallet/top-up', { amount: 5000, requestId: randomUUID() })).status, 400);

    const wallet = await player.get('/wallet');
    assert.equal(wallet.data.balance, 400);
    assert.deepEqual(
      wallet.data.transactions.map((t: { type: string; amount: number }) => [t.type, t.amount]),
      [
        ['top_up', 300],
        ['signup_bonus', 100],
      ],
    );
  });

  test('рекорд реакции сохраняется только если он лучше', async () => {
    const { player } = await registered();
    assert.deepEqual((await player.post('/games/reaction', { timeMs: 320 })).data, {
      timeMs: 320,
      bestMs: 320,
      isRecord: true,
    });
    assert.deepEqual((await player.post('/games/reaction', { timeMs: 400 })).data, {
      timeMs: 400,
      bestMs: 320,
      isRecord: false,
    });
    assert.equal((await player.post('/games/reaction', { timeMs: 'fast' })).status, 400);
    assert.equal((await player.get('/me')).data.user.reactionBestMs, 320);
  });
});

describe('безопасность и целостность', () => {
  test('POST с чужого Origin отклоняется', async () => {
    const { player } = await registered();
    const res = await player.call('POST', '/cases/orbit/open', { requestId: randomUUID() }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });

  test('cookie сессии HttpOnly и SameSite=Lax, пароль хранится как bcrypt', async () => {
    const player = new Player();
    const res = await player.post('/auth/register', {
      username: 'cookiecheck',
      email: 'cookie@example.com',
      password: 'correct-horse',
    });
    const cookie = res.headers.getSetCookie().join(';');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE username = 'cookiecheck'`);
    assert.match(rows[0].password_hash, /^\$2[aby]\$/);
    const sessions = await pool.query(`SELECT token_hash FROM sessions`);
    assert.ok(sessions.rows.every((row) => !player.cookie.includes(row.token_hash)));
  });

  test('некорректный JSON и неизвестный метод API', async () => {
    const response = await fetch(`${api}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_json');
    assert.equal((await new Player().get('/nope')).status, 404);
  });

  test('баланс каждого игрока сходится с журналом транзакций', async () => {
    assert.equal(await ledgerMismatches(), 0);
  });
});
