// Движок техасского холдема (No-Limit): состояние стола и правила.
//
// Здесь нет ни базы данных, ни HTTP — только чистая логика, поэтому её легко
// тестировать. Состояние стола (TableState) — обычный JSON-объект: сервис
// хранит его в poker_sessions.state и восстанавливает при каждом запросе.
//
// Основные правила, которые реализованы:
//  • дилер, малый и большой блайнды; в игре один на один дилер ставит малый блайнд
//    и ходит первым до флопа, а после флопа — последним;
//  • минимальный рейз равен предыдущему повышению (не меньше большого блайнда);
//  • олл-ин меньше полного рейза не «переоткрывает» торговлю для тех, кто уже ходил;
//  • несыгравшая (никем не уравненная) ставка возвращается владельцу;
//  • побочные банки, когда кто-то в олл-ине; дележ банка и «лишняя» фишка —
//    первому победителю слева от дилера;
//  • если ставить больше некому (все в олл-ине), оставшиеся карты докладываются сразу.

import type {
  Card,
  HandResult,
  LastAction,
  LegalActions,
  PlayerAction,
  PotResult,
  PublicView,
  Stage,
} from './types.ts';
import { cardsText, cryptoRandomInt, newDeck, shuffle, type RandomInt } from './cards.ts';
import { evaluate, type HandValue } from './evaluator.ts';

export type BotStyle = 'tight' | 'balanced' | 'aggressive' | 'loose';

export const STYLE_LABELS: Record<BotStyle, string> = {
  tight: 'Осторожный',
  balanced: 'Расчётливый',
  aggressive: 'Агрессивный',
  loose: 'Азартный',
};

export interface Seat {
  id: string;
  name: string;
  isBot: boolean;
  style: BotStyle | null;
  stack: number;
  hole: Card[];
  /** Ставка на текущей улице. */
  bet: number;
  /** Всего поставлено в этой раздаче. */
  totalBet: number;
  /** Участвует в текущей раздаче (были фишки на её начало). */
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** Ходил ли после последнего полного рейза. */
  acted: boolean;
  lastAction: LastAction | null;
  /** Сколько забрал из банка в этой раздаче. */
  won: number;
}

export interface TableState {
  handNo: number;
  smallBlind: number;
  bigBlind: number;
  seats: Seat[];
  dealer: number;
  stage: Stage;
  /** Колода — только на сервере, клиенту никогда не отдаётся. */
  deck: Card[];
  board: Card[];
  /** Самая большая ставка на текущей улице. */
  currentBet: number;
  /** Размер последнего полного повышения (минимальный следующий рейз). */
  minRaise: number;
  /** Чей ход (индекс места) или -1. */
  toAct: number;
  log: string[];
  result: HandResult | null;
}

/** Нарушение правил (не тот ход, неверная сумма) — сервер отвечает 400/409. */
export class PokerRuleError extends Error {}

export interface SeatInit {
  id: string;
  name: string;
  isBot: boolean;
  style?: BotStyle | null;
  stack: number;
}

// ---------- Вспомогательные функции ----------

/** Место по индексу. Индексы берутся из самого стола, поэтому пустое место — ошибка движка. */
export function seatAt(state: TableState, index: number): Seat {
  const seat = state.seats[index];
  if (!seat) throw new Error(`Нет места с индексом ${index}`);
  return seat;
}

const isActive = (s: Seat) => s.inHand && !s.folded;
const canAct = (s: Seat) => isActive(s) && !s.allIn;
const needsAction = (state: TableState, s: Seat) => canAct(s) && (!s.acted || s.bet < state.currentBet);

/** Имя для лога: у игрока — «Вы». */
const who = (s: Seat) => (s.isBot ? s.name : 'Вы');
/** Глагол в нужной форме: «Глеб забирает» / «Вы забираете». */
const verb = (s: Seat, bot: string, you: string) => (s.isBot ? bot : you);

/** Следующее по часовой стрелке место после from, удовлетворяющее условию. */
function nextIndex(state: TableState, from: number, pred: (s: Seat) => boolean): number {
  const n = state.seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + k) % n) + n) % n;
    if (pred(seatAt(state, i))) return i;
  }
  return -1;
}

