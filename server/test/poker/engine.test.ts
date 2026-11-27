import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Card } from '../../src/poker/types.ts';
import {
  applyAction,
  buildPots,
  buildView,
  createTable,
  getLegalActions,
  PokerRuleError,
  startHand,
  type SeatInit,
  type TableState,
} from '../../src/poker/engine.ts';
import { chenScore, decideBotAction, estimateEquity, playBotsUntilHuman } from '../../src/poker/bot.ts';
import { chips, rig, seeded } from './helpers.ts';

const h = (s: string) => s.split(' ') as Card[];

function table(stacks: number[], dealerBefore: number, seed = 1): TableState {
  const rng = seeded(seed);
  const seats: SeatInit[] = stacks.map((stack, i) => ({
    id: i === 0 ? 'player' : `bot${i}`,
    name: i === 0 ? 'Игрок' : `Бот${i}`,
    isBot: i !== 0,
    style: i === 0 ? null : 'balanced',
    stack,
  }));
  const t = createTable({ smallBlind: 5, bigBlind: 10, seats }, rng.int);
  t.dealer = dealerBefore; // startHand сдвинет кнопку на следующее место
  startHand(t, {}, rng.int);
  return t;
}

test('один на один: дилер ставит малый блайнд и ходит первым до флопа, последним после', () => {
  const t = table([1000, 1000], 1); // дилер станет 0
  assert.equal(t.dealer, 0);
  assert.equal(t.seats[0]!.bet, 5);
  assert.equal(t.seats[1]!.bet, 10);
  assert.equal(t.toAct, 0);
  applyAction(t, 0, { type: 'call' });
  assert.equal(t.toAct, 1, 'у большого блайнда есть право хода (опция)');
  applyAction(t, 1, { type: 'check' });
  assert.equal(t.stage, 'flop');
  assert.equal(t.board.length, 3);
  assert.equal(t.toAct, 1, 'после флопа первым ходит не-дилер');
});

test('три игрока: блайнды слева от дилера, первым ходит следующий за большим блайндом', () => {
  const t = table([1000, 1000, 1000], 2); // дилер 0, МБ 1, ББ 2
  assert.equal(t.seats[1]!.bet, 5);
  assert.equal(t.seats[2]!.bet, 10);
  assert.equal(t.toAct, 0);
  const legal = getLegalActions(t, 0)!;
  assert.equal(legal.callAmount, 10);
  assert.equal(legal.minRaiseTo, 20);
  assert.equal(legal.maxRaiseTo, 1000);
  assert.equal(getLegalActions(t, 1), null, 'не его ход');
});

test('все сбросили — банк забирает последний, несыгравшая ставка возвращается', () => {
  const t = table([1000, 1000, 1000], 2);
  applyAction(t, 0, { type: 'raise', amount: 40 });
  applyAction(t, 1, { type: 'fold' });
  applyAction(t, 2, { type: 'fold' });
  assert.equal(t.stage, 'finished');
  assert.equal(t.result?.showdown, false);
  // Игрок выиграл блайнды: 5 + 10.
  assert.deepEqual(t.seats.map((s) => s.stack), [1015, 995, 990]);
  assert.equal(chips(t), 3000);
});

test('рейз меньше минимального запрещён, ход не в свою очередь запрещён', () => {
  const t = table([1000, 1000, 1000], 2);
  assert.throws(() => applyAction(t, 0, { type: 'raise', amount: 15 }), PokerRuleError);
  assert.throws(() => applyAction(t, 1, { type: 'call' }), PokerRuleError);
  assert.throws(() => applyAction(t, 0, { type: 'check' }), PokerRuleError);
  applyAction(t, 0, { type: 'raise', amount: 50 }); // повышение на 40
  const legal = getLegalActions(t, 1)!;
  assert.equal(legal.minRaiseTo, 90, 'следующий рейз — минимум ещё на 40');
});

