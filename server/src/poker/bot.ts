// Компьютерные соперники.
//
// Бот оценивает «эквити» — шанс выиграть банк — методом Монте-Карло:
// много раз случайно раздаёт соперникам карты и докладывает борд, считая,
// как часто его рука лучше. Свои карты и борд он знает, чужие — НЕТ
// (бот не подглядывает в state.seats[i].hole соперников).
// Дальше решение принимается по шансам банка (pot odds) и характеру бота.

import type { Card, PlayerAction } from './types.ts';
import { cardCode, newDeck, rankValue } from './cards.ts';
import { scoreCodes } from './evaluator.ts';
import { applyAction, getLegalActions, seatAt, totalPot, type BotStyle, type TableState } from './engine.ts';

interface StyleParams {
  /** Сдвиг порога рук до флопа (по шкале Чена): + играет больше рук. */
  preflopShift: number;
  /** Насколько охотнее уравнивает ставки после флопа (добавка к эквити). */
  looseness: number;
  /** Насколько охотнее ставит и повышает сам. */
  aggression: number;
  /** Вероятность блефа. */
  bluff: number;
}

const STYLE_PARAMS: Record<BotStyle, StyleParams> = {
  tight: { preflopShift: -1, looseness: -0.04, aggression: 0.05, bluff: 0.02 },
  balanced: { preflopShift: 0, looseness: 0, aggression: 0.2, bluff: 0.06 },
  aggressive: { preflopShift: 1, looseness: 0.02, aggression: 0.45, bluff: 0.14 },
  loose: { preflopShift: 2, looseness: 0.08, aggression: 0.1, bluff: 0.04 },
};

/**
 * Формула Чена — простая оценка стартовой руки: от -1 (7-2 разномастные)
 * до 20 (пара тузов). Около 10 и выше — сильные руки.
 */
export function chenScore(hole: Card[]): number {
  const [hi = 0, lo = 0] = hole.map(rankValue).sort((a, b) => b - a);
  const points = (v: number) => (v === 14 ? 10 : v === 13 ? 8 : v === 12 ? 7 : v === 11 ? 6 : v / 2);
  let score = points(hi);
  if (hi === lo) return Math.max(5, Math.ceil(score * 2));
  if (hole[0]?.[1] === hole[1]?.[1]) score += 2;
  const gap = hi - lo - 1;
  score -= [0, 1, 2, 4][gap] ?? 5;
  if (gap <= 1 && hi < 12) score += 1;
  return Math.ceil(score);
}

export const BOT_PROFILES: { name: string; style: BotStyle }[] = [
  { name: 'Аркадий', style: 'tight' },
  { name: 'Варвара', style: 'aggressive' },
  { name: 'Глеб', style: 'balanced' },
  { name: 'Дуся', style: 'loose' },
  { name: 'Евгений', style: 'balanced' },
];

