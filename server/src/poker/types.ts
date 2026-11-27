// Типы покера: состояние стола глазами игрока и ответы API /api/poker.
// Клиент (frontend/poker.js) получает ровно эти структуры в JSON.

/** Масть: s — пики, h — червы, d — бубны, c — трефы. */
export type Suit = 's' | 'h' | 'd' | 'c';
/** Ранг: T — десятка, J — валет, Q — дама, K — король, A — туз. */
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';
/** Карта — строка из ранга и масти, например "As" (туз пик) или "Td" (десятка бубен). */
export type Card = `${Rank}${Suit}`;

/** Улица (этап) раздачи. finished — раздача закончилась, есть result. */
export type Stage = 'preflop' | 'flop' | 'turn' | 'river' | 'finished';

/** Что игрок может отправить на сервер. */
export type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'allin';

export interface PlayerAction {
  type: ActionType;
  /** Только для raise: итоговая ставка игрока на этой улице («рейз ДО»). */
  amount?: number;
}

/** Последнее действие игрока — показывается плашкой над местом. */
export type LastActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin' | 'sb' | 'bb';

export interface LastAction {
  kind: LastActionKind;
  amount: number;
}

/** Какие действия сейчас разрешены игроку. */
export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** Сколько нужно доставить, чтобы уравнять (с учётом стека). */
  callAmount: number;
  canRaise: boolean;
  /** Минимальный «рейз до». Если стека не хватает — равен maxRaiseTo (олл-ин). */
  minRaiseTo: number;
  /** Максимальный «рейз до» = олл-ин. */
  maxRaiseTo: number;
}

/** Место за столом так, как его видит конкретный игрок (чужие карты скрыты). */
export interface PublicSeat {
  id: string;
  name: string;
  isBot: boolean;
  isYou: boolean;
  /** Характер бота, например «Осторожный». У игрока null. */
  style: string | null;
  stack: number;
  /** Ставка на текущей улице. */
  bet: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  isDealer: boolean;
  isTurn: boolean;
  lastAction: LastAction | null;
  /** Карты на руках: null — карта рубашкой вверх. Пустой массив — карт нет. */
  cards: (Card | null)[];
  /** Название комбинации (для своих карт — всегда, для чужих — только на вскрытии). */
  handName: string | null;
  /** Сколько фишек игрок забрал из банка в этой раздаче. */
  won: number;
}

export interface PotResult {
  amount: number;
  /** id мест-победителей (несколько — если банк поделили). */
  winners: string[];
  /** Комбинация победителя; null, если все остальные сбросили карты. */
  handName: string | null;
}

export interface HandResult {
  /** Было ли вскрытие карт (иначе все, кроме одного, сбросили). */
  showdown: boolean;
  pots: PotResult[];
  /** id места -> название комбинации (только у дошедших до вскрытия). */
  handNames: Record<string, string>;
  /** id места -> 5 лучших карт (для подсветки). */
  bestCards: Record<string, Card[]>;
  /** Короткий итог для лога и истории. */
  summary: string;
}

/** Всё, что клиент знает о столе в данный момент. */
export interface PublicView {
  handNo: number;
  stage: Stage;
  board: Card[];
  /** Банк без ставок текущей улицы (они лежат перед игроками). */
  pot: number;
  /** Весь банк вместе со ставками текущей улицы. */
  totalPot: number;
  currentBet: number;
  smallBlind: number;
  bigBlind: number;
  seats: PublicSeat[];
  /** Разрешённые действия, если сейчас ход игрока; иначе null. */
  legal: LegalActions | null;
  result: HandResult | null;
  /** Ход текущей раздачи, по строке на событие. */
  log: string[];
}

// ---------- Ответы API ----------

export interface PokerConfig {
  /** Имя игрока за столом (displayName из профиля). */
  playerName: string;
  /** Баланс монет вне стола. */
  balance: number;
  minBuyIn: number;
  maxBuyIn: number;
  smallBlind: number;
  bigBlind: number;
  maxBots: number;
  isActive: boolean;
  /** Соперники в порядке посадки: при выборе N ботов садятся первые N. */
  bots: { name: string; style: string }[];
}

export interface SessionStats {
  handsPlayed: number;
  handsWon: number;
  biggestPot: number;
}

export interface SessionInfo {
  id: number;
  buyIn: number;
  stats: SessionStats;
  view: PublicView;
}

export interface SessionClosed {
  reason: 'bust' | 'leave';
  /** Сколько фишек вернулось на баланс монет (1 фишка = 1 монета). */
  cashOut: number;
  /** cashOut - бай-ин. */
  profit: number;
}

/** Ответ на все запросы, меняющие состояние стола. */
export interface TableResponse {
  /** Баланс монет вне стола. */
  balance: number;
  /** null — игрок не за столом. */
  session: SessionInfo | null;
  /** Промежуточные состояния (ходы ботов по одному) — для анимации. */
  frames: PublicView[];
  /** Заполнено, если этим запросом сессия завершилась. */
  closed: SessionClosed | null;
  /** Только у /sit: true — повтор запроса с тем же requestId, второй бай-ин не списан. */
  repeated?: boolean;
}

export interface HandHistoryItem {
  id: number;
  handNo: number;
  holeCards: Card[];
  board: Card[];
  pot: number;
  invested: number;
  won: number;
  summary: string;
  createdAt: string;
}
