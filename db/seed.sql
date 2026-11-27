-- Стартовые справочники ScrumDrop: игры и каталог кейсов.
-- Запуск (после всех миграций): psql -U postgres -d scrumdrop -f db/seed.sql
--
-- min_bet/max_bet — временные значения для разработки, их можно менять.
-- Для покера это минимальный и максимальный бай-ин (блайнды 1/2 заданы в server/src/poker/session.ts).
-- Повторный запуск ничего не дублирует благодаря ON CONFLICT.

BEGIN;

INSERT INTO games (code, name, min_bet, max_bet, is_active) VALUES
    ('slots',     'Слоты',                    10, 1000, TRUE),
    ('roulette',  'Рулетка',                  10, 1000, TRUE),
    ('blackjack', 'Блэкджек',                 10, 1000, TRUE),
    ('dice',      'Кости',                    10, 1000, TRUE),
    ('poker',     'Покер (Техасский холдем)', 40,  400, TRUE),
    ('rocket',    'Ракета',                   10, 1000, TRUE),
    ('minedrop',  'MineDrop',                 10, 1000, TRUE)
ON CONFLICT (code) DO NOTHING;

-- Кейсы из прототипа: цена 30, картинка — файл во frontend/cases.
INSERT INTO cases (code, name, price, image, sort_order) VALUES
    ('orbit',    'Орбита',   30, 'cases/0.jpg', 0),
    ('leaf',     'Листопад', 30, 'cases/1.jpg', 1),
    ('amethyst', 'Аметист',  30, 'cases/2.jpg', 2),
    ('impulse',  'Импульс',  30, 'cases/3.jpg', 3),
    ('moon',     'Луна',     30, 'cases/4.jpg', 4),
    ('prism',    'Призма',   30, 'cases/5.jpg', 5),
    ('cassette', 'Кассета',  30, 'cases/6.jpg', 6),
    ('flora',    'Флора',    30, 'cases/7.jpg', 7),
    ('origami',  'Оригами',  30, 'cases/8.jpg', 8),
    ('eclipse',  'Затмение', 30, 'cases/9.jpg', 9)
ON CONFLICT (code) DO NOTHING;

INSERT INTO items (code, name, rarity) VALUES
    ('star',      'Звезда',    'common'),
    ('leaf',      'Лист',      'common'),
    ('geode',     'Жеода',     'common'),
    ('lightning', 'Молния',    'common'),
    ('crescent',  'Полумесяц', 'common'),
    ('spectrum',  'Спектр',    'common'),
    ('mixtape',   'Микстейп',  'common'),
    ('spore',     'Спора',     'common'),
    ('crane',     'Журавль',   'common'),
    ('crown',     'Корона',    'common'),
    ('crystal',   'Кристалл',  'rare')
ON CONFLICT (code) DO NOTHING;

-- В каждом кейсе свой обычный предмет (75 %) и общий редкий Кристалл (25 %).
INSERT INTO case_items (case_id, item_id, weight)
SELECT c.id, i.id, v.weight
FROM (VALUES
    ('orbit',    'star',      75), ('orbit',    'crystal', 25),
    ('leaf',     'leaf',      75), ('leaf',     'crystal', 25),
    ('amethyst', 'geode',     75), ('amethyst', 'crystal', 25),
    ('impulse',  'lightning', 75), ('impulse',  'crystal', 25),
    ('moon',     'crescent',  75), ('moon',     'crystal', 25),
    ('prism',    'spectrum',  75), ('prism',    'crystal', 25),
    ('cassette', 'mixtape',   75), ('cassette', 'crystal', 25),
    ('flora',    'spore',     75), ('flora',    'crystal', 25),
    ('origami',  'crane',     75), ('origami',  'crystal', 25),
    ('eclipse',  'crown',     75), ('eclipse',  'crystal', 25)
) AS v (case_code, item_code, weight)
JOIN cases c ON c.code = v.case_code
JOIN items i ON i.code = v.item_code
ON CONFLICT (case_id, item_id) DO NOTHING;

COMMIT;
