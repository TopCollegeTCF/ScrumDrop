-- ScrumDrop · 002: аккаунты, сессии, кейсы, инвентарь, пополнение
--
-- Запуск вручную (после 001_init.sql):
--   psql -U postgres -d scrumdrop -f db/migrations/002_cases_auth.sql
--
-- Миграция идемпотентна: повторный запуск ничего не ломает. Это нужно потому,
-- что docker-entrypoint применяет её сам, а сервер (npm run db:migrate)
-- затем отмечает её в schema_migrations.

BEGIN;

-- ---------------------------------------------------------------------------
-- users: профиль для интерфейса
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar           TEXT NOT NULL DEFAULT 'prism';
ALTER TABLE users ADD COLUMN IF NOT EXISTS reaction_best_ms INTEGER;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_display_name_valid;
ALTER TABLE users ADD CONSTRAINT users_display_name_valid
    CHECK (display_name IS NULL
           OR (char_length(display_name) BETWEEN 1 AND 24 AND display_name = btrim(display_name)));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_format;
ALTER TABLE users ADD CONSTRAINT users_avatar_format CHECK (avatar ~ '^[a-z0-9_]+$');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_reaction_best_positive;
ALTER TABLE users ADD CONSTRAINT users_reaction_best_positive
    CHECK (reaction_best_ms IS NULL OR reaction_best_ms > 0);

COMMENT ON COLUMN users.display_name IS 'Имя игрока в интерфейсе; NULL — показывать username';
COMMENT ON COLUMN users.avatar IS 'Код кейса, картинка которого служит аватаркой';
COMMENT ON COLUMN users.reaction_best_ms IS 'Рекорд мини-игры «Тест реакции», мс';

-- ---------------------------------------------------------------------------
-- sessions: входы в аккаунт (cookie хранит токен, в БД — только его SHA-256)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT sessions_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

COMMENT ON TABLE sessions IS 'Активные сессии; сам токен не хранится, только SHA-256';

-- ---------------------------------------------------------------------------
-- cases, items, case_items: каталог кейсов и возможные награды
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code       TEXT        NOT NULL,
    name       TEXT        NOT NULL,
    price      BIGINT      NOT NULL,
    image      TEXT        NOT NULL,
    sort_order INTEGER     NOT NULL DEFAULT 0,
    is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT cases_code_unique UNIQUE (code),
    CONSTRAINT cases_code_format CHECK (code ~ '^[a-z0-9_]+$'),
    CONSTRAINT cases_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT cases_price_positive CHECK (price > 0),
    CONSTRAINT cases_image_not_blank CHECK (btrim(image) <> '')
);

CREATE TABLE IF NOT EXISTS items (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code       TEXT        NOT NULL,
    name       TEXT        NOT NULL,
    rarity     TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT items_code_unique UNIQUE (code),
    CONSTRAINT items_code_format CHECK (code ~ '^[a-z0-9_]+$'),
    CONSTRAINT items_name_not_blank CHECK (btrim(name) <> ''),
    CONSTRAINT items_rarity_valid CHECK (rarity IN ('common', 'rare', 'epic', 'legendary'))
);

CREATE TABLE IF NOT EXISTS case_items (
    case_id BIGINT  NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
    item_id BIGINT  NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
    weight  INTEGER NOT NULL,

    PRIMARY KEY (case_id, item_id),
    CONSTRAINT case_items_weight_positive CHECK (weight > 0)
);

CREATE INDEX IF NOT EXISTS case_items_item_idx ON case_items (item_id);

COMMENT ON TABLE cases IS 'Каталог кейсов; price — цена открытия в монетах';
COMMENT ON TABLE items IS 'Предметы, которые могут выпасть из кейсов';
COMMENT ON TABLE case_items IS 'Состав кейса; шанс предмета = weight / сумма weight кейса';