/** Переложить фишки из стека в ставку. Возвращает, сколько реально поставлено. */
function putChips(s: Seat, amount: number): number {
  const paid = Math.min(amount, s.stack);
  s.stack -= paid;
  s.bet += paid;
  s.totalBet += paid;
  if (s.stack === 0) s.allIn = true;
  return paid;
}

export function totalPot(state: TableState): number {
  return state.seats.reduce((sum, s) => sum + s.totalBet, 0);
}

// ---------- Создание стола и начало раздачи ----------

export function createTable(
  opts: { smallBlind: number; bigBlind: number; seats: SeatInit[] },
  rnd: RandomInt = cryptoRandomInt,
): TableState {
  return {
    handNo: 0,
    smallBlind: opts.smallBlind,
    bigBlind: opts.bigBlind,
    seats: opts.seats.map((s) => ({
      id: s.id,
      name: s.name,
      isBot: s.isBot,
      style: s.style ?? null,
      stack: s.stack,
      hole: [],
      bet: 0,
      totalBet: 0,
      inHand: false,
      folded: false,
      allIn: false,
      acted: false,
      lastAction: null,
      won: 0,
    })),
    // Кнопка дилера сдвинется на следующее место при первой раздаче — стартовая позиция случайна.
    dealer: rnd(opts.seats.length),
    stage: 'finished',
    deck: [],
    board: [],
    currentBet: 0,
    minRaise: opts.bigBlind,
    toAct: -1,
    log: [],
    result: null,
  };
}

export interface StartHandOptions {
  /** Если задано — боты без фишек докупаются до этой суммы. */
  rebuyBotsTo?: number;
}

export function startHand(state: TableState, opts: StartHandOptions = {}, rnd: RandomInt = cryptoRandomInt): void {
  if (state.stage !== 'finished') throw new PokerRuleError('Раздача ещё не закончена');

  state.log = [];
  if (opts.rebuyBotsTo) {
    for (const s of state.seats) {
      if (s.isBot && s.stack === 0) {
        s.stack = opts.rebuyBotsTo;
        state.log.push(`${s.name} докупает фишки: ${opts.rebuyBotsTo}`);
      }
    }
  }

  const players = state.seats.filter((s) => s.stack > 0);
  if (players.length < 2) throw new PokerRuleError('Для раздачи нужно хотя бы два игрока с фишками');

  state.handNo += 1;
  for (const s of state.seats) {
    s.hole = [];
    s.bet = 0;
    s.totalBet = 0;
    s.inHand = s.stack > 0;
    s.folded = false;
    s.allIn = false;
    s.acted = false;
    s.lastAction = null;
    s.won = 0;
  }
  state.board = [];
  state.result = null;
  state.deck = shuffle(newDeck(), rnd);
  state.dealer = nextIndex(state, state.dealer, (s) => s.inHand);
  state.log.push(`Раздача #${state.handNo}. Дилер: ${who(seatAt(state, state.dealer))}`);

  // Блайнды. Один на один малый блайнд ставит дилер.
  const sb = players.length === 2 ? state.dealer : nextIndex(state, state.dealer, (s) => s.inHand);
  const bb = nextIndex(state, sb, (s) => s.inHand);
  postBlind(state, sb, state.smallBlind, 'sb');
  postBlind(state, bb, state.bigBlind, 'bb');
  state.currentBet = state.bigBlind;
  state.minRaise = state.bigBlind;

  // По две карты каждому, начиная слева от дилера.
  for (let round = 0; round < 2; round++) {
    let i = state.dealer;
    for (let k = 0; k < players.length; k++) {
      i = nextIndex(state, i, (s) => s.inHand);
      seatAt(state, i).hole.push(state.deck.pop()!);
    }
  }

  state.stage = 'preflop';
  state.toAct = -1;
  advance(state, bb);
}

function postBlind(state: TableState, idx: number, amount: number, kind: 'sb' | 'bb') {
  const s = seatAt(state, idx);
  const paid = putChips(s, amount);
  s.lastAction = { kind: s.allIn ? 'allin' : kind, amount: paid };
  state.log.push(`${who(s)}: ${kind === 'sb' ? 'малый' : 'большой'} блайнд ${paid}${s.allIn ? ' (олл-ин)' : ''}`);
}

// ---------- Действия ----------