test('неполный олл-ин не переоткрывает торговлю', () => {
  // Игрок 0: 1000, бот1: 1000, бот2: 75 фишек.
  const t = table([1000, 1000, 75], 2); // дилер 0, МБ 1, ББ 2
  applyAction(t, 0, { type: 'raise', amount: 50 }); // рейз на 40
  applyAction(t, 1, { type: 'call' });
  applyAction(t, 2, { type: 'allin' }); // до 75: повышение на 25 < 40
  assert.equal(t.currentBet, 75);
  const legal = getLegalActions(t, 0)!;
  assert.equal(legal.canRaise, false, 'игрок уже ходил — можно только колл/фолд');
  assert.equal(legal.callAmount, 25);
});

test('побочные банки: кто на какой банк претендует', () => {
  const t = table([1000, 1000, 1000], 2);
  // Всего поставлено: игрок 100 (олл-ин), бот1 300, бот2 300.
  t.seats[0]!.totalBet = 100;
  t.seats[1]!.totalBet = 300;
  t.seats[2]!.totalBet = 300;
  const pots = buildPots(t);
  assert.deepEqual(pots, [
    { amount: 300, eligible: [0, 1, 2] },
    { amount: 400, eligible: [1, 2] },
  ]);
  t.seats[2]!.folded = true;
  assert.deepEqual(buildPots(t), [
    { amount: 300, eligible: [0, 1] },
    { amount: 400, eligible: [1] },
  ]);
});

test('олл-ин до флопа: карты докладываются сами, побочный банк уходит нужному игроку', () => {
  const t = table([100, 1000, 1000], 2); // дилер 0 (игрок, 100 фишек)
  rig(t, [h('As Ah'), h('Kd Kh'), h('Qc Qd')], h('2c 7d 9s 3h 4c'));
  applyAction(t, 0, { type: 'allin' }); // 100
  applyAction(t, 1, { type: 'raise', amount: 500 });
  applyAction(t, 2, { type: 'call' });
  // Бот1 и бот2 ещё могут торговаться между собой — флоп.
  assert.equal(t.stage, 'flop');
  applyAction(t, 1, { type: 'allin' });
  applyAction(t, 2, { type: 'call' });
  assert.equal(t.stage, 'finished');
  assert.equal(t.board.length, 5);
  assert.equal(t.result?.showdown, true);
  // Основной банк 300 — игроку (тузы), побочный 1800 — боту1 (короли).
  assert.equal(t.seats[0]!.stack, 300);
  assert.equal(t.seats[1]!.stack, 1800);
  assert.equal(t.seats[2]!.stack, 0);
  assert.equal(chips(t), 2100);
});

test('ничья: нечётная фишка — первому победителю слева от дилера', () => {
  const t = table([1000, 1000, 1000], 2); // дилер 0, МБ 1, ББ 2
  rig(t, [h('2c 3d'), h('2d 3c'), h('4h 4s')], h('As Ks Qs Js Ts'));
  applyAction(t, 0, { type: 'call' });
  applyAction(t, 1, { type: 'fold' }); // малый блайнд 5 остаётся в банке
  applyAction(t, 2, { type: 'check' });
  while (t.stage !== 'finished') applyAction(t, t.toAct, { type: 'check' });
  // Банк 25 = 10 + 5 + 10 делят игрок 0 и бот 2. Слева от дилера ближе бот 2.
  assert.equal(t.seats[2]!.won, 13);
  assert.equal(t.seats[0]!.won, 12);
  assert.equal(chips(t), 3000);
});

test('ничья на борде делит банк поровну', () => {
  const t = table([1000, 1000, 1000], 2);
  rig(t, [h('2c 3d'), h('2d 3c'), h('4h 4s')], h('As Ks Qs Js Ts'));
  applyAction(t, 0, { type: 'call' });
  applyAction(t, 1, { type: 'call' });
  applyAction(t, 2, { type: 'check' });
  for (let street = 0; street < 3; street++) {
    applyAction(t, t.toAct, { type: 'check' });
    applyAction(t, t.toAct, { type: 'check' });
    applyAction(t, t.toAct, { type: 'check' });
  }
  assert.equal(t.stage, 'finished');
  assert.deepEqual(t.seats.map((s) => s.won), [10, 10, 10]);
  assert.equal(t.result?.pots[0]?.winners.length, 3);
  assert.equal(t.result?.handNames.player, 'Роял-флеш');
});

