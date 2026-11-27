# Сервер ScrumDrop

Node.js + Express + PostgreSQL. Сервер отдаёт фронтенд из [`frontend/`](../frontend) и API по адресу `/api`.
Баланс, коллекция, история, имя, аватарка и покерный стол игрока хранятся в базе, а не в браузере.

## Запуск

Нужен Node.js 22.18 или новее: TypeScript запускается напрямую, без сборки.

```powershell
cd server
npm install
```

**1. База данных** — один из вариантов:

```powershell
docker compose up -d
```

Это команда из корня проекта, если установлен Docker. Без Docker можно запустить локальный PostgreSQL 16 в отдельном терминале:

```powershell
npm run db:local
```

`db:local` хранит данные в `server/.pgdata` и останавливается по Ctrl+C.

**2. Сервер:**

```powershell
npm run dev
```

Откройте http://localhost:3000. При старте сервер сам применяет миграции и справочники.
Чтобы открыть сайт с телефона в той же сети, используйте `http://<IP компьютера>:3000`.

Настройки — в `server/.env`, образец в [`.env.example`](.env.example). По умолчанию подходит строка подключения из `docker-compose.yml`.

| Команда | Что делает |
|---|---|
| `npm run dev` | Сервер с перезапуском при изменении кода |
| `npm start` | Сервер без перезапуска |
| `npm run db:local` | PostgreSQL без Docker |
| `npm run db:migrate` | Только применить миграции и сиды |
| `npm test` | Интеграционные тесты API на временной базе и тесты движка покера |
| `npm run typecheck` | Проверка типов TypeScript |

Тесты создают отдельную базу `scrumdrop_test_*` на том же сервере PostgreSQL и удаляют её после прогона, рабочие данные не трогают.

## Как устроено

```
server/src/
  index.ts          запуск: миграции → HTTP-сервер
  app.ts            Express: заголовки безопасности, /api, статика frontend/
  config.ts         настройки из окружения и server/.env
  db.ts             пул PostgreSQL и withTransaction
  migrate.ts        применение db/migrations/*.sql и db/seed.sql
  session.ts        сессии в cookie (в БД — только SHA-256 токена)
  users.ts          профиль игрока
  routes/
    auth.ts         регистрация, вход, выход, текущая сессия
    profile.ts      имя, аватарка, рекорд «Теста реакции»
    cases.ts        каталог и открытие кейса
    inventory.ts    коллекция, Апгрейдер, история
    wallet.ts       баланс, журнал, демо-пополнение
    poker.ts        покер: /api/poker
  poker/
    types.ts        состояние стола и ответы API покера
    cards.ts        колода, тасование через crypto.randomInt
    evaluator.ts    лучшая комбинация из 7 карт, названия по-русски
    engine.ts       правила холдема: блайнды, торговля, побочные банки, вскрытие
    bot.ts          боты: формула Чена до флопа, Монте-Карло после
    session.ts      посадка, раздача, ход, выход — без базы данных
    service.ts      стол в PostgreSQL, деньги через bets и transactions
```

Движок покера (`engine.ts`, `evaluator.ts`, `bot.ts`) — чистые функции без БД и HTTP, их проверяют тесты в `test/poker/`.

Правила работы с деньгами те же, что в [db/README.md](../db/README.md): баланс меняется только в транзакции БД вместе с записью в `transactions`, списание условное (`balance >= price`), повтор запроса с тем же `requestId` не списывает монеты второй раз.

## API

Все ответы — JSON. Ошибка выглядит так:

```json
{ "error": { "code": "insufficient_funds", "message": "Недостаточно монет. Для открытия нужно 30.", "details": { "price": 30, "balance": 10 } } }
```

`message` можно показывать пользователю как есть. Если ошибка относится к полю формы, в `details.field` будет его имя.

Вход хранится в cookie `sd_session` (HttpOnly, SameSite=Lax). Фронтенду достаточно `fetch(..., { credentials: 'include' })`. 🔒 — нужен вход, иначе `401`.

### Аккаунт

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/api/auth/session` | — | `{ user }` или `{ user: null }` для гостя |
| POST | `/api/auth/register` | `{ username, email, password }` | `201 { user }` + cookie; новому игроку 100 монет |
| POST | `/api/auth/login` | `{ login, password }` (логин или почта) | `{ user }` + cookie |
| POST | `/api/auth/logout` | — | `204` |
| GET 🔒 | `/api/me` | — | `{ user }` |
| PATCH 🔒 | `/api/me` | `{ displayName?, avatar? }` (avatar — код кейса) | `{ user }` |

`user`:

```json
{
  "id": 1, "username": "demo", "email": "demo@example.com", "displayName": "demo",
  "avatar": "prism", "avatarImage": "cases/5.jpg", "balance": 70, "role": "user",
  "reactionBestMs": null, "createdAt": "2026-11-27T12:00:00.000Z",
  "stats": { "opened": 1, "uniqueItems": 1 }
}
```

Ограничения: логин 3–32 символа (буквы, цифры, `.`, `-`, `_`), уникален без учёта регистра; пароль от 8 символов; почта уникальна. Ошибки: `409 username_taken`, `409 email_taken`, `401 invalid_credentials`, `429 too_many_requests`.

### Кейсы

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/api/cases` | — | `{ cases: [{ code, name, price, image, items: [{ code, name, rarity, chance }] }] }` |
| GET | `/api/cases/:code` | — | `{ case }` |
| POST 🔒 | `/api/cases/:code/open` | `{ requestId }` — UUID на одну попытку | `201 { opening, balance, repeated: false }` |