export function getLegalActions(state: TableState, idx: number): LegalActions | null {
  if (state.stage === 'finished' || state.toAct !== idx) return null;
  const s = seatAt(state, idx);
  const toCall = Math.max(0, state.currentBet - s.bet);
  const callAmount = Math.min(toCall, s.stack);
  // Рейз имеет смысл, только если есть кому отвечать, и торговля для игрока открыта.
  const someoneCanRespond = state.seats.some((o, i) => i !== idx && canAct(o));
  const canRaise = s.stack > toCall && !s.acted && someoneCanRespond;
  const maxRaiseTo = s.bet + s.stack;
  const minRaiseTo = Math.min(state.currentBet + state.minRaise, maxRaiseTo);
  return {
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount,
    canRaise,
    minRaiseTo,
    maxRaiseTo,
  };
}

export function applyAction(state: TableState, idx: number, action: PlayerAction): void {
  const legal = getLegalActions(state, idx);
  if (!legal) throw new PokerRuleError('Сейчас не ваш ход');
  const s = seatAt(state, idx);
  const name = who(s);

  switch (action.type) {
    case 'fold':
      s.folded = true;
      s.lastAction = { kind: 'fold', amount: 0 };
      state.log.push(`${name}: фолд`);
      break;

    case 'check':
      if (!legal.canCheck) throw new PokerRuleError('Нельзя сделать чек — нужно уравнять ставку');
      s.lastAction = { kind: 'check', amount: 0 };
      state.log.push(`${name}: чек`);
      break;

    case 'call':
      if (!legal.canCall) {
        // Уравнивать нечего — считаем это чеком.
        s.lastAction = { kind: 'check', amount: 0 };
        state.log.push(`${name}: чек`);
        break;
      }
      putChips(s, legal.callAmount);
      s.lastAction = { kind: s.allIn ? 'allin' : 'call', amount: s.bet };
      state.log.push(`${name}: колл ${legal.callAmount}${s.allIn ? ' (олл-ин)' : ''}`);
      break;

    case 'raise': {
      if (!legal.canRaise) throw new PokerRuleError('Повышать ставку сейчас нельзя');
      const to = Number(action.amount);
      if (!Number.isInteger(to)) throw new PokerRuleError('Сумма рейза должна быть целым числом');
      if (to < legal.minRaiseTo || to > legal.maxRaiseTo) {
        throw new PokerRuleError(`Рейз должен быть от ${legal.minRaiseTo} до ${legal.maxRaiseTo}`);
      }
      raiseTo(state, s, to);
      break;
    }

    case 'allin':
      if (legal.canRaise) raiseTo(state, s, legal.maxRaiseTo);
      else if (legal.canCall) return applyAction(state, idx, { type: 'call' });
      else return applyAction(state, idx, { type: 'check' });
      break;

    default:
      throw new PokerRuleError('Неизвестное действие');
  }

  s.acted = true;
  advance(state, idx);
}

function raiseTo(state: TableState, s: Seat, to: number) {
  const wasBet = state.currentBet === 0;
  const raiseSize = to - state.currentBet;
  putChips(s, to - s.bet);
  if (raiseSize >= state.minRaise) {
    // Полный рейз: все остальные снова должны ответить.
    state.minRaise = raiseSize;
    for (const o of state.seats) if (o !== s) o.acted = false;
  }
  // Неполный олл-ин поднимает ставку, но не переоткрывает торговлю.
  state.currentBet = Math.max(state.currentBet, to);
  const kind = s.allIn ? 'allin' : wasBet ? 'bet' : 'raise';
  s.lastAction = { kind, amount: to };
  const text = kind === 'allin' ? `олл-ин ${to}` : kind === 'bet' ? `бет ${to}` : `рейз до ${to}`;
  state.log.push(`${who(s)}: ${text}`);
}

// ---------- Ход игры ----------

function isRoundComplete(state: TableState): boolean {
  const actors = state.seats.filter(canAct);
  if (actors.length === 0) return true;
  // Остался один, кто может ставить, и ему нечего уравнивать — торговаться не с кем.
  if (actors.length === 1 && actors[0]!.bet >= state.currentBet) return true;
  return !actors.some((s) => needsAction(state, s));
}

