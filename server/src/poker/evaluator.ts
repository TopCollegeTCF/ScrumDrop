// Оценка покерной комбинации из 5–7 карт (лучшие 5 из 7 в холдеме).
//
// Идея: считаем, сколько карт каждого ранга и каждой масти, и сверху вниз
// проверяем категории: стрит-флеш, каре, фулл-хаус, флеш, стрит, сет,
// две пары, пара, старшая карта. Результат упаковываем в одно число score,
// чтобы руки можно было сравнивать обычным «больше/меньше».

import type { Card } from './types.ts';
import { cardCode, rankValue, suitIndex } from './cards.ts';

export const CATEGORY_NAMES = [
  'Старшая карта',
  'Пара',
  'Две пары',
  'Сет',
  'Стрит',
  'Флеш',
  'Фулл-хаус',
  'Каре',
  'Стрит-флеш',
] as const;

interface Analysis {
  /** 0 — старшая карта … 8 — стрит-флеш. */
  category: number;
  /** Значимые ранги по убыванию важности (для сравнения и кикеров). */
  ranks: number[];
  /** Масть флеша или -1. */
  flushSuit: number;
}

export interface HandValue {
  category: number;
  /** Чем больше, тем сильнее рука. Равные score — ничья. */
  score: number;
  /** Например «Две пары: короли и семёрки». */
  name: string;
  /** 5 карт, из которых состоит комбинация. */
  best: Card[];
}

/** Старший ранг стрита в битовой маске рангов или 0. */
function straightHigh(mask: number): number {
  // Туз может играть как единица: A-2-3-4-5 («колесо»).
  if (mask & (1 << 14)) mask |= 1 << 1;
  for (let high = 14; high >= 5; high--) {
    if (((mask >> (high - 4)) & 0b11111) === 0b11111) return high;
  }
  return 0;
}

/** count старших рангов из маски, кроме exclude. */
function topRanks(mask: number, count: number, exclude: number[] = []): number[] {
  const out: number[] = [];
  for (let v = 14; v >= 2 && out.length < count; v--) {
    if ((mask >> v) & 1 && !exclude.includes(v)) out.push(v);
  }
  return out;
}

/** Карты заданы кодами rank*4 + suit (см. cardCode). */
function analyzeCodes(codes: number[]): Analysis {
  const counts = new Uint8Array(15);
  const suitCounts = [0, 0, 0, 0];
  const suitMasks = [0, 0, 0, 0];
  let rankMask = 0;
  for (const code of codes) {
    const v = code >> 2;
    const s = code & 3;
    counts[v] = counts[v]! + 1;
    suitCounts[s] = suitCounts[s]! + 1;
    suitMasks[s] = suitMasks[s]! | (1 << v);
    rankMask |= 1 << v;
  }

  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (suitCounts[s]! >= 5) flushSuit = s;

  if (flushSuit >= 0) {
    const sf = straightHigh(suitMasks[flushSuit]!);
    if (sf) return { category: 8, ranks: [sf], flushSuit };
  }

  let quad = 0;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let v = 14; v >= 2; v--) {
    if (counts[v] === 4) quad = v;
    else if (counts[v] === 3) trips.push(v);
    else if (counts[v] === 2) pairs.push(v);
  }

  if (quad) return { category: 7, ranks: [quad, ...topRanks(rankMask, 1, [quad])], flushSuit };

  if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
    // Из двух сетов младший играет как пара.
    const pair = Math.max(trips[1] ?? 0, pairs[0] ?? 0);
    return { category: 6, ranks: [trips[0]!, pair], flushSuit };
  }

  if (flushSuit >= 0) return { category: 5, ranks: topRanks(suitMasks[flushSuit]!, 5), flushSuit };

  const st = straightHigh(rankMask);
  if (st) return { category: 4, ranks: [st], flushSuit };

  const [trip] = trips;
  if (trip) return { category: 3, ranks: [trip, ...topRanks(rankMask, 2, [trip])], flushSuit };
  const [hi, lo] = pairs;
  if (hi && lo) return { category: 2, ranks: [hi, lo, ...topRanks(rankMask, 1, [hi, lo])], flushSuit };
  if (hi) return { category: 1, ranks: [hi, ...topRanks(rankMask, 3, [hi])], flushSuit };
  return { category: 0, ranks: topRanks(rankMask, 5), flushSuit };
}

/** Упаковка в число: категория и до 5 рангов, по 4 бита на ранг. */
function scoreOf(a: Analysis): number {
  let score = a.category * 16 ** 5;
  for (let i = 0; i < a.ranks.length; i++) score += a.ranks[i]! * 16 ** (4 - i);
  return score;
}

