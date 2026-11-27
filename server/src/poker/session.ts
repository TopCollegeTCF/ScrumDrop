// Ход игровой сессии за покерным столом: посадка, раздача, ход игрока, конец раздачи, выход.
// Здесь нет базы данных — только правила поверх движка (engine.ts) и ботов (bot.ts).
// Деньги, блокировки и запись истории — в service.ts.

import { HttpError } from '../http.ts';
import { BOT_PROFILES, playBotsUntilHuman } from './bot.ts';
import {
  applyAction,
  buildView,
  createTable,
  PokerRuleError,
  seatAt,
  startHand,
  STYLE_LABELS,
  totalPot,
  type TableState,
} from './engine.ts';
import type {
  Card,
  PlayerAction,
  PokerConfig,
  PublicView,
  SessionClosed,
  SessionInfo,
  SessionStats,
} from './types.ts';

/**
 * Блайнды под экономику ScrumDrop: новому игроку дают 100 монет, кейс стоит 30.
 * Бай-ин (games.min_bet…max_bet) по умолчанию 40…400 монет — это 20…200 больших блайндов.
 */
export const POKER_RULES = {
  gameCode: 'poker',
  smallBlind: 1,
  bigBlind: 2,
  maxBots: BOT_PROFILES.length,
} as const;

/** Состояние сессии (в PostgreSQL лежит в poker_sessions.state). */
export interface SessionState {
  version: 1;
  table: TableState;
  /** Индекс места живого игрока (всегда 0, но так понятнее). */
  playerIndex: number;
  buyIn: number;
  stats: SessionStats;
  /** Номер последней раздачи, уже записанной в историю. */
  lastRecordedHand: number;
}

/** Данные одной раздачи для истории (таблица poker_hands). */
export interface HandRecord {
  handNo: number;
  holeCards: Card[];
  board: Card[];
  pot: number;
  invested: number;
  won: number;
  resultData: {
    summary: string;
    showdown: boolean;
    pots: { amount: number; winners: string[]; hand: string | null }[];
    shownCards: Record<string, Card[]>;
    playerFolded: boolean;
    playerHand: string | null;
  };
}

export interface GameLimits {
  minBuyIn: number;
  maxBuyIn: number;
  isActive: boolean;
}

export function viewOf(state: SessionState): PublicView {
  return buildView(state.table, state.playerIndex);
}

/** Ошибки правил игры (не ваш ход, неверная сумма рейза) превращаем в ответ 400 с понятным текстом. */
function rules<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof PokerRuleError) throw new HttpError(400, 'invalid_move', error.message);
    throw error;
  }
}

export function makeConfig(playerName: string, balance: number, limits: GameLimits): PokerConfig {
  return {
    playerName,
    balance,
    minBuyIn: limits.minBuyIn,
    maxBuyIn: limits.maxBuyIn,
    smallBlind: POKER_RULES.smallBlind,
    bigBlind: POKER_RULES.bigBlind,
    maxBots: POKER_RULES.maxBots,
    isActive: limits.isActive,
    bots: BOT_PROFILES.map((b) => ({ name: b.name, style: STYLE_LABELS[b.style] })),
  };
}

/** Можно ли сесть за стол с таким бай-ином. */
export function checkCanSit(buyIn: number, limits: GameLimits, balance: number, alreadySeated: boolean): void {
  if (!limits.isActive) throw new HttpError(403, 'game_disabled', 'Покер сейчас отключён администратором');
  if (buyIn < limits.minBuyIn || buyIn > limits.maxBuyIn) {
    throw new HttpError(400, 'invalid_buy_in', `Бай-ин — от ${limits.minBuyIn} до ${limits.maxBuyIn} монет`, {
      field: 'buyIn',
      minBuyIn: limits.minBuyIn,
      maxBuyIn: limits.maxBuyIn,
    });
  }
  if (alreadySeated) throw new HttpError(409, 'already_seated', 'Вы уже сидите за столом');
  if (balance < buyIn) {
    throw new HttpError(402, 'insufficient_funds', `Недостаточно монет: для бай-ина нужно ${buyIn}, на балансе ${balance}.`, {
      buyIn,
      balance,
    });
  }
}

