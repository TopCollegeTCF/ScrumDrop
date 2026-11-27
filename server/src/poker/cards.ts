import { randomInt } from 'node:crypto';
import type { Card, Rank, Suit } from './types.ts';

export const RANKS: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS: readonly Suit[] = ['s', 'h', 'd', 'c'];

const SUIT_SYMBOL: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/**
 * Генератор случайного целого числа в [0, maxExclusive).
 * По умолчанию — криптостойкий randomInt из node:crypto: для казино
 * Math.random не годится, его последовательность можно предсказать.
 * В тестах подставляем детерминированный генератор.
 */
export type RandomInt = (maxExclusive: number) => number;
export const cryptoRandomInt: RandomInt = (max) => randomInt(max);

/** Числовое значение ранга: 2..14 (туз = 14). */
export function rankValue(card: Card): number {
  return RANKS.indexOf(card[0] as Rank) + 2;
}

export function suitIndex(card: Card): number {
  return SUITS.indexOf(card[1] as Suit);
}

/** Компактный код карты для быстрых вычислений: ранг * 4 + масть. */
export function cardCode(card: Card): number {
  return rankValue(card) * 4 + suitIndex(card);
}

export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  return deck;
}

/** Тасование Фишера — Йетса (равномерное). Меняет массив на месте. */
export function shuffle<T>(arr: T[], rnd: RandomInt = cryptoRandomInt): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/** Карта для лога: "A♠", "10♥". */
export function cardText(card: Card): string {
  const r = card[0] === 'T' ? '10' : card[0];
  return r + SUIT_SYMBOL[card[1] as Suit];
}

export function cardsText(cards: Card[]): string {
  return cards.map(cardText).join(' ');
}
