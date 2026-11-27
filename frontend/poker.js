'use strict';
// Покер «Техасский холдем» против ботов — раздел #poker.
// Вся игра идёт на сервере (/api/poker): колода и карты ботов в браузер не приходят.
// Фишки за столом — те же монеты, что на балансе: бай-ин списывается при посадке
// и возвращается, когда игрок встаёт из-за стола. Общие функции — из cases.js (window.ScrumDrop).
(() => {
  const SD = window.ScrumDrop;
  const section = document.getElementById('poker');
  const root = document.getElementById('poker-app');
  const toast = document.getElementById('poker-toast');
  const announcer = document.getElementById('poker-status');

  const api = {
    config: () => SD.api('/poker/config'),
    state: () => SD.api('/poker/state'),
    sit: body => SD.api('/poker/sit', { method: 'POST', body }),
    act: action => SD.api('/poker/action', { method: 'POST', body: action }),
    nextHand: () => SD.api('/poker/next-hand', { method: 'POST' }),
    leave: () => SD.api('/poker/leave', { method: 'POST' }),
    history: () => SD.api('/poker/history?limit=12').then(data => data.hands),
  };

  // ---------------------------------------------------------------------------
  // Состояние
  // ---------------------------------------------------------------------------
  const freshStore = () => ({
    config: null,
    balance: 0,
    history: [],
    session: null,
    view: null,
    closed: null,
    busy: false,       // идёт запрос или анимация ходов ботов — кнопки заблокированы
    raiseTo: 0,
    raiseKey: '',
    confirmLeave: false,
    notice: '',
    fatal: '',
    form: { buyIn: 0, bots: 3 },
  });
  const store = freshStore();
  let shown = { handNo: -1, board: 0 };  // что уже показано — анимируем только новые карты
  let pendingSit = null;                  // { buyIn, bots, requestId } — тот же requestId при повторе после сбоя сети
  let epoch = 0;                          // меняется при выходе из аккаунта: старые ответы игнорируются
  let focusKey = null;                    // какой элемент вернуть в фокус после перерисовки
  let requestedFocus = null;              // куда поставить фокус при следующей перерисовке

  // Подсказка по комбинациям: открыта или свёрнута — запоминаем в браузере игрока.
  const COMBOS_KEY = 'scrumdrop-poker-combos';
  const combosOpen = (() => {
    try {
      const saved = localStorage.getItem(COMBOS_KEY);
      if (saved === 'open' || saved === 'closed') return saved === 'open';
    } catch {}
    return matchMedia('(min-width: 1051px)').matches; // на узком экране панель уходит под стол — там сначала свёрнута
  })();

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------------
  // Разметка
  // ---------------------------------------------------------------------------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = n => Number(n).toLocaleString('ru-RU');
  /** Число со знаком: +12, −6, 0 (настоящий минус, как в истории кейсов). */
  const signed = n => (n > 0 ? '+' + fmt(n) : n < 0 ? '−' + fmt(-n) : '0');
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SUIT_NAME = { s: 'пик', h: 'червей', d: 'бубен', c: 'треф' };
  const RANK_NAME = { T: '10', J: 'валет', Q: 'дама', K: 'король', A: 'туз' };
  const rankText = card => (card[0] === 'T' ? '10' : card[0]);
  const isRed = card => card[1] === 'h' || card[1] === 'd';
  const cardName = card => (RANK_NAME[card[0]] || card[0]) + ' ' + SUIT_NAME[card[1]];

  /** Карта. o: { size: 'sm'|'md'|'lg', hl, dim, deal: задержка анимации в мс или null }. */
  function cardHtml(card, o = {}) {
    const cls = ['card', o.size || 'md'];
    const delay = o.deal != null ? ` data-d="${o.deal}"` : '';
    if (o.deal != null) cls.push('deal');
    if (o.dim) cls.push('dim');
    if (!card) return `<div class="${cls.join(' ')} back" role="img" aria-label="Карта рубашкой вверх"${delay}></div>`;
    if (isRed(card)) cls.push('red');
    if (o.hl) cls.push('hl');
    const suit = SUIT[card[1]];
    return `<div class="${cls.join(' ')}" role="img" aria-label="${cardName(card)}"${delay}>` +
      `<span class="corner" aria-hidden="true">${rankText(card)}<i>${suit}</i></span><span class="pip" aria-hidden="true">${suit}</span></div>`;
  }

  /** Карты строкой — для таблицы истории. */
  function miniCards(cards) {
    if (!cards.length) return '<span class="muted">—</span>';
    return cards.map(c => `<span class="mini${isRed(c) ? ' red' : ''}" role="img" aria-label="${cardName(c)}">${rankText(c)}${SUIT[c[1]]}</span>`).join('');
  }

  // ---------- Лобби ----------
  function lobbyHtml() {
    const cfg = store.config;
    const form = store.form;
    const bb = cfg.bigBlind;
    const maxBuy = Math.min(cfg.maxBuyIn, store.balance);

    let blocker = '';
    if (!cfg.isActive) {
      blocker = '<p class="blocker">Покер временно отключён администратором.</p>';
    } else if (store.balance < cfg.minBuyIn) {
      blocker = `<div class="blocker"><p>Чтобы сесть за стол, нужно хотя бы ${SD.coins(cfg.minBuyIn)}, а на балансе ${SD.coins(store.balance)}.</p>
        <button type="button" class="btn primary" data-action="top-up">Пополнить баланс</button></div>`;
    }

    const botButtons = Array.from({ length: cfg.maxBots }, (_, i) => i + 1).map(n =>
      `<label class="seg-item${n === form.bots ? ' on' : ''}"><input type="radio" name="bots" value="${n}"${n === form.bots ? ' checked' : ''}>${n}</label>`).join('');
    const opponents = cfg.bots.slice(0, form.bots).map(b => `<span class="opp"><b>${esc(b.name)}</b> ${esc(b.style)}</span>`).join('');

    const presets = [[cfg.minBuyIn, 'Мин'], [50 * bb, '50 ББ'], [100 * bb, '100 ББ'], [maxBuy, 'Макс']]
      .filter(([v], i, all) => v >= cfg.minBuyIn && v <= maxBuy && all.findIndex(([w]) => w === v) === i)
      .map(([v, label]) => `<button type="button" class="chip-btn" data-action="buyin-preset" data-v="${v}">${label}</button>`)
      .join('');

    const sitForm = `<form class="sit-form">
      <div class="field">
        <div class="field-head"><label for="pk-buyin">Бай-ин</label><output name="buyInOut" for="pk-buyin">${fmt(form.buyIn)}</output></div>
        <input type="range" id="pk-buyin" name="buyIn" min="${cfg.minBuyIn}" max="${maxBuy}" step="1" value="${form.buyIn}" aria-describedby="pk-buyin-hint">
        <div class="presets">${presets}</div>
        <div class="hint" id="pk-buyin-hint">${buyInHint(form.buyIn)}</div>
      </div>
      <fieldset class="field">
        <legend>Соперники</legend>
        <div class="seg">${botButtons}</div>
        <div class="opps">${opponents}</div>
      </fieldset>
      <button class="btn primary big" type="submit" name="sit"${store.busy ? ' disabled' : ''}>Сесть за стол</button>
    </form>`;

    return `
    <div class="lobby">
      ${store.notice ? `<p class="pk-notice" role="status">${esc(store.notice)}</p>` : ''}
      <div class="panel lobby-hero">
        <div class="hero-text">
          <h2>Техасский холдем</h2>
          <p class="lead">No-Limit, блайнды ${cfg.smallBlind}/${bb}. Соперники — боты с разным характером.
          Бай-ин списывается с баланса монет, а когда вы встаёте из-за стола, все фишки возвращаются на баланс: одна фишка — одна монета.</p>
          <p class="lobby-balance">На балансе <i class="chip" aria-hidden="true"></i><b>${fmt(store.balance)}</b> ${SD.coinWord(store.balance)}</p>
        </div>
        ${blocker || sitForm}
      </div>
      <div class="panel">
        <h2>Последние раздачи</h2>
        ${historyHtml(store.history)}
      </div>
    </div>`;
  }

  function buyInHint(value) {
    const cfg = store.config;
    return `От ${fmt(cfg.minBuyIn)} до ${fmt(cfg.maxBuyIn)} монет · это ${Math.round(value / cfg.bigBlind)} больших блайндов`;
  }

  function historyHtml(items) {
    if (!items.length) return '<p class="muted">Вы ещё не играли. Садитесь за стол!</p>';
    const date = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const rows = items.map(h => {
      const profit = h.won - h.invested;
      const cls = profit > 0 ? 'plus' : profit < 0 ? 'minus' : '';
      return `<tr>
        <td class="muted">${date.format(new Date(h.createdAt))}</td>
        <td>${miniCards(h.holeCards)}</td>
        <td>${miniCards(h.board)}</td>
        <td>${fmt(h.pot)}</td>
        <td class="${cls}">${signed(profit)}</td>
        <td class="summary">${esc(h.summary)}</td>
      </tr>`;
    }).join('');
    return `<div class="table-scroll"><table class="history">
      <thead><tr><th>Когда</th><th>Карты</th><th>Борд</th><th>Банк</th><th>Итог</th><th>Результат</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  // ---------- Стол ----------
  function actionBadge(a) {
    const map = {
      fold: ['Фолд', 'fold'],
      check: ['Чек', 'calm'],
      call: ['Колл ' + fmt(a.amount), 'calm'],
      bet: ['Бет ' + fmt(a.amount), 'aggr'],
      raise: ['Рейз до ' + fmt(a.amount), 'aggr'],
      allin: ['Олл-ин ' + fmt(a.amount), 'allin'],
      sb: ['МБ ' + fmt(a.amount), 'blind'],
      bb: ['ББ ' + fmt(a.amount), 'blind'],
    };
    const [text, tone] = map[a.kind];
    return `<div class="badge ${tone}">${text}</div>`;
  }

  /** Место на овальном столе: игрок всегда внизу, остальные — по часовой стрелке. Координаты в %. */
  function seatPos(rel, n) {
    const a = ((90 + (rel * 360) / n) * Math.PI) / 180;
    const r = v => Math.round(v * 100) / 100;
    return { x: r(50 + 47 * Math.cos(a)), y: r(50 + 46 * Math.sin(a)), bx: r(50 + 30 * Math.cos(a)), by: r(50 + 27 * Math.sin(a)) };
  }

  function seatHtml(s, rel, ctx, highlight, winner) {
    const n = ctx.view.seats.length;
    const p = seatPos(rel, n);
    const cls = ['seat'];
    if (s.isYou) cls.push('you');
    if (s.isTurn) cls.push('turn');
    if (s.folded) cls.push('folded');
    if (winner) cls.push('winner');
    if (p.y < 30) cls.push('top');
    const cards = s.cards.map((c, i) => cardHtml(c, {
      size: s.isYou ? 'lg' : 'sm',
      hl: c != null && highlight.has(c),
      deal: ctx.dealHole ? (i * n + rel) * 90 : null,
      dim: s.isYou && s.folded,
    })).join('');
    const finished = ctx.view.stage === 'finished';
    const stack = s.allIn && !finished ? 'Олл-ин' : fmt(s.stack);
    return `
    <div class="${cls.join(' ')}" data-pos="${p.x},${p.y}">
      ${winner && s.won > 0 ? `<div class="won">+${fmt(s.won)}</div>` : ''}
      <div class="seat-cards">${cards}</div>
      <div class="seat-box">
        ${s.isDealer ? '<span class="dealer" title="Дилер" aria-label="Дилер">D</span>' : ''}
        <div class="seat-name">${esc(s.name)}${s.isYou ? ' <small>(вы)</small>' : ''}</div>
        <div class="seat-stack">${stack}</div>
        ${s.style ? `<div class="seat-style">${esc(s.style)}</div>` : ''}
        ${s.lastAction && !finished ? actionBadge(s.lastAction) : ''}
      </div>
      ${s.handName && !s.folded ? `<div class="hand-name">${esc(s.handName)}</div>` : ''}
    </div>
    ${s.bet > 0 ? `<div class="bet" data-pos="${p.bx},${p.by}"><i class="chip" aria-hidden="true"></i>${fmt(s.bet)}</div>` : ''}`;
  }

  function raiseLabel(view, amount, legal) {
    if (amount >= legal.maxRaiseTo) return 'Олл-ин ' + fmt(amount);
    return (view.currentBet === 0 ? 'Бет ' : 'Рейз до ') + fmt(amount);
  }

  /** Готовые размеры ставки: минимум, ½ банка, банк, олл-ин (рейз «до»). */
  function raisePresets(view, legal) {
    const clampTo = v => Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(v)));
    const afterCall = view.totalPot + legal.callAmount;
    const presets = [
      { label: 'Мин', to: legal.minRaiseTo },
      { label: '½ банка', to: clampTo(view.currentBet + afterCall / 2) },
      { label: 'Банк', to: clampTo(view.currentBet + afterCall) },
      { label: 'Олл-ин', to: legal.maxRaiseTo },
    ];
    return presets.filter((p, i) => i === 0 || p.to !== presets[i - 1].to);
  }

  function controlsHtml(ctx) {
    const { view, busy, closed } = ctx;
    const you = view.seats.find(s => s.isYou);
    if (closed?.reason === 'bust') {
      return `<div class="ctrl-msg">Фишки закончились — игра за этим столом завершена.</div>
        <button type="button" class="btn primary big" data-action="to-lobby">В лобби</button>`;
    }
    if (view.stage === 'finished') {
      return `<button type="button" class="btn primary big" data-action="next"${busy ? ' disabled' : ''}>Следующая раздача <kbd>Enter</kbd></button>`;
    }
    const L = view.legal;
    if (!L || busy) {
      return `<div class="ctrl-msg wait">${you.folded ? 'Вы сбросили карты, соперники доигрывают' : 'Соперники думают'}<span class="dots" aria-hidden="true"></span></div>`;
    }
    const callBtn = L.canCheck
      ? '<button type="button" class="btn calm" data-action="check">Чек <kbd>C</kbd></button>'
      : `<button type="button" class="btn calm" data-action="call">${L.callAmount >= you.stack ? 'Олл-ин' : 'Колл'} ${fmt(L.callAmount)} <kbd>C</kbd></button>`;
    let raise = '';
    if (L.canRaise) {
      const presets = raisePresets(view, L).map(p => `<button type="button" class="chip-btn" data-action="preset" data-to="${p.to}">${p.label}</button>`).join('');
      raise = `
        <div class="raise">
          <div class="presets">${presets}</div>
          <div class="raise-row">
            <label class="sr-only" for="pk-raise">Сумма ставки</label>
            <input type="range" id="pk-raise" name="raise" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" step="1" value="${ctx.raiseTo}">
            <label class="sr-only" for="pk-raise-num">Сумма ставки числом</label>
            <input type="number" id="pk-raise-num" name="raiseNum" min="${L.minRaiseTo}" max="${L.maxRaiseTo}" value="${ctx.raiseTo}">
          </div>
        </div>
        <button type="button" class="btn aggr" data-action="raise">${raiseLabel(view, ctx.raiseTo, L)} <kbd>R</kbd></button>`;
    }
    return `<button type="button" class="btn fold" data-action="fold">Фолд <kbd>F</kbd></button>${callBtn}${raise}`;
  }

  function resultHtml(view, seatName) {
    const r = view.result;
    if (!r || view.stage !== 'finished') return '';
    const pots = r.pots.length > 1
      ? `<ul class="pots">${r.pots.map((p, i) => `<li>${i === 0 ? 'Основной банк' : 'Побочный банк ' + i} ${fmt(p.amount)} — ${p.winners.map(w => esc(seatName(w))).join(', ')}${p.handName ? ` (${esc(p.handName)})` : ''}</li>`).join('')}</ul>`
      : '';
    return `<div class="result">${esc(r.summary)}${pots}</div>`;
  }

  function tableHtml(ctx) {
    const { view, session } = ctx;
    const n = view.seats.length;
    const youIdx = view.seats.findIndex(s => s.isYou);
    const you = view.seats[youIdx];
    const r = view.result;

    // Победители банка и их лучшие 5 карт подсвечиваются.
    const winners = new Set(r && view.stage === 'finished' ? r.pots.flatMap(p => p.winners) : []);
    const highlight = new Set();
    if (r?.showdown) for (const id of r.pots[0]?.winners || []) (r.bestCards[id] || []).forEach(c => highlight.add(c));
    const seatName = id => {
      const s = view.seats.find(x => x.id === id);
      return s ? (s.isYou ? 'Вы' : s.name) : id;
    };

    const seats = view.seats.map((s, i) => seatHtml(s, (i - youIdx + n) % n, ctx, highlight, winners.has(s.id))).join('');
    const board = Array.from({ length: 5 }, (_, i) => {
      const c = view.board[i];
      if (!c) return '<div class="card md slot" aria-hidden="true"></div>';
      const fresh = i >= ctx.boardFrom;
      return cardHtml(c, { size: 'md', hl: highlight.has(c), deal: fresh ? (i - ctx.boardFrom) * 220 : null });
    }).join('');

    const inHand = view.stage !== 'finished' && !you.folded;
    const leave = ctx.confirmLeave
      ? `<div class="leave-confirm" role="group" aria-label="Встать из-за стола?">Карты будут сброшены, поставленное останется в банке.
           <button type="button" class="btn small danger" data-action="leave-yes">Встать</button>
           <button type="button" class="btn small ghost" data-action="leave-no">Остаться</button></div>`
      : `<button type="button" class="btn small ghost" data-action="leave"${ctx.busy || ctx.closed ? ' disabled' : ''}${inHand ? ' data-confirm="1"' : ''}>Встать из-за стола</button>`;

    const st = session.stats;
    return `
    <div class="table-screen">
      <div class="table-col">
        <div class="table-bar">
          <div class="tb-info">
            <b>Раздача #${view.handNo}</b>
            <span>Блайнды ${view.smallBlind}/${view.bigBlind}</span>
            <span>Бай-ин ${fmt(session.buyIn)}</span>
            <span>Раздач ${st.handsPlayed} · в плюс ${st.handsWon}</span>
          </div>
          ${leave}
        </div>
        <div class="table-wrap">
          <div class="rail"><div class="felt">
            <div class="center">
              ${resultHtml(view, seatName) || `<div class="pot">Банк <b>${fmt(view.totalPot)}</b></div>`}
              <div class="board" role="group" aria-label="Общие карты">${board}</div>
            </div>
            ${seats}
          </div></div>
        </div>
        <div class="controls">${controlsHtml(ctx)}</div>
      </div>
      <aside class="side-col">
        <div data-slot="combos"></div>
        <section class="log-col" aria-label="Ход раздачи">
          <h3>Ход раздачи</h3>
          <ol class="log">${view.log.map(l => `<li>${esc(l)}</li>`).join('')}</ol>
        </section>
      </aside>
    </div>`;
  }

  // ---------- Подсказка по комбинациям ----------
  // prefix — начало названия руки, которое присылает сервер (evaluator.ts): по нему подсвечиваем строку.
  // Порядок важен: «Стрит-флеш» проверяется раньше «Стрита», «Две пары» — раньше «Пары».
  const COMBOS = [
    { key: 'royal', prefix: 'Роял-флеш', name: 'Роял-флеш', cards: 'As Ks Qs Js Ts', desc: 'Туз, король, дама, валет, 10 одной масти' },
    { key: 'straight-flush', prefix: 'Стрит-флеш', name: 'Стрит-флеш', cards: '9h 8h 7h 6h 5h', desc: 'Пять карт подряд одной масти' },
    { key: 'quads', prefix: 'Каре', name: 'Каре', cards: 'Qc Qd Qh Qs 7d', desc: 'Четыре карты одного ранга' },
    { key: 'full-house', prefix: 'Фулл-хаус', name: 'Фулл-хаус', cards: 'Ks Kh Kd 4c 4s', desc: 'Сет и пара' },
    { key: 'flush', prefix: 'Флеш', name: 'Флеш', cards: 'Ad Jd 8d 6d 2d', desc: 'Пять карт одной масти, не подряд' },
    { key: 'straight', prefix: 'Стрит', name: 'Стрит', cards: 'Tc 9d 8h 7s 6c', desc: 'Пять карт подряд, масть любая' },
    { key: 'trips', prefix: 'Сет', name: 'Сет (тройка)', cards: '7s 7h 7d Kc 3s', desc: 'Три карты одного ранга' },
    { key: 'two-pair', prefix: 'Две пары', name: 'Две пары', cards: 'Js Jd 5c 5h As', desc: 'Две пары разного ранга' },
    { key: 'pair', prefix: 'Пара', name: 'Пара', cards: 'Th Ts Kd 6c 3h', desc: 'Две карты одного ранга' },
    { key: 'high', prefix: 'Старшая карта', name: 'Старшая карта', cards: 'Ac Qd 9s 5h 3c', desc: 'Нет комбинации — решает старшая карта' },
  ];

  /** Какая комбинация сейчас у игрока: по названию с сервера, а до флопа — пара или старшая карта. */
  function currentCombo(view) {
    const you = view.seats.find(s => s.isYou);
    if (!you || you.folded || you.cards.length !== 2 || you.cards.some(c => !c)) return null;
    if (you.handName) return COMBOS.find(c => you.handName.startsWith(c.prefix))?.key ?? null;
    return you.cards[0][0] === you.cards[1][0] ? 'pair' : 'high';
  }

  // Панель создаётся один раз и переставляется в каждую новую разметку стола:
  // так она не теряет состояние «открыта/свёрнута», а при перерисовке меняется только подсветка.
  const combosPanel = (() => {
    const rows = COMBOS.map(c => {
      const cards = c.cards.split(' ').map(card => `<span class="mini${isRed(card) ? ' red' : ''}">${rankText(card)}${SUIT[card[1]]}</span>`).join('');
      return `<li class="combo" data-combo="${c.key}">
        <div class="combo-head"><b>${c.name}</b><span class="combo-cards" aria-hidden="true">${cards}</span></div>
        <div class="combo-desc">${c.desc}<span class="combo-you" hidden> · у вас</span></div>
      </li>`;
    }).join('');
    const template = document.createElement('template');
    template.innerHTML = `<details class="combos">
      <summary data-action="combos"><span>Комбинации</span><small>от старшей к младшей</small></summary>
      <ol class="combo-list">${rows}</ol>
      <p class="combo-note">Считаются лучшие 5 из 7 карт: двух ваших и пяти общих. В стрите туз бывает и единицей: A-2-3-4-5.</p>
    </details>`;
    const panel = template.content.firstElementChild;
    panel.open = combosOpen;
    panel.addEventListener('toggle', () => {
      try { localStorage.setItem(COMBOS_KEY, panel.open ? 'open' : 'closed'); } catch {}
    });
    return panel;
  })();

  /** Подсвечивает текущую комбинацию игрока. */
  function updateCombos(view) {
    const mine = currentCombo(view);
    for (const row of combosPanel.querySelectorAll('.combo')) {
      const on = row.dataset.combo === mine;
      row.classList.toggle('mine', on);
      if (on) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      row.querySelector('.combo-you').hidden = !on;
    }
  }

  // ---------------------------------------------------------------------------
  // Отрисовка
  // ---------------------------------------------------------------------------
  function keyOf(el) {
    if (el.dataset?.action) return '[data-action="' + el.dataset.action + '"]';
    if (el.name) return '[name="' + el.name + '"]' + (el.type === 'radio' ? '[value="' + el.value + '"]' : '');
    return null;
  }

  function render() {
    const active = document.activeElement;
    if (requestedFocus) {
      focusKey = requestedFocus;
      requestedFocus = null;
    } else if (active && active !== document.body && root.contains(active)) {
      focusKey = keyOf(active);
    }

    let body;
    if (store.fatal) {
      body = `<div class="panel fatal"><p>${esc(store.fatal)}</p><button type="button" class="btn primary" data-action="retry">Повторить</button></div>`;
    } else if (store.session && store.view) {
      const view = store.view;
      syncRaise(view);
      const newHand = view.handNo !== shown.handNo;
      body = tableHtml({
        session: store.session,
        view,
        busy: store.busy,
        raiseTo: store.raiseTo,
        closed: store.closed,
        confirmLeave: store.confirmLeave,
        dealHole: newHand,
        boardFrom: newHand ? 0 : Math.min(shown.board, view.board.length),
      });
      shown = { handNo: view.handNo, board: view.board.length };
    } else if (store.config) {
      body = lobbyHtml();
    } else {
      body = '<p class="loading muted">Загрузка…</p>';
    }
    section.classList.toggle('seated', Boolean(store.session && store.view && !store.fatal));
    root.innerHTML = body;

    // CSP запрещает style="…" в разметке, поэтому координаты мест и задержки анимации ставим через CSSOM.
    for (const el of root.querySelectorAll('[data-pos]')) {
      const [x, y] = el.dataset.pos.split(',');
      el.style.left = x + '%';
      el.style.top = y + '%';
    }
    for (const el of root.querySelectorAll('[data-d]')) el.style.setProperty('--d', el.dataset.d + 'ms');

    const combosSlot = root.querySelector('[data-slot="combos"]');
    if (combosSlot) {
      updateCombos(store.view);
      combosSlot.replaceWith(combosPanel);
    }

    const log = root.querySelector('.log');
    if (log) log.scrollTop = log.scrollHeight;

    // Фокус пропал вместе со старой разметкой — возвращаем его на ту же кнопку или на первое действие.
    if (focusKey && (!document.activeElement || document.activeElement === document.body)) {
      const target = root.querySelector(focusKey + ':not(:disabled)') ||
        root.querySelector('.controls button:not(:disabled), [name="sit"]:not(:disabled), [data-action="top-up"], [data-action="retry"]');
      target?.focus({ preventScroll: true });
    }
  }

  /** При новом круге торговли ползунок рейза — на минимум. */
  function syncRaise(view) {
    const L = view.legal;
    const key = L ? `${view.handNo}:${view.stage}:${view.currentBet}:${L.minRaiseTo}` : '';
    if (key !== store.raiseKey) {
      store.raiseKey = key;
      if (L) store.raiseTo = L.minRaiseTo;
    }
  }

  function updateRaiseControls() {
    const view = store.view;
    const legal = view?.legal;
    if (!legal) return;
    const range = root.querySelector('input[name=raise]');
    const num = root.querySelector('input[name=raiseNum]');
    const btn = root.querySelector('[data-action=raise]');
    if (range) range.value = String(store.raiseTo);
    if (num && document.activeElement !== num) num.value = String(store.raiseTo);
    if (btn) btn.innerHTML = `${raiseLabel(view, store.raiseTo, legal)} <kbd>R</kbd>`;
  }

  let toastTimer = 0;
  function showError(error) {
    toast.textContent = error instanceof Error ? error.message : String(error);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4500);
  }

  /** Короткое сообщение для экранного диктора: что произошло за столом. */
  function announce(view) {
    const text = view.stage === 'finished' && view.result ? view.result.summary : view.log[view.log.length - 1];
    if (text && announcer.textContent !== text) announcer.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Загрузка
  // ---------------------------------------------------------------------------
  function setBalance(balance) {
    store.balance = balance;
    if (store.config) store.config.balance = balance;
    SD.setBalance(balance);
  }

  function clampForm() {
    const cfg = store.config;
    if (!cfg) return;
    const maxBuy = Math.min(cfg.maxBuyIn, store.balance);
    if (!store.form.buyIn) store.form.buyIn = 50 * cfg.bigBlind;
    store.form.buyIn = Math.max(cfg.minBuyIn, Math.min(store.form.buyIn, maxBuy));
    store.form.bots = Math.max(1, Math.min(store.form.bots, cfg.maxBots));
  }

  async function loadLobby(token) {
    const [cfg, hands] = await Promise.all([api.config(), api.history()]);
    if (token !== epoch) return;
    store.config = cfg;
    store.history = hands;
    setBalance(cfg.balance);
    clampForm();
  }

  async function load() {
    const token = epoch;
    try {
      const st = await api.state();
      if (token !== epoch) return;
      setBalance(st.balance);
      if (st.session) {
        if (!store.config) store.config = await api.config();
        if (token !== epoch) return;
        store.session = st.session;
        store.view = st.session.view;
        // Стол восстановлен (перезагрузка, другая вкладка) — без анимации раздачи.
        shown = { handNo: st.session.view.handNo, board: st.session.view.board.length };
      } else {
        store.session = null;
        store.view = null;
        await loadLobby(token);
      }
      store.closed = null;
      store.fatal = '';
    } catch (error) {
      if (token !== epoch || error.status === 401) return; // при 401 cases.js сам откроет вход
      store.fatal = 'Не удалось загрузить покер. ' + error.message;
    }
    if (token === epoch) render();
  }

  // ---------------------------------------------------------------------------
  // Ходы
  // ---------------------------------------------------------------------------
  function frameDelay(prev, cur) {
    if (!prev || prev.handNo !== cur.handNo) return 1300; // раздача карт
    const newCards = cur.board.length - prev.board.length;
    return newCards > 0 ? 900 + newCards * 220 : 750;
  }

  /** Проигрываем кадры: ходы ботов появляются по одному. */
  async function playResponse(resp, token) {
    setBalance(resp.balance);
    if (resp.session) {
      let prev = store.view;
      for (let i = 0; i < resp.frames.length; i++) {
        if (token !== epoch) return;
        const frame = resp.frames[i];
        store.view = frame;
        store.session = { ...resp.session, view: frame };
        render();
        announce(frame);
        if (i < resp.frames.length - 1) await sleep(frameDelay(prev, frame));
        prev = frame;
      }
      if (token !== epoch) return;
      store.session = resp.session;
      store.view = resp.session.view;
      announce(store.view);
    }
    store.closed = resp.closed;
  }

  async function run(request) {
    if (store.busy) return;
    const token = epoch;
    store.busy = true;
    store.confirmLeave = false;
    render();
    try {
      await playResponse(await request(), token);
    } catch (error) {
      if (token !== epoch || error.status === 401) return;
      showError(error);
      if (error.code === 'insufficient_funds' && typeof error.details?.balance === 'number') setBalance(error.details.balance);
      // Стол мог измениться в другой вкладке или ход устарел — перечитываем состояние.
      if ([400, 404, 409].includes(error.status)) {
        const st = await api.state().catch(() => null);
        if (st && token === epoch) {
          setBalance(st.balance);
          store.session = st.session;
          store.view = st.session?.view ?? null;
          if (!st.session) await loadLobby(token).catch(() => {});
        }
      }
    } finally {
      if (token === epoch) {
        store.busy = false;
        render();
      }
    }
  }

  const act = action => run(() => api.act(action));

  function sit() {
    const { buyIn, bots } = store.form;
    if (!pendingSit || pendingSit.buyIn !== buyIn || pendingSit.bots !== bots) pendingSit = { buyIn, bots, requestId: SD.uuid() };
    const body = pendingSit;
    store.notice = '';
    return run(async () => {
      try {
        const resp = await api.sit(body);
        pendingSit = null;
        return resp;
      } catch (error) {
        // Ответ сервера окончательный; при сбое сети повтор уйдёт с тем же requestId и не спишет бай-ин дважды.
        if (error.status !== 0) pendingSit = null;
        throw error;
      }
    });
  }

  async function leave() {
    if (store.busy) return;
    const token = epoch;
    store.busy = true;
    store.confirmLeave = false;
    render();
    try {
      const resp = await api.leave();
      if (token !== epoch) return;
      setBalance(resp.balance);
      const c = resp.closed;
      if (c) {
        store.notice = c.cashOut > 0
          ? `Вы встали из-за стола: на баланс вернулось ${SD.coins(c.cashOut)} (${signed(c.profit)} за игру).`
          : 'Вы встали из-за стола без фишек.';
      }
      await toLobby(token);
    } catch (error) {
      if (token !== epoch || error.status === 401) return;
      showError(error);
      if (error.status === 404) await load();
    } finally {
      if (token === epoch) {
        store.busy = false;
        render();
      }
    }
  }

  async function toLobby(token = epoch) {
    if (store.closed?.reason === 'bust') {
      store.notice = `Фишки закончились: бай-ин ${SD.coins(store.session?.buyIn ?? 0)} проигран. Можно сесть снова.`;
    }
    store.session = null;
    store.view = null;
    store.closed = null;
    await loadLobby(token);
    if (token === epoch) render();
  }

  function setRaise(value) {
    const L = store.view?.legal;
    if (!L || !Number.isFinite(value)) return;
    store.raiseTo = Math.max(L.minRaiseTo, Math.min(L.maxRaiseTo, Math.round(value)));
    updateRaiseControls();
  }

  function raiseNow() {
    const L = store.view?.legal;
    if (!L?.canRaise) return;
    act(store.raiseTo >= L.maxRaiseTo ? { type: 'allin' } : { type: 'raise', amount: store.raiseTo });
  }

  function setBuyIn(value) {
    const cfg = store.config;
    if (!cfg || !Number.isFinite(value)) return;
    const v = Math.max(cfg.minBuyIn, Math.min(cfg.maxBuyIn, store.balance, Math.round(value)));
    store.form.buyIn = v;
    const out = root.querySelector('output[name=buyInOut]');
    const range = root.querySelector('input[name=buyIn]');
    const hint = root.querySelector('#pk-buyin-hint');
    if (out) out.textContent = fmt(v);
    if (range) range.value = String(v);
    if (hint) hint.textContent = buyInHint(v);
  }

  // ---------------------------------------------------------------------------
  // События
  // ---------------------------------------------------------------------------
  root.addEventListener('click', event => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    switch (el.dataset.action) {
      case 'fold': act({ type: 'fold' }); break;
      case 'check': act({ type: 'check' }); break;
      case 'call': act({ type: 'call' }); break;
      case 'raise': raiseNow(); break;
      case 'preset': setRaise(Number(el.dataset.to)); break;
      case 'next': run(api.nextHand); break;
      case 'leave':
        if (el.dataset.confirm) {
          store.confirmLeave = true;
          requestedFocus = '[data-action="leave-no"]';
          render();
        } else {
          leave();
        }
        break;
      case 'leave-yes': leave(); break;
      case 'leave-no':
        store.confirmLeave = false;
        requestedFocus = '[data-action="leave"]';
        render();
        break;
      case 'to-lobby': toLobby().catch(showError); break;
      case 'buyin-preset': setBuyIn(Number(el.dataset.v)); break;
      case 'top-up': SD.openTopUp(); break;
      case 'retry':
        store.fatal = '';
        render();
        load();
        break;
    }
  });

  root.addEventListener('input', event => {
    const t = event.target;
    if (t.name === 'raise' || t.name === 'raiseNum') setRaise(Number(t.value));
    if (t.name === 'buyIn') setBuyIn(Number(t.value));
  });

  root.addEventListener('change', event => {
    const t = event.target;
    if (t.name === 'bots') {
      store.form.bots = Number(t.value);
      render();
    }
    if (t.name === 'raiseNum') t.value = String(store.raiseTo);
  });

  root.addEventListener('submit', event => {
    event.preventDefault();
    sit();
  });

  // Горячие клавиши: F — фолд, C — чек/колл, R — рейз, Enter или N — следующая раздача.
  // e.code работает и в русской раскладке.
  document.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || store.busy || section.hidden) return;
    if (document.querySelector('dialog[open]')) return;
    const view = store.view;
    if (!store.session || !view) return;
    const target = event.target;
    if (target.matches?.('input, select, textarea')) {
      if (event.key === 'Enter' && target.name === 'raiseNum') raiseNow();
      return;
    }
    if (view.stage === 'finished') {
      if ((event.code === 'Enter' || event.code === 'KeyN') && !store.closed && !target.matches?.('button, a, summary')) {
        event.preventDefault();
        run(api.nextHand);
      }
      return;
    }
    const L = view.legal;
    if (!L) return;
    if (event.code === 'KeyF') act({ type: 'fold' });
    else if (event.code === 'KeyC') act({ type: L.canCheck ? 'check' : 'call' });
    else if (event.code === 'KeyR') raiseNow();
  });

  document.addEventListener('focusin', event => {
    if (!root.contains(event.target)) focusKey = null;
  });

  // Баланс изменился в другом месте сайта (пополнение) или игрок вышел из аккаунта.
  document.addEventListener('scrumdrop:user', event => {
    const user = event.detail;
    if (!user) {
      reset();
      return;
    }
    if (user.balance === store.balance) return;
    store.balance = user.balance;
    if (store.config) store.config.balance = user.balance;
    if (store.config && !store.session && !store.busy && !section.hidden) {
      clampForm();
      render();
    }
  });

  function reset() {
    epoch += 1;
    Object.assign(store, freshStore());
    shown = { handNo: -1, board: 0 };
    pendingSit = null;
    focusKey = null;
    announcer.textContent = '';
    section.classList.remove('seated');
    root.replaceChildren();
  }

  /** Вызывается из cases.js, когда открывается раздел #poker. */
  function open() {
    if (!SD.user) return;
    if (store.busy || store.closed) {
      render();
      return;
    }
    if (!store.config && !store.session) render(); // «Загрузка…»
    load();
  }

  window.ScrumDropPoker = Object.freeze({ open, reset });
})();
