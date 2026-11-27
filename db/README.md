# База данных ScrumDrop

PostgreSQL-схема для казино: пользователи, игры, ставки, журнал баланса и бонусы.

## Быстрый старт

### Docker

```bash
docker compose up -d
```

Compose поднимает PostgreSQL 16 на `localhost:5432`. При первом запуске автоматически выполняются:

- `db/migrations/001_init.sql` — таблицы, ограничения, индексы;
- `db/seed.sql` — семь игр.

Строка подключения:

```text
postgresql://scrumdrop:scrumdrop@localhost:5432/scrumdrop
```

Остановить базу:

```bash
docker compose down
```

Удалить данные и создать всё заново:

```bash
docker compose down -v
docker compose up -d
```

`down -v` удаляет volume с данными. Init-скрипты выполняются только при создании пустого volume.

### Без Docker

```bash
createdb -U postgres scrumdrop
psql -U postgres -d scrumdrop -f db/migrations/001_init.sql
psql -U postgres -d scrumdrop -f db/seed.sql
```

Если база уже создана и нужно начать с нуля:

```bash
dropdb -U postgres scrumdrop
createdb -U postgres scrumdrop
psql -U postgres -d scrumdrop -f db/migrations/001_init.sql
psql -U postgres -d scrumdrop -f db/seed.sql
```

## Схема

```mermaid
erDiagram
    users ||--o{ bets : "делает"
    games ||--o{ bets : "в игре"
    users ||--o{ transactions : "журнал"
    bets ||--o{ transactions : "списание и выигрыш"
    users ||--o{ bonuses : "получает"

    users {
        bigint id PK
        text username UK
        text email UK
        text password_hash
        bigint balance
        text role
        timestamptz created_at
        timestamptz last_login_at
    }

    games {
        bigint id PK
        text code UK
        text name
        bigint min_bet
        bigint max_bet
        boolean is_active
        timestamptz created_at
    }

    bets {
        bigint id PK
        bigint user_id FK
        bigint game_id FK
        uuid request_id
        bigint amount
        bigint payout
        jsonb bet_data
        jsonb result_data
        text status
        timestamptz created_at
        timestamptz settled_at
    }

    transactions {
        bigint id PK
        bigint user_id FK
        bigint bet_id FK
        text type
        bigint amount
        bigint balance_after
        timestamptz created_at
    }

    bonuses {
        bigint id PK
        bigint user_id FK
        text bonus_type
        bigint amount
        timestamptz claimed_at
    }
```

## Таблицы

### `users`

Игроки и администраторы.

| Поле | Смысл |
|---|---|
| `username` | Уникальный логин, регистр не важен |
| `email` | Уникальная почта, регистр не важен |
| `password_hash` | Только bcrypt/argon2-хеш, не пароль |
| `balance` | Баланс в фишках, не может быть отрицательным |
| `role` | `user` или `admin` |
| `last_login_at` | Время последнего входа |

Уникальность логина и почты сделана через индексы по `lower(...)`, поэтому `Demo` и `demo` — один пользователь. При входе ищите так:

```sql
SELECT * FROM users WHERE lower(username) = lower($1);
```

### `games`

Справочник игр. `code` — машинный код (`slots`, `roulette`, `blackjack`, `dice`, `poker`, `rocket`, `minedrop`), `name` — подпись для интерфейса. `is_active = FALSE` означает, что игра выключена админом.

### `bets`

Одна запись — одна ставка (раунд).

| Поле | Смысл |
|---|---|
| `request_id` | Необязательный ключ идемпотентности от клиента |
| `amount` | Сколько поставили |
| `payout` | Сколько вернули: выигрыш или возврат ставки; `0` при проигрыше |
| `bet_data` | JSONB: на что ставили, например `{"selection": "red"}` |
| `result_data` | JSONB: что выпало, например `{"number": 17}` |
| `status` | `pending`, `won`, `lost` или `void` |
| `settled_at` | Когда ставка рассчитана |

`pending` нужен для игр вроде «Ракеты»: ставка уже списана, но раунд ещё идёт. У `pending` `payout = 0` и `settled_at` пустой; у `won`/`lost`/`void` время расчёта заполнено. Для мгновенных игр ставку можно сразу записывать как `won`/`lost`.

`request_id` — необязательный UUID, который клиент присылает вместе с запросом на ставку. Если запрос повторится (двойной клик, retry), уникальный индекс `(user_id, request_id)` не даст создать вторую ставку.

### `transactions`

Журнал всех изменений баланса. Это источник истины для денег.

| Поле | Смысл |
|---|---|
| `type` | `bet`, `win`, `bonus`, `signup_bonus`, `admin_adjust`, `refund` |
| `amount` | Со знаком: `-` списание, `+` начисление |
| `balance_after` | Баланс сразу после операции |
| `bet_id` | Ссылка на ставку; пустая у бонусов и ручных корректировок |

`refund` добавлен для отмены раунда: например, сервер упал во время «Ракеты», ставку нужно вернуть. В исходном списке из issue его не было, но без него `void`-ставку нечем закрыть.

### `bonuses`

Выданные бонусы. `bonus_type` — `signup_bonus`, `bonus` или `promo`. Стартовый бонус можно получить только один раз: это защищает частичный уникальный индекс. Каждое начисление должно также попадать в `transactions` с типом `bonus` или `signup_bonus`.

## Правила