/** Новый стол: игрок на месте 0, боты получают такой же стек. */
export function newSession(playerName: string, buyIn: number, botCount: number): SessionState {
  const table = createTable({
    smallBlind: POKER_RULES.smallBlind,
    bigBlind: POKER_RULES.bigBlind,
    seats: [
      { id: 'player', name: playerName, isBot: false, stack: buyIn },
      ...BOT_PROFILES.slice(0, botCount).map((b, i) => ({
        id: `bot${i + 1}`,
        name: b.name,
        isBot: true,
        style: b.style,
        stack: buyIn,
      })),
    ],
  });
  return {
    version: 1,
    table,
    playerIndex: 0,
    buyIn,
    stats: { handsPlayed: 0, handsWon: 0, biggestPot: 0 },
    lastRecordedHand: 0,
  };
}

export function ensureVersion(state: SessionState): void {
  if (state.version !== 1) throw new HttpError(500, 'poker_state_version', 'Неизвестная версия состояния стола');
}

/** Новая раздача + ходы ботов до очереди игрока. Возвращает кадры для анимации. */
export function dealHand(state: SessionState): PublicView[] {
  if (state.table.stage !== 'finished') {
    throw new HttpError(409, 'hand_in_progress', 'Текущая раздача ещё не закончилась');
  }
  const frames: PublicView[] = [];
  rules(() => startHand(state.table, { rebuyBotsTo: state.buyIn }));
  frames.push(viewOf(state));
  playBotsUntilHuman(state.table, () => frames.push(viewOf(state)));
  return frames;
}

/** Ход игрока и ответы ботов. */
export function playerAct(state: SessionState, action: PlayerAction): PublicView[] {
  const frames: PublicView[] = [];
  rules(() => applyAction(state.table, state.playerIndex, action));
  frames.push(viewOf(state));
  playBotsUntilHuman(state.table, () => frames.push(viewOf(state)));
  return frames;
}

/**
 * Игрок встаёт посреди раздачи: карты сбрасываются, поставленное остаётся в банке,
 * боты доигрывают раздачу между собой.
 */
export function foldAndFinish(state: SessionState): PublicView[] {
  if (state.table.stage === 'finished') return [];
  return playerAct(state, { type: 'fold' });
}

export function playerStack(state: SessionState): number {
  return seatAt(state.table, state.playerIndex).stack;
}

/**
 * Если раздача закончилась и ещё не записана — возвращает запись для истории
 * и обновляет статистику сессии. Иначе null.
 */
export function takeHandRecord(state: SessionState): HandRecord | null {
  const t = state.table;
  const result = t.result;
  if (t.stage !== 'finished' || !result || t.handNo <= state.lastRecordedHand) return null;
  const me = seatAt(t, state.playerIndex);
  const nameOf = (id: string) => t.seats.find((s) => s.id === id)?.name ?? id;

  state.lastRecordedHand = t.handNo;
  state.stats.handsPlayed += 1;
  if (me.won > me.totalBet) state.stats.handsWon += 1;
  state.stats.biggestPot = Math.max(state.stats.biggestPot, me.won);

  return {
    handNo: t.handNo,
    holeCards: [...me.hole],
    board: [...t.board],
    pot: totalPot(t),
    invested: me.totalBet,
    won: me.won,
    resultData: {
      summary: result.summary,
      showdown: result.showdown,
      pots: result.pots.map((p) => ({ amount: p.amount, winners: p.winners.map(nameOf), hand: p.handName })),
      // На вскрытии карты открыты всем — их можно сохранить.
      shownCards: result.showdown
        ? Object.fromEntries(t.seats.filter((s) => s.inHand && !s.folded).map((s) => [s.name, [...s.hole]]))
        : {},
      playerFolded: me.folded,
      playerHand: result.handNames[me.id] ?? null,
    },
  };
}

/** Итог сессии при выходе или проигрыше: что вернуть на баланс и что записать в bets.result_data. */
export function closeSummary(state: SessionState, reason: SessionClosed['reason']) {
  const cashOut = playerStack(state);
  const closed: SessionClosed = { reason, cashOut, profit: cashOut - state.buyIn };
  const betResult = { reason, finalStack: cashOut, profit: closed.profit, ...state.stats };
  return { closed, betResult };
}

export function sessionInfo(id: number, state: SessionState): SessionInfo {
  return { id, buyIn: state.buyIn, stats: state.stats, view: viewOf(state) };
}