`opening`: `{ id, requestId, price, openedAt, case: { code, name, image }, item: { code, name, rarity }, inventoryItemId }`.

Повтор того же `requestId` возвращает `200` с прежним `opening` и `repeated: true`, монеты повторно не списываются. Клиент генерирует новый `requestId` для каждого нового открытия и переиспользует его только при повторе после сбоя сети. Ошибки: `404 case_not_found`, `402 insufficient_funds`, `409 request_id_reused` (тот же `requestId` для другого кейса).

### Коллекция и история

| Метод | Путь | Ответ |
|---|---|---|
| GET 🔒 | `/api/inventory` | `{ items: [{ id, item, case, upgradeLevel, canUpgrade, acquiredAt }], summary: [{ code, name, rarity, upgradeLevel, count }] }` |
| POST 🔒 | `/api/inventory/:id/upgrade` | `{ item }`; `409 already_upgraded`, `404 item_not_found` |
| GET 🔒 | `/api/history?limit=50&before=<id>` | `{ openings: [opening], nextBefore }`, новые сверху |

### Кошелёк

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET 🔒 | `/api/wallet` | — | `{ balance, topUp: { enabled, max, presets }, transactions }`; у операций `caseName` или `gameName` |
| POST 🔒 | `/api/wallet/top-up` | `{ amount, requestId }` | `201 { balance, transaction, repeated }` |

Пополнение — **демо**: начисляет виртуальные монеты без карты и платежей. Включается `DEMO_TOP_UP=true` (по умолчанию включено везде, кроме `NODE_ENV=production`), сумма за раз — до `TOP_UP_MAX`. Когда появится настоящий платёжный провайдер, начисление нужно перенести в обработчик его подтверждения (webhook), а этот метод выключить.

### Мини-игра

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST 🔒 | `/api/games/reaction` | `{ timeMs }` | `{ timeMs, bestMs, isRecord }` |

### Покер

Техасский холдем (No-Limit) против 1–5 ботов, блайнды 1/2. Фишки за столом — те же монеты, что на балансе: бай-ин списывается при посадке, а когда игрок встаёт, все фишки со стола возвращаются на баланс. Если закрыть вкладку, стол не пропадёт: при следующем заходе игрок вернётся к нему.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET 🔒 | `/api/poker/config` | — | `{ playerName, balance, minBuyIn, maxBuyIn, smallBlind, bigBlind, maxBots, isActive, bots }` |
| GET 🔒 | `/api/poker/state` | — | `TableResponse` — текущий стол или `session: null` |
| POST 🔒 | `/api/poker/sit` | `{ buyIn, bots, requestId }` | `201 TableResponse`; повтор `requestId` — `200` и `repeated: true` |
| POST 🔒 | `/api/poker/action` | `{ type: "fold" \| "check" \| "call" \| "raise" \| "allin", amount? }` | `TableResponse` |
| POST 🔒 | `/api/poker/next-hand` | — | `TableResponse` |
| POST 🔒 | `/api/poker/leave` | — | `TableResponse` с `closed: { reason, cashOut, profit }` |
| GET 🔒 | `/api/poker/history?limit=12` | — | `{ hands: [{ handNo, holeCards, board, pot, invested, won, summary, createdAt }] }` |

`TableResponse`: `{ balance, session: { id, buyIn, stats, view } | null, frames, closed }`. `balance` — монеты вне стола. `view` — стол глазами игрока: карты ботов скрыты до вскрытия, колоды в ответе нет. `frames` — промежуточные состояния после каждого хода бота, клиент показывает их по очереди. `amount` у `raise` — «рейз до», то есть итоговая ставка игрока на улице. Карта — строка из ранга и масти: `As` — туз пик, `Td` — десятка бубен.

Когда у игрока кончаются фишки, сессия закрывается сама: в ответе `closed.reason = "bust"`, а `session` ещё содержит последнюю раздачу.

Ошибки: `400 invalid_buy_in` (бай-ин вне `games.min_bet…max_bet`), `402 insufficient_funds`, `409 already_seated`, `404 not_seated`, `400 invalid_move` (ход не по правилам, сообщение объясняет почему), `409 hand_in_progress`, `403 game_disabled` (покер выключен в `games.is_active`; встать из-за стола можно и тогда).

### Служебное

`GET /api/health` → `{ "status": "ok" }`, если сервер видит базу.

## Безопасность

- Пароли — bcrypt; сессионный токен хранится в БД только как SHA-256.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` при `NODE_ENV=production`.
- POST/PATCH с чужого `Origin` отклоняются (`403`), на вход и регистрацию стоит ограничение частоты.
- Случайный предмет выбирает сервер (`crypto.randomInt`), клиент на результат не влияет. Колоду покера тасует сервер тем же генератором, а колода и карты ботов в ответы не попадают.
- Заголовки CSP, `X-Frame-Options`, `nosniff`.
