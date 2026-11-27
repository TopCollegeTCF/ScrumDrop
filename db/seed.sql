-- Стартовый справочник игр ScrumDrop.
-- Запуск: psql -U postgres -d scrumdrop -f db/seed.sql
--
-- min_bet/max_bet — временные значения для разработки, их можно менять.
-- Повторный запуск ничего не дублирует благодаря ON CONFLICT.

BEGIN;

INSERT INTO games (code, name, min_bet, max_bet, is_active) VALUES
    ('slots',     'Слоты',                    10, 1000, TRUE),
    ('roulette',  'Рулетка',                  10, 1000, TRUE),
    ('blackjack', 'Блэкджек',                 10, 1000, TRUE),
    ('dice',      'Кости',                    10, 1000, TRUE),
    ('poker',     'Покер (Техасский холдем)', 10, 1000, TRUE),
    ('rocket',    'Ракета',                   10, 1000, TRUE),
    ('minedrop',  'MineDrop',                 10, 1000, TRUE)
ON CONFLICT (code) DO NOTHING;

COMMIT;
