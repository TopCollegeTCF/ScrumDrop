import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '../../src/poker/types.ts';
import { newDeck, rankValue, shuffle } from '../../src/poker/cards.ts';
import { evaluate } from '../../src/poker/evaluator.ts';
import { seeded } from './helpers.ts';

const h = (s: string) => s.split(' ') as Card[];

test('названия и категории известных комбинаций', () => {
  const cases: [string, string][] = [
    ['As Ks Qs Js Ts 2d 3c', 'Роял-флеш'],
    ['5h 4h 3h 2h Ah Kd Kc', 'Стрит-флеш до пятёрки'],
    ['9c 9d 9h 9s 2c 3d 4h', 'Каре девяток'],
    ['Kc Kd Kh 7s 7c 2d 3h', 'Фулл-хаус: короли и семёрки'],
    ['Qc Qd Qh 4s 4c 4d 2h', 'Фулл-хаус: дамы и четвёрки'], // два сета
    ['Ad 9d 7d 4d 2d Kc Kh', 'Флеш до туза'],
    ['5c 4d 3h 2s Ah Kd Qc', 'Стрит до пятёрки'], // «колесо»
    ['Tc Jd Qh Ks As 2d 2c', 'Стрит до туза'],
    ['8c 8d 8h Ks 2c 3d 4h', 'Сет восьмёрок'],
    ['Jc Jd 4h 4s 9c 9d 2h', 'Две пары: валеты и девятки'], // три пары
    ['Ac Ad 7h 5s 3c 2d 9h', 'Пара тузов'],
    ['Ac Jd 9h 7s 5c 3d 2h', 'Старшая карта: туз'],
  ];
  for (const [cards, name] of cases) assert.equal(evaluate(h(cards)).name, name, cards);
});

test('сравнение рук и кикеры', () => {
  const s = (cards: string) => evaluate(h(cards)).score;
  assert.ok(s('Ad 9d 7d 4d 2d Kc Kh') > s('Tc Jd Qh Ks As 2d 2c'), 'флеш > стрит');
  assert.ok(s('Tc Jd Qh Ks As 2d 2c') > s('5c 4d 3h 2s Ah Kd Qc'), 'стрит до туза > колесо');
  assert.ok(s('Ac Ad Kh 5s 3c 2d 9h') > s('Ac Ad Qh 5s 3c 2d 9h'), 'пара тузов с королём > с дамой');
  assert.ok(s('Jc Jd 4h 4s Ac 9d 2h') > s('Jc Jd 4h 4s Kc 9d 2h'), 'кикер к двум парам');
  // Одинаковые лучшие пятёрки на борде — ничья.
  assert.equal(s('2c 3d As Ks Qs Js Ts'), s('4h 5h As Ks Qs Js Ts'));
});

// Независимая «наивная» оценка: перебор всех 5-карточных сочетаний.
function naive5(cards: Card[]): number {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = new Set(cards.map((c) => c[1])).size === 1;
  const uniq = [...new Set(vals)];
  let straight = 0;
  if (uniq.length === 5 && vals[0]! - vals[4]! === 4) straight = vals[0]!;
  if (uniq.join() === '14,5,4,3,2') straight = 5;
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const gv = groups.map((g) => g[0]);
  let cat: number;
  let ranks: number[];
  if (straight && flush) [cat, ranks] = [8, [straight]];
  else if (shape === '41') [cat, ranks] = [7, gv];
  else if (shape === '32') [cat, ranks] = [6, gv];
  else if (flush) [cat, ranks] = [5, vals];
  else if (straight) [cat, ranks] = [4, [straight]];
  else if (shape === '311') [cat, ranks] = [3, gv];
  else if (shape === '221') [cat, ranks] = [2, gv];
  else if (shape === '2111') [cat, ranks] = [1, gv];
  else [cat, ranks] = [0, vals];
  let score = cat * 16 ** 5;
  ranks.forEach((r, i) => (score += r * 16 ** (4 - i)));
  return score;
}

function naive7(cards: Card[]): number {
  let best = 0;
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      best = Math.max(best, naive5(five));
    }
  return best;
}

test('быстрая оценка совпадает с перебором на 20 000 случайных рук', () => {
  const rng = seeded(42);
  for (let i = 0; i < 20000; i++) {
    const cards = shuffle(newDeck(), rng.int).slice(0, 7);
    const fast = evaluate(cards);
    assert.equal(fast.score, naive7(cards), cards.join(' '));
    // Выбранные 5 карт — из этой руки, без повторов, и дают ту же силу.
    assert.equal(new Set(fast.best).size, 5);
    assert.ok(fast.best.every((c) => cards.includes(c)));
    assert.equal(evaluate(fast.best).score, fast.score, `best of ${cards.join(' ')}`);
  }
});
