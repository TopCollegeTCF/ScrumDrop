-- ScrumDrop · покер (техасский холдем против ботов)
--
-- Покер играется «столом», деньги проходят через общие bets и transactions:
--   сел за стол   → bets (amount = бай-ин, status = 'pending') + transactions('bet', −бай-ин)
--   играет        → фишки лежат на столе, в poker_sessions.state; баланс не меняется
--   встал         → bets.payout = фишки со стола, status = 'won' + transactions('win', +фишки)
--   проиграл всё  → bets.payout = 0, status = 'lost'; сессия закрывается сама
--
-- Файл можно выполнить повторно: таблицы и индексы создаются с IF NOT EXISTS.

BEGIN;

-- ---------------------------------------------------------------------------
-- poker_sessions: одна посадка за стол
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poker_sessions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    bet_id     BIGINT      NOT NULL,
    status     TEXT        NOT NULL DEFAULT 'active',
    state      JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at  TIMESTAMPTZ,

    CONSTRAINT poker_sessions_id_user_unique UNIQUE (id, user_id),
    CONSTRAINT poker_sessions_bet_unique UNIQUE (bet_id),
    -- Ставка-бай-ин принадлежит тому же игроку.
    CONSTRAINT poker_sessions_bet_user_fk
        FOREIGN KEY (bet_id, user_id) REFERENCES bets (id, user_id) ON DELETE RESTRICT,
    CONSTRAINT poker_sessions_status_valid CHECK (status IN ('active', 'closed')),
    CONSTRAINT poker_sessions_state_is_object CHECK (jsonb_typeof(state) = 'object'),
    CONSTRAINT poker_sessions_closed_has_time CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- У игрока может быть только один открытый стол.
CREATE UNIQUE INDEX IF NOT EXISTS poker_sessions_one_active
    ON poker_sessions (user_id) WHERE status = 'active';

COMMENT ON TABLE poker_sessions IS 'Посадки за покерный стол; state — стол целиком (колода, карты, стеки ботов), только для сервера';
COMMENT ON COLUMN poker_sessions.bet_id IS 'Строка bets с бай-ином; при выходе в неё пишется payout';

-- ---------------------------------------------------------------------------
-- poker_hands: история раздач
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS poker_hands (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id  BIGINT      NOT NULL,
    user_id     BIGINT      NOT NULL,
    hand_no     INTEGER     NOT NULL,
    hole_cards  JSONB       NOT NULL,
    board       JSONB       NOT NULL,
    pot         BIGINT      NOT NULL,
    invested    BIGINT      NOT NULL,
    won         BIGINT      NOT NULL,
    result_data JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT poker_hands_session_user_fk
        FOREIGN KEY (session_id, user_id) REFERENCES poker_sessions (id, user_id) ON DELETE CASCADE,
    CONSTRAINT poker_hands_session_hand_unique UNIQUE (session_id, hand_no),
    CONSTRAINT poker_hands_hand_no_positive CHECK (hand_no > 0),
    CONSTRAINT poker_hands_cards_are_arrays
        CHECK (jsonb_typeof(hole_cards) = 'array' AND jsonb_typeof(board) = 'array'),
    CONSTRAINT poker_hands_amounts_non_negative CHECK (pot >= 0 AND invested >= 0 AND won >= 0),
    CONSTRAINT poker_hands_result_is_object CHECK (jsonb_typeof(result_data) = 'object')
);

CREATE INDEX IF NOT EXISTS poker_hands_user_idx ON poker_hands (user_id, id DESC);

COMMENT ON TABLE poker_hands IS 'Сыгранные раздачи: карты игрока, борд, банк, сколько поставил и забрал';
COMMENT ON COLUMN poker_hands.invested IS 'Сколько игрок поставил в этой раздаче';
COMMENT ON COLUMN poker_hands.won IS 'Сколько игрок забрал из банка';

-- Бай-ин покера — games.min_bet…max_bet. Заготовка 10…1000 из seed.sql слишком широкая
-- для блайндов 1/2 и стартовых 100 монет; обновляем, только если её никто не менял.
UPDATE games SET min_bet = 40, max_bet = 400
 WHERE code = 'poker' AND min_bet = 10 AND max_bet = 1000;

COMMIT;