/** Вызывается после каждого действия: передаёт ход, открывает улицы, завершает раздачу. */
function advance(state: TableState, lastIdx: number): void {
  const active = state.seats.filter(isActive);
  if (active.length === 1) {
    finishByFold(state, active[0]!);
    return;
  }
  if (!isRoundComplete(state)) {
    state.toAct = nextIndex(state, lastIdx, (s) => needsAction(state, s));
    return;
  }
  // Круг торговли закончен — следующая улица. Если ставить некому, докладываем карты до ривера.
  for (;;) {
    closeStreet(state);
    if (state.stage === 'river') {
      showdown(state);
      return;
    }
    dealNextStreet(state);
    if (state.seats.filter(canAct).length >= 2) {
      // После флопа первым ходит первый активный слева от дилера.
      state.toAct = nextIndex(state, state.dealer, canAct);
      return;
    }
  }
}

/** Ставка, которую никто не уравнял, возвращается владельцу. */
function returnUncalled(state: TableState) {
  let top: Seat | null = null;
  let topBet = 0;
  let second = 0;
  for (const s of state.seats) {
    if (s.bet > topBet) {
      second = topBet;
      topBet = s.bet;
      top = s;
    } else if (s.bet > second) {
      second = s.bet;
    }
  }
  if (top && topBet > second) {
    const back = topBet - second;
    top.bet -= back;
    top.totalBet -= back;
    top.stack += back;
    top.allIn = false;
    state.log.push(`${who(top)}: ${verb(top, 'получает', 'получаете')} назад несыгравшую ставку ${back}`);
  }
}

function closeStreet(state: TableState) {
  returnUncalled(state);
  for (const s of state.seats) {
    s.bet = 0;
    s.acted = false;
    if (!s.folded && !s.allIn) s.lastAction = null;
  }
  state.currentBet = 0;
  state.minRaise = state.bigBlind;
}

function dealNextStreet(state: TableState) {
  state.deck.pop(); // сжигаем карту
  if (state.stage === 'preflop') {
    state.board.push(state.deck.pop()!, state.deck.pop()!, state.deck.pop()!);
    state.stage = 'flop';
    state.log.push(`Флоп: ${cardsText(state.board)}`);
  } else if (state.stage === 'flop') {
    state.board.push(state.deck.pop()!);
    state.stage = 'turn';
    state.log.push(`Тёрн: ${cardsText(state.board)}`);
  } else {
    state.board.push(state.deck.pop()!);
    state.stage = 'river';
    state.log.push(`Ривер: ${cardsText(state.board)}`);
  }
}

function finishByFold(state: TableState, winner: Seat) {
  returnUncalled(state);
  const pot = totalPot(state);
  winner.stack += pot;
  winner.won = pot;
  for (const s of state.seats) s.bet = 0;
  const summary = `${who(winner)} ${verb(winner, 'забирает', 'забираете')} банк ${pot} — соперники сбросили карты`;
  state.log.push(summary);
  state.result = {
    showdown: false,
    pots: [{ amount: pot, winners: [winner.id], handName: null }],
    handNames: {},
    bestCards: {},
    summary,
  };
  state.stage = 'finished';
  state.toAct = -1;
}

interface Pot {
  amount: number;
  /** Индексы мест, претендующих на этот банк. */
  eligible: number[];
}

/**
 * Делим фишки на основной и побочные банки.
 * Уровни — разные суммы totalBet. На каждый уровень претендуют те,
 * кто не сбросил карты и поставил не меньше этого уровня.
 */
