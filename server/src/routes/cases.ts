import { randomInt, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from '../db.ts';
import type { Queryable } from '../db.ts';
import { HttpError, parse, requestIdSchema } from '../http.ts';
import { auth } from '../session.ts';

export const casesRouter = Router();

interface CaseItem {
  id: number;
  code: string;
  name: string;
  rarity: string;
  weight: number;
}

interface CaseRow {
  id: number;
  code: string;
  name: string;
  price: number;
  image: string;
  items: CaseItem[];
}

const codeSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);
const openSchema = z.object({ requestId: requestIdSchema.optional() });

async function loadCases(db: Queryable, code?: string): Promise<CaseRow[]> {
  const { rows } = await db.query<CaseRow>(
    `SELECT c.id, c.code, c.name, c.price, c.image,
            json_agg(json_build_object('id', i.id, 'code', i.code, 'name', i.name,
                                       'rarity', i.rarity, 'weight', ci.weight)
                     ORDER BY ci.weight DESC, i.id) AS items
       FROM cases c
       JOIN case_items ci ON ci.case_id = c.id
       JOIN items i ON i.id = ci.item_id
      WHERE c.is_active AND ($1::text IS NULL OR c.code = $1)
      GROUP BY c.id
      ORDER BY c.sort_order, c.id`,
    [code ?? null],
  );
  return rows;
}

function toPublicCase(row: CaseRow) {
  const total = row.items.reduce((sum, item) => sum + item.weight, 0);
  return {
    code: row.code,
    name: row.name,
    price: row.price,
    image: row.image,
    items: row.items.map((item) => ({
      code: item.code,
      name: item.name,
      rarity: item.rarity,
      chance: Math.round((item.weight / total) * 10_000) / 10_000,
    })),
  };
}

/** Случайный предмет с учётом весов; crypto.randomInt — криптостойкий ГСЧ. */
function pickItem(items: CaseItem[]): CaseItem {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = randomInt(total);
  for (const item of items) {
    if (roll < item.weight) return item;
    roll -= item.weight;
  }
  return items[items.length - 1]!;
}

async function findCase(code: string): Promise<CaseRow> {
  const parsed = codeSchema.safeParse(code);
  const row = parsed.success ? (await loadCases(pool, parsed.data))[0] : undefined;
  if (!row) throw new HttpError(404, 'case_not_found', 'Такого кейса нет');
  return row;
}

interface OpeningRow {
  id: number;
  request_id: string;
  price: number;
  opened_at: Date;
  case_code: string;
  case_name: string;
  case_image: string;
  item_code: string;
  item_name: string;
  item_rarity: string;
  inventory_item_id: number | null;
}

export function toOpening(row: OpeningRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    price: row.price,
    openedAt: row.opened_at.toISOString(),
    case: { code: row.case_code, name: row.case_name, image: row.case_image },
    item: { code: row.item_code, name: row.item_name, rarity: row.item_rarity },
    inventoryItemId: row.inventory_item_id,
  };
}

async function findOpening(db: Queryable, userId: number, requestId: string) {
  const { rows } = await db.query<OpeningRow>(
    `SELECT o.id, o.request_id, o.price, o.opened_at,
            c.code AS case_code, c.name AS case_name, c.image AS case_image,
            i.code AS item_code, i.name AS item_name, i.rarity AS item_rarity,
            ii.id AS inventory_item_id
       FROM case_openings o
       JOIN cases c ON c.id = o.case_id
       JOIN items i ON i.id = o.item_id
       LEFT JOIN inventory_items ii ON ii.opening_id = o.id
      WHERE o.user_id = $1 AND o.request_id = $2`,
    [userId, requestId],
  );
  return rows[0];
}

async function currentBalance(db: Queryable, userId: number): Promise<number> {
  const { rows } = await db.query<{ balance: number }>(`SELECT balance FROM users WHERE id = $1`, [userId]);
  return rows[0]?.balance ?? 0;
}

/** GET /api/cases — каталог: цена, картинка, предметы, редкость и шанс. */
casesRouter.get('/', async (_req, res) => {
  res.json({ cases: (await loadCases(pool)).map(toPublicCase) });
});

/** GET /api/cases/:code — один кейс. */
casesRouter.get('/:code', async (req, res) => {
  res.json({ case: toPublicCase(await findCase(req.params.code)) });
});

/**
 * POST /api/cases/:code/open — открыть кейс.
 *
 * В одной транзакции БД: запись открытия, списание цены с журналом, предмет в инвентарь.
 * requestId (UUID от клиента) делает запрос идемпотентным: повтор вернёт прежний результат,
 * не списав монеты второй раз.
 */
casesRouter.post('/:code/open', async (req, res) => {
  const { userId } = auth(res);
  const body = parse(openSchema, req.body);
  const requestId = body.requestId ?? randomUUID();
  const box = await findCase(req.params.code);

  const result = await withTransaction(async (db) => {
    const item = pickItem(box.items);

    // Если такой requestId уже есть (в том числе в параллельной транзакции), вставка ждёт её
    // завершения и ничего не делает — тогда возвращаем ранее сохранённый результат.
    const inserted = await db.query<{ id: number; opened_at: Date }>(
      `INSERT INTO case_openings (user_id, case_id, item_id, request_id, price)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, request_id) DO NOTHING
       RETURNING id, opened_at`,
      [userId, box.id, item.id, requestId, box.price],
    );
    const opening = inserted.rows[0];

    if (!opening) {
      const existing = await findOpening(db, userId, requestId);
      if (!existing) throw new Error('Открытие с этим requestId не найдено после конфликта');
      if (existing.case_code !== box.code) {
        throw new HttpError(409, 'request_id_reused', 'Этот requestId уже использован для другого кейса');
      }
      return { opening: toOpening(existing), balance: await currentBalance(db, userId), repeated: true };
    }

    // Условное списание: UPDATE блокирует строку игрока, баланс не уйдёт в минус даже при гонке.
    const charged = await db.query<{ balance_after: number }>(
      `WITH updated AS (
         UPDATE users SET balance = balance - $2::bigint
          WHERE id = $1 AND balance >= $2::bigint
          RETURNING balance
       )
       INSERT INTO transactions (user_id, opening_id, type, amount, balance_after)
       SELECT $1, $3, 'case_open', -$2::bigint, balance FROM updated
       RETURNING balance_after`,
      [userId, box.price, opening.id],
    );
    const charge = charged.rows[0];
    if (!charge) {
      const balance = await currentBalance(db, userId);
      throw new HttpError(402, 'insufficient_funds', `Недостаточно монет. Для открытия нужно ${box.price}.`, {
        price: box.price,
        balance,
      });
    }

    const inventory = await db.query<{ id: number }>(
      `INSERT INTO inventory_items (user_id, item_id, opening_id, acquired_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, item.id, opening.id, opening.opened_at],
    );

    return {
      opening: toOpening({
        id: opening.id,
        request_id: requestId,
        price: box.price,
        opened_at: opening.opened_at,
        case_code: box.code,
        case_name: box.name,
        case_image: box.image,
        item_code: item.code,
        item_name: item.name,
        item_rarity: item.rarity,
        inventory_item_id: inventory.rows[0]!.id,
      }),
      balance: charge.balance_after,
      repeated: false,
    };
  });

  res.status(result.repeated ? 200 : 201).json(result);
});
