import type { Queryable } from './db.ts';
import { HttpError } from './http.ts';

interface UserRow {
  id: number;
  username: string;
  email: string;
  display_name: string;
  avatar: string;
  avatar_image: string | null;
  balance: number;
  role: string;
  reaction_best_ms: number | null;
  created_at: Date;
  opened: number;
  unique_items: number;
}

/** Профиль игрока для интерфейса: баланс, имя, аватарка и счётчики для кабинета. */
export async function getUserProfile(db: Queryable, userId: number) {
  const { rows } = await db.query<UserRow>(
    `SELECT u.id, u.username, u.email,
            COALESCE(u.display_name, u.username) AS display_name,
            u.avatar, ac.image AS avatar_image,
            u.balance, u.role, u.reaction_best_ms, u.created_at,
            (SELECT count(*) FROM case_openings o WHERE o.user_id = u.id) AS opened,
            (SELECT count(DISTINCT ii.item_id) FROM inventory_items ii WHERE ii.user_id = u.id) AS unique_items
       FROM users u
       LEFT JOIN cases ac ON ac.code = u.avatar
      WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, 'unauthorized', 'Аккаунт не найден. Войдите заново.');
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    avatar: row.avatar,
    avatarImage: row.avatar_image,
    balance: row.balance,
    role: row.role,
    reactionBestMs: row.reaction_best_ms,
    createdAt: row.created_at.toISOString(),
    stats: { opened: row.opened, uniqueItems: row.unique_items },
  };
}

export type UserProfile = Awaited<ReturnType<typeof getUserProfile>>;