/** Вероятность выиграть (ничья считается долей) против opponents случайных рук. */
export function estimateEquity(
  hole: Card[],
  board: Card[],
  opponents: number,
  iterations: number,
  rand: () => number = Math.random,
): number {
  const known = new Set<Card>([...hole, ...board]);
  const rest = newDeck()
    .filter((c) => !known.has(c))
    .map(cardCode);
  const holeCodes = hole.map(cardCode);
  const boardCodes = board.map(cardCode);
  const needBoard = 5 - board.length;
  const need = needBoard + opponents * 2;

  let total = 0;
  for (let it = 0; it < iterations; it++) {
    // Частичное тасование: нужны только первые need карт.
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rand() * (rest.length - i));
      const t = rest[i]!;
      rest[i] = rest[j]!;
      rest[j] = t;
    }
    const fullBoard = boardCodes.concat(rest.slice(0, needBoard));
    const mine = scoreCodes(holeCodes.concat(fullBoard));
    let ties = 0;
    let lost = false;
    for (let o = 0; o < opponents; o++) {
      const k = needBoard + o * 2;
      const theirs = scoreCodes([rest[k]!, rest[k + 1]!, ...fullBoard]);
      if (theirs > mine) {
        lost = true;
        break;
      }
      if (theirs === mine) ties++;
    }
    if (!lost) total += 1 / (ties + 1);
  }
  return total / iterations;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function decideBotAction(state: TableState, idx: number, rand: () => number = Math.random): PlayerAction {
  const seat = seatAt(state, idx);
  const legal = getLegalActions(state, idx);
  if (!legal) throw new Error('Бот пытается ходить не в свою очередь');

  const p = STYLE_PARAMS[seat.style ?? 'balanced'];
  const pot = totalPot(state);
  const toCall = legal.callAmount;
  const r = rand();

  /** Рейз «до» суммы в пределах правил; если это весь стек — олл-ин. */
  const raiseTo = (target: number): PlayerAction => {
    if (!legal.canRaise) return toCall > 0 ? { type: 'call' } : { type: 'check' };
    const to = clamp(Math.round(target), legal.minRaiseTo, legal.maxRaiseTo);
    return to >= legal.maxRaiseTo ? { type: 'allin' } : { type: 'raise', amount: to };
  };
  const passive = (): PlayerAction => (toCall === 0 ? { type: 'check' } : { type: 'fold' });

  // ---- До флопа: оценка стартовой руки по формуле Чена ----
  if (state.stage === 'preflop') {
    const chen = chenScore(seat.hole) + p.preflopShift;
    const bb = state.bigBlind;
    const unraised = state.currentBet <= bb;
    if (unraised) {
      if (chen >= 10 || (chen >= 8 && r < p.aggression)) return raiseTo(pot + 2 * bb);
      if (toCall === 0) return { type: 'check' };
      // Малый блайнд доставляет половину блайнда с рукой послабее.
      if (chen >= 7 || (toCall < bb && chen >= 5)) return { type: 'call' };
      return { type: 'fold' };
    }
    // Против рейза.
    const bigPart = toCall >= (seat.stack + seat.bet) * 0.4;
    if (chen >= 13 || (chen >= 11 && r < p.aggression)) return raiseTo(state.currentBet * 3);
    if (bigPart) return chen >= 11 ? { type: 'call' } : passive();
    if (chen >= 9 || (chen >= 7 && toCall <= 4 * bb)) return { type: 'call' };
    if (r < p.bluff / 2 && toCall <= 4 * bb) return raiseTo(state.currentBet * 3);
    return passive();
  }

  // ---- После флопа: эквити методом Монте-Карло ----
  const opponents = Math.max(1, state.seats.filter((s, i) => i !== idx && s.inHand && !s.folded).length);
  const equity = estimateEquity(seat.hole, state.board, opponents, 300, rand);
  // Преимущество над «средней» рукой: 0 — средняя, 1 — верная победа, < 0 — хуже средней.
  const fair = 1 / (opponents + 1);
  const edge = (equity - fair) / (1 - fair);

  if (toCall === 0) {
    // Ставок нет: ставим с сильной рукой, иногда блефуем, иначе чек.
    if (edge > 0.35 - p.aggression * 0.3) return raiseTo(pot * (edge > 0.65 ? 0.75 : 0.5 + r * 0.2));
    if (r < p.bluff) return raiseTo(pot * 0.5);
    return { type: 'check' };
  }

  // Против ставки: сначала решаем, не повысить ли.
  if (edge > 0.6 - p.aggression * 0.3 && r < 0.5 + p.aggression) {
    return raiseTo(state.currentBet + (pot + toCall) * (edge > 0.8 ? 1 : 0.7));
  }
  // Шансы банка: колл выгоден, если вероятность выигрыша больше доли, которую мы докладываем.
  // Ставящий обычно сильнее случайной руки, поэтому требуем небольшой запас.
  const potOdds = toCall / (pot + toCall);
  if (equity + p.looseness >= potOdds * 1.15 + 0.03) return { type: 'call' };
  // Редкий блеф-рейз против небольшой ставки.
  if (r < p.bluff / 2 && toCall < pot / 3) return raiseTo(state.currentBet + (pot + toCall) * 0.8);
  return { type: 'fold' };
}

/**
 * Боты ходят по очереди, пока ход не дойдёт до человека или раздача не закончится.
 * onStep вызывается после каждого хода бота (сервис сохраняет кадры для анимации).
 */
export function playBotsUntilHuman(state: TableState, onStep?: () => void, rand: () => number = Math.random): void {
  let guard = 0;
  while (state.stage !== 'finished' && state.toAct >= 0 && seatAt(state, state.toAct).isBot) {
    const idx = state.toAct;
    applyAction(state, idx, decideBotAction(state, idx, rand));
    onStep?.();
    if (++guard > 1000) throw new Error('Боты не смогли закончить торговлю');
  }
}
