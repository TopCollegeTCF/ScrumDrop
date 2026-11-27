-- ScrumDrop · начальная схема PostgreSQL
--
-- Запуск вручную:
--   psql -U postgres -d scrumdrop -f db/migrations/001_init.sql
--
-- Все суммы — целые фишки (BIGINT), все моменты времени — TIMESTAMPTZ (UTC).

BEGIN;

-- ---------------------------------------------------------------------------
-- users: игроки и администраторы
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      TEXT        NOT NULL,
    email         TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    balance       BIGINT      NOT NULL DEFAULT 0,
    role          TEXT        NOT NULL DEFAULT 'user',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,

    CONSTRAINT users_username_length
        CHECK (char_length(username) BETWEEN 3 AND 32),
    CONSTRAINT users_username_trimmed
        CHECK (username = btrim(username)),
    CONSTRAINT users_email_length
        CHECK (char_length(email) <= 254),
    CONSTRAINT users_email_trimmed
        CHECK (email = btrim(email)),
    CONSTRAINT users_email_format
        CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    CONSTRAINT users_password_hash_not_blank
        CHECK (btrim(password_hash) <> ''),
    CONSTRAINT users_balance_non_negative
        CHECK (balance >= 0),
    CONSTRAINT users_role_valid
        CHECK (role IN ('user', 'admin'))
);

-- Регистр не важен: Demo и demo — один и тот же пользователь.
CREATE UNIQUE INDEX users_username_unique_ci ON users (lower(username));
CREATE UNIQUE INDEX users_email_unique_ci ON users (lower(email));

COMMENT ON TABLE users IS 'Игроки и администраторы';
COMMENT ON COLUMN users.password_hash IS 'bcrypt/argon2-хеш; сам пароль не хранится';
COMMENT ON COLUMN users.balance IS 'Текущий баланс в фишках; источник истины — transactions';

-- ---------------------------------------------------------------------------
-- games: справочник игр
-- ---------------------------------------------------------------------------
CREATE TABLE games (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code       TEXT        NOT NULL,
    name       TEXT        NOT NULL,
    min_bet    BIGINT      NOT NULL,
    max_bet    BIGINT      NOT NULL,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT games_code_unique UNIQUE (code),
    CONSTRAINT games_code_format CHECK (code ~ '^[a-z0-9_]+$'),
    CONSTRAINT games_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT games_min_bet_positive CHECK (min_bet > 0),
    CONSTRAINT games_max_bet_gte_min CHECK (max_bet >= min_bet)
);

COMMENT ON TABLE games IS 'Справочник игр; is_active позволяет админу выключить игру';
COMMENT ON COLUMN games.code IS 'Машинный код: slots, roulette, blackjack, dice, poker, rocket, minedrop';
COMMENT ON COLUMN games.min_bet IS 'Минимальная ставка в фишках';
COMMENT ON COLUMN games.max_bet IS 'Максимальная ставка в фишках';

-- ---------------------------------------------------------------------------
-- bets: история ставок
-- ---------------------------------------------------------------------------
CREATE TABLE bets (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    game_id     BIGINT      NOT NULL REFERENCES games (id) ON DELETE RESTRICT,
    request_id  UUID,
    amount      BIGINT      NOT NULL,
    payout      BIGINT      NOT NULL DEFAULT 0,
    bet_data    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    result_data JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status      TEXT        NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at  TIMESTAMPTZ,

    CONSTRAINT bets_id_user_unique UNIQUE (id, user_id),
    CONSTRAINT bets_amount_positive CHECK (amount > 0),
    CONSTRAINT bets_payout_non_negative CHECK (payout >= 0),
    CONSTRAINT bets_status_valid CHECK (status IN ('pending', 'won', 'lost', 'void')),
    CONSTRAINT bets_bet_data_is_object CHECK (jsonb_typeof(bet_data) = 'object'),
    CONSTRAINT bets_result_data_is_object CHECK (jsonb_typeof(result_data) = 'object'),
    CONSTRAINT bets_pending_has_no_payout CHECK (status <> 'pending' OR payout = 0),
    CONSTRAINT bets_pending_has_no_settled_at CHECK (status <> 'pending' OR settled_at IS NULL),
    CONSTRAINT bets_lost_has_no_payout CHECK (status <> 'lost' OR payout = 0),
    CONSTRAINT bets_void_returns_stake CHECK (status <> 'void' OR payout = amount),
    CONSTRAINT bets_won_has_payout CHECK (status <> 'won' OR payout > 0),
    CONSTRAINT bets_settled_has_time CHECK (status = 'pending' OR settled_at IS NOT NULL),
    CONSTRAINT bets_settled_after_created CHECK (settled_at IS NULL OR settled_at >= created_at)
);

CREATE INDEX bets_user_created_idx ON bets (user_id, created_at DESC);
CREATE INDEX bets_game_created_idx ON bets (game_id, created_at DESC);

