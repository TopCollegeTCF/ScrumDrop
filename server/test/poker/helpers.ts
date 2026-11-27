import type { Card } from '../../src/poker/types.ts';
import { newDeck } from '../../src/poker/cards.ts';
import type { TableState } from '../../src/poker/engine.ts';

/** Детерминированный генератор для воспроизводимых тестов (mulberry32). */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const float = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { float, int: (max: number) => Math.floor(float() * max) };
}

/** Подменить карты после startHand: руки игроков и будущий борд. */
export function rig(state: TableState, holes: Card[][], board: Card[]) {
  holes.forEach((h, i) => (state.seats[i]!.hole = [...h]));
  const used = new Set<Card>([...holes.flat(), ...board]);
  const filler = newDeck().filter((c) => !used.has(c));
  const burn = () => filler.pop()!;
  // Карты берутся с конца массива: сжечь, флоп ×3, сжечь, тёрн, сжечь, ривер.
  const order: Card[] = [burn(), board[0]!, board[1]!, board[2]!, burn(), board[3]!, burn(), board[4]!];
  state.deck = [...filler, ...order.reverse()];
}

/** Все фишки за столом: во время раздачи часть лежит в банке (totalBet), после — всё в стеках. */
export const chips = (s: TableState) =>
  s.seats.reduce((sum, x) => sum + x.stack + (s.stage === 'finished' ? 0 : x.totalBet), 0);