/** Быстрая оценка по кодам карт — для симуляций ботов. */
export function scoreCodes(codes: number[]): number {
  return scoreOf(analyzeCodes(codes));
}

// ---------- Названия комбинаций по-русски ----------

type RankWords = Record<number, string>;
const NOM_SG: RankWords = {
  2: 'двойка', 3: 'тройка', 4: 'четвёрка', 5: 'пятёрка', 6: 'шестёрка', 7: 'семёрка', 8: 'восьмёрка',
  9: 'девятка', 10: 'десятка', 11: 'валет', 12: 'дама', 13: 'король', 14: 'туз',
};
const GEN_SG: RankWords = {
  2: 'двойки', 3: 'тройки', 4: 'четвёрки', 5: 'пятёрки', 6: 'шестёрки', 7: 'семёрки', 8: 'восьмёрки',
  9: 'девятки', 10: 'десятки', 11: 'валета', 12: 'дамы', 13: 'короля', 14: 'туза',
};
const NOM_PL: RankWords = {
  2: 'двойки', 3: 'тройки', 4: 'четвёрки', 5: 'пятёрки', 6: 'шестёрки', 7: 'семёрки', 8: 'восьмёрки',
  9: 'девятки', 10: 'десятки', 11: 'валеты', 12: 'дамы', 13: 'короли', 14: 'тузы',
};
const GEN_PL: RankWords = {
  2: 'двоек', 3: 'троек', 4: 'четвёрок', 5: 'пятёрок', 6: 'шестёрок', 7: 'семёрок', 8: 'восьмёрок',
  9: 'девяток', 10: 'десяток', 11: 'валетов', 12: 'дам', 13: 'королей', 14: 'тузов',
};

function describe(a: Analysis): string {
  const [r0 = 0, r1 = 0] = a.ranks;
  switch (a.category) {
    case 8: return r0 === 14 ? 'Роял-флеш' : `Стрит-флеш до ${GEN_SG[r0]}`;
    case 7: return `Каре ${GEN_PL[r0]}`;
    case 6: return `Фулл-хаус: ${NOM_PL[r0]} и ${NOM_PL[r1]}`;
    case 5: return `Флеш до ${GEN_SG[r0]}`;
    case 4: return `Стрит до ${GEN_SG[r0]}`;
    case 3: return `Сет ${GEN_PL[r0]}`;
    case 2: return `Две пары: ${NOM_PL[r0]} и ${NOM_PL[r1]}`;
    case 1: return `Пара ${GEN_PL[r0]}`;
    default: return `Старшая карта: ${NOM_SG[r0]}`;
  }
}

/** Выбирает 5 карт, из которых состоит комбинация (для подсветки на столе). */
function pickBest(cards: Card[], a: Analysis): Card[] {
  const parsed = cards
    .map((c) => ({ c, v: rankValue(c), s: suitIndex(c) }))
    .sort((x, y) => y.v - x.v);
  const used = new Set<number>();
  const best: Card[] = [];
  const take = (v: number, n: number, suit = -1) => {
    for (let i = 0; i < parsed.length && n > 0; i++) {
      const p = parsed[i]!;
      if (!used.has(i) && p.v === v && (suit < 0 || p.s === suit)) {
        used.add(i);
        best.push(p.c);
        n--;
      }
    }
  };
  const run = (high: number, suit: number) => {
    for (let v = high; v > high - 5; v--) take(v === 1 ? 14 : v, 1, suit);
  };
  const r = a.ranks;
  const [r0 = 0, r1 = 0, r2 = 0] = r;
  switch (a.category) {
    case 8: run(r0, a.flushSuit); break;
    case 7: take(r0, 4); take(r1, 1); break;
    case 6: take(r0, 3); take(r1, 2); break;
    case 5: r.forEach((v) => take(v, 1, a.flushSuit)); break;
    case 4: run(r0, -1); break;
    case 3: take(r0, 3); take(r1, 1); take(r2, 1); break;
    case 2: take(r0, 2); take(r1, 2); take(r2, 1); break;
    case 1: take(r0, 2); r.slice(1).forEach((v) => take(v, 1)); break;
    default: r.forEach((v) => take(v, 1));
  }
  return best;
}

/** Полная оценка руки из 5–7 карт. */
export function evaluate(cards: Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`Для оценки нужно 5–7 карт, получено ${cards.length}`);
  }
  const a = analyzeCodes(cards.map(cardCode));
  return { category: a.category, score: scoreOf(a), name: describe(a), best: pickBest(cards, a) };
}