export function buildPots(state: TableState): Pot[] {
  const seats = state.seats;
  const levels = [...new Set(seats.filter((s) => s.totalBet > 0).map((s) => s.totalBet))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  let orphan = 0;
  for (const level of levels) {
    let amount = 0;
    for (const s of seats) amount += Math.max(0, Math.min(s.totalBet, level) - prev);
    prev = level;
    const eligible = seats.flatMap((s, i) => (isActive(s) && s.totalBet >= level ? [i] : []));
    if (eligible.length === 0) {
      orphan += amount; // деньги сбросивших выше всех ставок — добавим в последний банк
      continue;
    }
    const last = pots[pots.length - 1];
    if (last && last.eligible.join() === eligible.join()) last.amount += amount;
    else pots.push({ amount, eligible });
  }
  const lastPot = pots[pots.length - 1];
  if (orphan > 0 && lastPot) lastPot.amount += orphan;
  return pots;
}

function showdown(state: TableState) {
  const n = state.seats.length;
  const values = new Map<number, HandValue>();
  state.seats.forEach((s, i) => {
    if (!isActive(s)) return;
    const v = evaluate([...s.hole, ...state.board]);
    values.set(i, v);
    state.log.push(`Вскрытие — ${who(s)}: ${cardsText(s.hole)} → ${v.name}`);
  });

  // Порядок для «лишней» фишки при делёжке: по часовой стрелке от дилера.
  const order = (i: number) => (i - state.dealer - 1 + n) % n;
  const pots = buildPots(state);
  const potResults: PotResult[] = [];

  pots.forEach((pot, pi) => {
    let best = -1;
    let winners: number[] = [];
    for (const i of pot.eligible) {
      const score = values.get(i)!.score;
      if (score > best) {
        best = score;
        winners = [i];
      } else if (score === best) {
        winners.push(i);
      }
    }
    winners.sort((a, b) => order(a) - order(b));
    const share = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - share * winners.length;
    for (const w of winners) {
      const amount = share + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      seatAt(state, w).stack += amount;
      seatAt(state, w).won += amount;
    }
    const handName = values.get(winners[0]!)!.name;
    potResults.push({ amount: pot.amount, winners: winners.map((w) => seatAt(state, w).id), handName });
    const potName = pots.length === 1 ? 'Банк' : pi === 0 ? 'Основной банк' : `Побочный банк ${pi}`;
    state.log.push(`${potName} ${pot.amount}: ${winners.map((w) => who(seatAt(state, w))).join(', ')} (${handName})`);
  });

  for (const s of state.seats) s.bet = 0;

  const winnersAll = state.seats.filter((s) => s.won > 0);
  const mainHand = potResults[0]?.handName ?? '';
  const [single] = winnersAll;
  const summary =
    single && winnersAll.length === 1
      ? `${who(single)} ${verb(single, 'забирает', 'забираете')} ${single.won} — ${mainHand}`
      : `Банк делят: ${winnersAll.map((s) => `${who(s)} (${s.won})`).join(', ')} — ${mainHand}`;

  const handNames: Record<string, string> = {};
  const bestCards: Record<string, Card[]> = {};
  for (const [i, v] of values) {
    handNames[seatAt(state, i).id] = v.name;
    bestCards[seatAt(state, i).id] = v.best;
  }
  state.result = { showdown: true, pots: potResults, handNames, bestCards, summary };
  state.stage = 'finished';
  state.toAct = -1;
}

// ---------- Что видит игрок ----------

/** Состояние стола глазами игрока viewerIdx: чужие карты скрыты до вскрытия, колоды нет. */
export function buildView(state: TableState, viewerIdx: number): PublicView {
  const result = state.result;
  const reveal = state.stage === 'finished' && result?.showdown === true;
  const total = totalPot(state);
  const streetBets = state.seats.reduce((sum, s) => sum + s.bet, 0);

  return {
    handNo: state.handNo,
    stage: state.stage,
    board: [...state.board],
    pot: total - streetBets,
    totalPot: total,
    currentBet: state.currentBet,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    seats: state.seats.map((s, i) => {
      const isYou = i === viewerIdx;
      const open = isYou || (reveal && isActive(s));
      let cards: (Card | null)[] = [];
      if (s.inHand && s.hole.length > 0 && (isYou || !s.folded)) {
        cards = open ? [...s.hole] : s.hole.map(() => null);
      }
      let handName: string | null = null;
      if (reveal && isActive(s)) handName = result?.handNames[s.id] ?? null;
      else if (isYou && s.inHand && state.board.length >= 3) handName = evaluate([...s.hole, ...state.board]).name;
      return {
        id: s.id,
        name: s.name,
        isBot: s.isBot,
        isYou,
        style: s.style ? STYLE_LABELS[s.style] : null,
        stack: s.stack,
        bet: s.bet,
        inHand: s.inHand,
        folded: s.folded,
        allIn: s.allIn,
        isDealer: i === state.dealer && state.handNo > 0,
        isTurn: i === state.toAct && state.stage !== 'finished',
        lastAction: s.lastAction,
        cards,
        handName,
        won: s.won,
      };
    }),
    legal: getLegalActions(state, viewerIdx),
    result,
    log: [...state.log],
  };
}