- `payout` — валовая сумма возврата. Если поставили 100 и выиграли 250, то `payout = 250`, а чистый выигрыш — `150`. В журнале будет `-100` (`bet`) и `+250` (`win`).
- `users.balance` — быстрый кэш для интерфейса. Источник истины — сумма `transactions.amount`.
- Все изменения баланса делаются в одной транзакции БД вместе с записью в `transactions`.
- Баланс нельзя уводить в минус: это проверяет `CHECK (balance >= 0)` и условие `balance >= amount` при списании.
- Журнал append-only: транзакции не редактируются и не удаляются. Для отмены ставки используйте `status = 'void'` и `refund`.

Проверка, что баланс сходится с журналом:

```sql
SELECT u.id, u.username, u.balance, COALESCE(SUM(t.amount), 0) AS ledger_balance
FROM users u
LEFT JOIN transactions t ON t.user_id = u.id
GROUP BY u.id, u.username, u.balance
HAVING u.balance <> COALESCE(SUM(t.amount), 0);
```

Если запрос что-то вернул — баланс и журнал разошлись.

## Как менять баланс

### Списание ставки

```sql
BEGIN;

-- 1. Создаём ставку. request_id клиент генерирует один раз на попытку.
INSERT INTO bets (user_id, game_id, request_id, amount, bet_data)
VALUES (1, 1, '3f0c8f0e-7a6b-4c2d-9e1f-1234567890ab', 100, '{"selection": "red"}')
RETURNING id; -- например, 42

-- 2. Списываем ставку и пишем журнал одной операцией.
WITH updated AS (
    UPDATE users
       SET balance = balance - 100
     WHERE id = 1
       AND balance >= 100
    RETURNING balance
)
INSERT INTO transactions (user_id, bet_id, type, amount, balance_after)
SELECT 1, 42, 'bet', -100, balance
FROM updated;

COMMIT;
```

`UPDATE ... WHERE balance >= 100` блокирует строку пользователя и не даёт уйти в минус даже при двух одновременных запросах. Если `INSERT` вставил 0 строк, денег не хватило — транзакцию нужно откатить.

### Начисление выигрыша

```sql
BEGIN;

UPDATE bets
   SET status = 'won',
       payout = 250,
       result_data = '{"symbols": ["cherry", "cherry", "cherry"]}',
       settled_at = now()
 WHERE id = 42
   AND status = 'pending';

WITH updated AS (
    UPDATE users
       SET balance = balance + 250
     WHERE id = 1
    RETURNING balance
)
INSERT INTO transactions (user_id, bet_id, type, amount, balance_after)
SELECT 1, 42, 'win', 250, balance
FROM updated;

COMMIT;
```

`UPDATE ... WHERE id = 42 AND status = 'pending'` должен обновить ровно одну строку. Если обновилось 0 строк, ставка уже рассчитана — начислять выигрыш нельзя. Уникальный индекс `transactions_one_win_per_bet` дополнительно не даст записать второй `win` по той же ставке.

### Стартовый бонус

Создайте пользователя с `balance = 0`, затем начислите бонус через `transactions`:

```sql
BEGIN;

INSERT INTO users (username, email, password_hash)
VALUES ('demo', 'demo@example.com', '<bcrypt-hash>')
RETURNING id; -- например, 1

WITH updated AS (
    UPDATE users SET balance = balance + 100 WHERE id = 1 RETURNING balance
)
INSERT INTO transactions (user_id, type, amount, balance_after)
SELECT 1, 'signup_bonus', 100, balance FROM updated;

COMMIT;
```

Так журнал сразу сходится с балансом. Не задавайте стартовый баланс напрямую в `INSERT INTO users`, иначе `balance_after` и сумма журнала разойдутся. Для стартового бонуса также добавьте строку в `bonuses` с `bonus_type = 'signup_bonus'`.

### Админ

```sql
UPDATE users SET role = 'admin' WHERE lower(username) = lower('demo');
```

## Ограничения и индексы

Что уже защищено на уровне БД:

- уникальные `username` и `email` без учёта регистра;
- один `signup_bonus` на пользователя;
- `balance >= 0`, `amount > 0`, `payout >= 0`;
- `min_bet <= max_bet`, `min_bet > 0`;
- допустимые `role`, `status`, `type`;
- `bet_data` и `result_data` — именно JSON-объекты, не массивы и не строки;
- у `bet`-транзакции сумма отрицательная, у `win`/`refund` — положительная;
- транзакция и её ставка принадлежат одному пользователю (составной FK);
- одна `bet`-, одна `win`- и одна `refund`-транзакция на ставку;
- уникальная пара `(user_id, request_id)`, если `request_id` передан;
- быстрые выборки истории по пользователю и игре, отдельный индекс для `pending`-ставок.

Проверки, которые остаются на стороне приложения:

- `games.is_active` перед созданием ставки;
- `amount` в пределах `min_bet`/`max_bet`;
- сгенерировать `request_id` на клиенте и переиспользовать его при повторе запроса;
- что `bets.amount` совпадает с `-transactions.amount` для типа `bet`;
- что `payout` совпадает с суммой `win`/`refund`-транзакций;
- что `bonuses.amount` совпадает с суммой соответствующей `bonus`/`signup_bonus`-транзакции;
- правила игр и ГСЧ.

## Что не входит

- Аутентификация, сессии и токены — на стороне приложения.
- ГСЧ и игровая логика — на стороне приложения.
- Реальные деньги, депозиты и выводы — фишки виртуальные.
- Сложные ставки (split/double-down в блэкджеке, несколько кругов торговли в покере) — текущая модель `bets` = одна ставка на раунд; для них понадобится расширение схемы.
- Миграционный инструмент (Flyway, Liquibase, Prisma) — пока один SQL-файл. Когда схема начнёт меняться, файлы миграций нужно добавлять с новыми номерами.