-- ---------------------------------------------------------------------------
-- case_openings: история открытий
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_openings (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    case_id    BIGINT      NOT NULL REFERENCES cases (id) ON DELETE RESTRICT,
    item_id    BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
    request_id UUID        NOT NULL,
    price      BIGINT      NOT NULL,
    opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT case_openings_id_user_unique UNIQUE (id, user_id),
    -- Повтор запроса с тем же requestId вернёт прежний результат, а не откроет кейс снова.
    CONSTRAINT case_openings_user_request_unique UNIQUE (user_id, request_id),
    -- Награда обязана принадлежать открытому кейсу.
    CONSTRAINT case_openings_item_in_case
        FOREIGN KEY (case_id, item_id) REFERENCES case_items (case_id, item_id) ON DELETE RESTRICT,
    CONSTRAINT case_openings_price_positive CHECK (price > 0)
);

CREATE INDEX IF NOT EXISTS case_openings_user_opened_idx ON case_openings (user_id, opened_at DESC, id DESC);

COMMENT ON TABLE case_openings IS 'Одна строка — одно открытие кейса';
COMMENT ON COLUMN case_openings.price IS 'Сколько монет списано (цена на момент открытия)';

-- ---------------------------------------------------------------------------
-- inventory_items: предметы игрока (один экземпляр на открытие)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_items (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    item_id       BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
    opening_id    BIGINT      NOT NULL,
    upgrade_level SMALLINT    NOT NULL DEFAULT 0,
    acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    upgraded_at   TIMESTAMPTZ,

    CONSTRAINT inventory_items_opening_user_fk
        FOREIGN KEY (opening_id, user_id) REFERENCES case_openings (id, user_id) ON DELETE RESTRICT,
    CONSTRAINT inventory_items_opening_unique UNIQUE (opening_id),
    CONSTRAINT inventory_items_upgrade_level_valid CHECK (upgrade_level >= 0),
    CONSTRAINT inventory_items_upgraded_has_time CHECK (upgrade_level = 0 OR upgraded_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS inventory_items_user_idx ON inventory_items (user_id, acquired_at DESC);

COMMENT ON TABLE inventory_items IS 'Коллекция игрока; upgrade_level меняет Апгрейдер';

-- ---------------------------------------------------------------------------
-- transactions: новые типы операций
--   case_open — списание за открытие кейса (ссылается на case_openings)
--   top_up    — пополнение монет (request_id защищает от двойного начисления)
-- ---------------------------------------------------------------------------
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS opening_id BIGINT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS request_id UUID;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_opening_user_fk;
ALTER TABLE transactions ADD CONSTRAINT transactions_opening_user_fk
    FOREIGN KEY (opening_id, user_id) REFERENCES case_openings (id, user_id) ON DELETE RESTRICT;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_valid;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_valid
    CHECK (type IN ('bet', 'win', 'bonus', 'signup_bonus', 'admin_adjust', 'refund', 'case_open', 'top_up'));

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_case_open_requires_opening;
ALTER TABLE transactions ADD CONSTRAINT transactions_case_open_requires_opening
    CHECK (type <> 'case_open' OR (opening_id IS NOT NULL AND amount < 0));

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_opening_only_for_case_open;
ALTER TABLE transactions ADD CONSTRAINT transactions_opening_only_for_case_open
    CHECK (opening_id IS NULL OR type = 'case_open');

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_top_up_amount_positive;
ALTER TABLE transactions ADD CONSTRAINT transactions_top_up_amount_positive
    CHECK (type <> 'top_up' OR amount > 0);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_one_charge_per_opening
    ON transactions (opening_id) WHERE type = 'case_open';
CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_request_unique
    ON transactions (user_id, request_id) WHERE request_id IS NOT NULL;

COMMENT ON COLUMN transactions.opening_id IS 'Открытие кейса для type = case_open';
COMMENT ON COLUMN transactions.request_id IS 'Ключ идемпотентности пополнения от клиента';
COMMENT ON COLUMN transactions.type IS 'bet, win, bonus, signup_bonus, admin_adjust, refund, case_open, top_up';

COMMIT;
