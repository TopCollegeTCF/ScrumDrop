import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool } from '../db.ts';
import { HttpError, parse } from '../http.ts';
import { auth } from '../session.ts';
import { toOpening } from './cases.ts';

// Монтируется в корень /api: вход проверяет auth(res) в каждом обработчике.
export const inventoryRouter = Router();

interface InventoryRow {
  id: number;
  upgrade_level: number;
  acquired_at: Date;
  upgraded_at: Date | null;
  item_code: string;
  item_name: string;
  item_rarity: string;
  case_code: string;
  case_name: string;
}

const INVENTORY_SELECT = `
  SELECT ii.id, ii.upgrade_level, ii.acquired_at, ii.upgraded_at,
         i.code AS item_code, i.name AS item_name, i.rarity AS item_rarity,
         c.code AS case_code, c.name AS case_name
    FROM inventory_items ii
    JOIN items i ON i.id = ii.item_id
    JOIN case_openings o ON o.id = ii.opening_id
    JOIN cases c ON c.id = o.case_id`;

function toInventoryItem(row: InventoryRow) {
  return {
    id: row.id,
    item: { code: row.item_code, name: row.item_name, rarity: row.item_rarity },
    case: { code: row.case_code, name: row.case_name },
    upgradeLevel: row.upgrade_level,
    canUpgrade: row.upgrade_level < config.maxUpgradeLevel,
    acquiredAt: row.acquired_at.toISOString(),
    upgradedAt: row.upgraded_at?.toISOString() ?? null,
  };
}

const idSchema = z.coerce.number({ error: 'Некорректный id' }).int('Некорректный id').positive('Некорректный id');

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: idSchema.optional(),
});

/**
 * GET /api/inventory — коллекция игрока.
 * items — каждый экземпляр (для Апгрейдера), summary — «Кристалл × 2» по предмету и уровню.
 */
inventoryRouter.get('/inventory', async (_req, res) => {
  const { userId } = auth(res);
  const { rows } = await pool.query<InventoryRow>(
    `${INVENTORY_SELECT} WHERE ii.user_id = $1 ORDER BY ii.acquired_at, ii.id`,
    [userId],
  );

  const summary = new Map<string, { code: string; name: string; rarity: string; upgradeLevel: number; count: number }>();
  for (const row of rows) {
    const key = `${row.item_code}:${row.upgrade_level}`;
    const entry = summary.get(key);
    if (entry) entry.count += 1;
    else {
      summary.set(key, {
        code: row.item_code,
        name: row.item_name,
        rarity: row.item_rarity,
        upgradeLevel: row.upgrade_level,
        count: 1,
      });
    }
  }

  res.json({ items: rows.map(toInventoryItem).reverse(), summary: [...summary.values()] });
});

/** POST /api/inventory/:id/upgrade — Апгрейдер: бесплатное улучшение предмета до +1. */
inventoryRouter.post('/inventory/:id/upgrade', async (req, res) => {
  const { userId } = auth(res);
  const id = parse(idSchema, req.params.id);

  const updated = await pool.query(
    `UPDATE inventory_items
        SET upgrade_level = upgrade_level + 1, upgraded_at = now()
      WHERE id = $1 AND user_id = $2 AND upgrade_level < $3`,
    [id, userId, config.maxUpgradeLevel],
  );

  const { rows } = await pool.query<InventoryRow>(`${INVENTORY_SELECT} WHERE ii.id = $1 AND ii.user_id = $2`, [
    id,
    userId,
  ]);
  const row = rows[0];
  if (!row) throw new HttpError(404, 'item_not_found', 'Предмет не найден в вашей коллекции');
  if (!updated.rowCount) throw new HttpError(409, 'already_upgraded', 'Этот предмет уже улучшен до максимума');

  res.json({ item: toInventoryItem(row) });
});

/** GET /api/history?limit=50&before=<id> — открытия игрока, новые сверху. */
inventoryRouter.get('/history', async (req, res) => {
  const { userId } = auth(res);
  const query = parse(historyQuerySchema, req.query);
  const { rows } = await pool.query(
    `SELECT o.id, o.request_id, o.price, o.opened_at,
            c.code AS case_code, c.name AS case_name, c.image AS case_image,
            i.code AS item_code, i.name AS item_name, i.rarity AS item_rarity,
            ii.id AS inventory_item_id
       FROM case_openings o
       JOIN cases c ON c.id = o.case_id
       JOIN items i ON i.id = o.item_id
       LEFT JOIN inventory_items ii ON ii.opening_id = o.id
      WHERE o.user_id = $1
        AND ($2::bigint IS NULL
             OR (o.opened_at, o.id) < (SELECT opened_at, id FROM case_openings WHERE id = $2 AND user_id = $1))
      ORDER BY o.opened_at DESC, o.id DESC
      LIMIT $3`,
    [userId, query.before ?? null, query.limit],
  );
  const openings = rows.map(toOpening);
  res.json({
    openings,
    nextBefore: openings.length === query.limit ? openings[openings.length - 1]!.id : null,
  });
});