test('что видит игрок: чужие карты скрыты, на вскрытии открыты, колоды нет', () => {
  const t = table([1000, 1000], 1);
  const v = buildView(t, 0);
  assert.equal(v.seats[0]!.cards.length, 2);
  assert.ok(v.seats[0]!.cards.every((c) => c !== null));
  assert.deepEqual(v.seats[1]!.cards, [null, null]);
  assert.equal(JSON.stringify(v).includes('"deck"'), false);
  assert.ok(v.legal);
  // Доигрываем до вскрытия чеками.
  applyAction(t, 0, { type: 'call' });
  applyAction(t, 1, { type: 'check' });
  while (t.stage !== 'finished') applyAction(t, t.toAct, { type: 'check' });
  const end = buildView(t, 0);
  assert.ok(end.seats[1]!.cards.every((c) => c !== null), 'на вскрытии карты бота открыты');
  assert.ok(end.seats[1]!.handName);
});

test('формула Чена для стартовых рук', () => {
  assert.equal(chenScore(h('As Ad')), 20);
  assert.equal(chenScore(h('As Ks')), 12);
  assert.equal(chenScore(h('Ah Kd')), 10);
  assert.equal(chenScore(h('2c 2d')), 5);
  assert.equal(chenScore(h('7h 2d')), -1);
  assert.equal(chenScore(h('Th 9h')), 8);
});

test('эквити: тузы против случайной руки ~85%', () => {
  const rng = seeded(7);
  const eq = estimateEquity(h('As Ah'), [], 1, 4000, rng.float);
  assert.ok(eq > 0.81 && eq < 0.89, `эквити ${eq}`);
  const nuts = estimateEquity(h('As Ks'), h('Qs Js Ts 2c 3d'), 3, 500, rng.float);
  assert.equal(nuts, 1);
});

test('200 раздач между ботами: фишки сохраняются, раздачи всегда заканчиваются', () => {
  const rng = seeded(2024);
  const seats: SeatInit[] = [
    { id: 'a', name: 'A', isBot: true, style: 'tight', stack: 1000 },
    { id: 'b', name: 'B', isBot: true, style: 'aggressive', stack: 1000 },
    { id: 'c', name: 'C', isBot: true, style: 'balanced', stack: 1000 },
    { id: 'd', name: 'D', isBot: true, style: 'loose', stack: 1000 },
    { id: 'e', name: 'E', isBot: true, style: 'balanced', stack: 1000 },
    { id: 'f', name: 'F', isBot: true, style: 'tight', stack: 1000 },
  ];
  const t = createTable({ smallBlind: 5, bigBlind: 10, seats }, rng.int);
  let expected = 6000;
  let showdowns = 0;
  let folds = 0;
  for (let hand = 0; hand < 200; hand++) {
    const busted = t.seats.filter((s) => s.stack === 0).length;
    expected += busted * 1000;
    startHand(t, { rebuyBotsTo: 1000 }, rng.int);
    assert.equal(chips(t), expected);
    playBotsUntilHuman(t, () => assert.equal(chips(t), expected), rng.float);
    assert.equal(t.stage, 'finished');
    assert.equal(chips(t), expected, `раздача ${t.handNo}`);
    assert.ok(t.seats.every((s) => s.stack >= 0 && Number.isInteger(s.stack)));
    if (t.result!.showdown) showdowns++;
    else folds++;
  }
  // Боты не должны только сбрасывать или только доходить до вскрытия.
  assert.ok(showdowns > 20 && folds > 20, `вскрытий ${showdowns}, без вскрытия ${folds}`);
});

test('бот выбирает только разрешённые действия', () => {
  const rng = seeded(99);
  for (let i = 0; i < 300; i++) {
    const t = table([1000, 300 + i, 1000, 50], i % 4, i);
    let guard = 0;
    while (t.stage !== 'finished' && guard++ < 100) {
      const idx = t.toAct;
      const legal = getLegalActions(t, idx)!;
      const a = decideBotAction(t, idx, rng.float);
      if (a.type === 'check') assert.ok(legal.canCheck);
      if (a.type === 'raise') {
        assert.ok(legal.canRaise);
        assert.ok(a.amount! >= legal.minRaiseTo && a.amount! <= legal.maxRaiseTo);
      }
      applyAction(t, idx, a);
    }
    assert.equal(t.stage, 'finished');
  }
});