-- Идемпотентность: повтор запроса с тем же request_id не создаст вторую ставку.
CREATE UNIQUE INDEX bets_user_request_unique ON bets (user_id, request_id) WHERE request_id IS NOT NULL;

-- Незавершённые ставки: нужны для восстановления раундов «Ракеты» после сбоя.
CREATE INDEX bets_pending_idx ON bets (user_id, created_at) WHERE status = 'pending';

COMMENT ON TABLE bets IS 'История ставок; bet_data — что поставили, result_data — что выпало';
COMMENT ON COLUMN bets.request_id IS 'Необязательный idempotency-key клиента; защищает от двойной ставки при повторе запроса';
COMMENT ON COLUMN bets.payout IS 'Сколько вернули игроку: выигрыш или возврат ставки; 0 при проигрыше';
COMMENT ON COLUMN bets.status IS 'pending — раунд идёт; won/lost/void — расчёт завершён';
COMMENT ON COLUMN bets.bet_data IS 'Например: {"selection": "red"} или {"number": 17}';
COMMENT ON COLUMN bets.result_data IS 'Например: {"symbols": ["cherry", "cherry", "cherry"]}';

-- ---------------------------------------------------------------------------
-- transactions: журнал всех изменений баланса
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    bet_id        BIGINT,
    type          TEXT        NOT NULL,
    amount        BIGINT      NOT NULL,
    balance_after BIGINT      NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Ставка и транзакция должны принадлежать одному пользователю.
    CONSTRAINT transactions_bet_user_fk
        FOREIGN KEY (bet_id, user_id) REFERENCES bets (id, user_id) ON DELETE RESTRICT,
    CONSTRAINT transactions_type_valid
        CHECK (type IN ('bet', 'win', 'bonus', 'signup_bonus', 'admin_adjust', 'refund')),
    CONSTRAINT transactions_amount_non_zero CHECK (amount <> 0),
    CONSTRAINT transactions_balance_after_non_negative CHECK (balance_after >= 0),
    CONSTRAINT transactions_bet_type_requires_bet
        CHECK (type NOT IN ('bet', 'win', 'refund') OR bet_id IS NOT NULL),
    CONSTRAINT transactions_bet_amount_negative
        CHECK (type <> 'bet' OR amount < 0),
    CONSTRAINT transactions_win_amount_positive
        CHECK (type <> 'win' OR amount > 0),
    CONSTRAINT transactions_refund_amount_positive
        CHECK (type <> 'refund' OR amount > 0),
    CONSTRAINT transactions_bonus_amount_positive
        CHECK (type NOT IN ('bonus', 'signup_bonus') OR amount > 0)
);

CREATE INDEX transactions_user_created_idx ON transactions (user_id, created_at DESC);
CREATE INDEX transactions_bet_idx ON transactions (bet_id) WHERE bet_id IS NOT NULL;

-- Защита от двойного списания/начисления по одной ставке.
CREATE UNIQUE INDEX transactions_one_bet_per_bet ON transactions (bet_id) WHERE type = 'bet';
CREATE UNIQUE INDEX transactions_one_win_per_bet ON transactions (bet_id) WHERE type = 'win';
CREATE UNIQUE INDEX transactions_one_refund_per_bet ON transactions (bet_id) WHERE type = 'refund';

COMMENT ON TABLE transactions IS 'Журнал всех изменений баланса; сумма со знаком';
COMMENT ON COLUMN transactions.amount IS 'Отрицательная — списание, положительная — начисление';
COMMENT ON COLUMN transactions.balance_after IS 'Баланс пользователя сразу после этой операции';
COMMENT ON COLUMN transactions.type IS 'bet, win, bonus, signup_bonus, admin_adjust, refund';

-- ---------------------------------------------------------------------------
-- bonuses: выданные бонусы
-- ---------------------------------------------------------------------------
CREATE TABLE bonuses (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    bonus_type TEXT        NOT NULL DEFAULT 'bonus',
    amount     BIGINT      NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT bonuses_type_valid CHECK (bonus_type IN ('signup_bonus', 'bonus', 'promo')),
    CONSTRAINT bonuses_amount_positive CHECK (amount > 0)
);

CREATE INDEX bonuses_user_claimed_idx ON bonuses (user_id, claimed_at DESC);

-- Стартовый бонус можно получить только один раз.
CREATE UNIQUE INDEX bonuses_signup_once_per_user ON bonuses (user_id) WHERE bonus_type = 'signup_bonus';

COMMENT ON TABLE bonuses IS 'Выданные бонусы; каждое начисление также пишется в transactions';
COMMENT ON COLUMN bonuses.bonus_type IS 'signup_bonus, bonus или promo; в transactions это bonus/signup_bonus';

COMMIT;
