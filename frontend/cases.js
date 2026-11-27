'use strict';
// ScrumDrop — фронтенд, работающий с серверным API (/api).
// Баланс, коллекция, история, имя и аватарка хранятся на сервере в PostgreSQL.

const get = id => document.getElementById(id);
const API = document.querySelector('meta[name="scrumdrop-api"]')?.content || '/api';
const rarityLabels = { common: 'обычный', rare: 'редкий', epic: 'эпический', legendary: 'легендарный' };
const avatarCodes = ['prism', 'orbit', 'leaf', 'moon', 'eclipse'];
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const state = { user: null, cases: [], inventory: [], summary: [], history: [] };
let selected = null;      // кейс, открытый в диалоге
let pendingOpen = null;   // { code, requestId } — тот же requestId при повторе после сбоя сети
let pendingTopUp = null;  // { amount, requestId }
let afterAuth = null;     // куда вернуться после входа: { hash, caseCode }

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Сервер недоступен. Проверьте подключение и попробуйте ещё раз.', 0, 'network_error');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    if (response.status === 401 && state.user && !path.startsWith('/auth/')) {
      signedOut('Сессия закончилась. Войдите снова.');
    }
    throw new ApiError(error?.message || 'Ошибка сервера (' + response.status + ')', response.status, error?.code, error?.details);
  }
  return data;
}

// crypto.randomUUID есть только на https/localhost; при входе по IP из локальной сети — запасной вариант.
function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const coinWord = n => plural(n, 'монета', 'монеты', 'монет');
const coins = n => n + ' ' + coinWord(n);
const rarity = code => rarityLabels[code] || code;
const percent = chance => Math.round(chance * 1000) / 10 + ' %';

function showNotice(text) {
  const notice = get('notice');
  notice.textContent = text || '';
  notice.hidden = !text;
}

// ---------------------------------------------------------------------------
// Загрузка данных
// ---------------------------------------------------------------------------
async function loadCatalog() {
  try {
    state.cases = (await api('/cases')).cases;
  } catch (error) {
    get('cases').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Не удалось загрузить каталог. ' + error.message }));
    return;
  }
  renderCatalog();
  renderAvatarOptions();
}

async function loadSession() {
  try {
    state.user = (await api('/auth/session')).user;
  } catch (error) {
    state.user = null;
    showNotice(error.message);
  }
}

async function refreshAccount() {
  if (!state.user) return;
  try {
    const [session, inventory, history] = await Promise.all([api('/auth/session'), api('/inventory'), api('/history?limit=50')]);
    state.user = session.user;
    state.inventory = inventory.items;
    state.summary = inventory.summary;
    state.history = history.openings;
  } catch (error) {
    if (error.status !== 401) showNotice(error.message);
  }
  render();
}

function signedOut(message) {
  state.user = null;
  state.inventory = [];
  state.summary = [];
  state.history = [];
  render();
  if (message) showNotice(message);
  showPage();
}

// ---------------------------------------------------------------------------
// Отрисовка
// ---------------------------------------------------------------------------
function showList(id, values, empty) {
  const panel = get(id);
  panel.textContent = empty;
  if (!values.length) return;
  const list = document.createElement('ul');
  for (const value of values) {
    const li = document.createElement('li');
    li.textContent = value;
    list.append(li);
  }
  panel.replaceChildren(list);
}

function render() {
  const user = state.user;
  get('wallet').hidden = !user;
  const link = get('profile-link');
  link.textContent = user ? 'Кабинет' : 'Войти';
  link.href = user ? '#account' : '#login';
  link.setAttribute('aria-label', user ? 'Личный кабинет' : 'Войти в аккаунт');
  updateBuyButton();
  showRecord();
  // poker.js следит за балансом и выходом из аккаунта.
  document.dispatchEvent(new CustomEvent('scrumdrop:user', { detail: user }));
  if (!user) return;

  get('balance').textContent = user.balance;
  get('balance-unit').textContent = coinWord(user.balance);
  get('coins').textContent = user.balance;
  get('coins-unit').textContent = coinWord(user.balance);
  get('opened').textContent = user.stats.opened;
  get('unique').textContent = user.stats.uniqueItems;
  get('player').textContent = user.displayName;
  get('avatar').src = user.avatarImage || 'cases/5.jpg';
  get('account-login').textContent = user.username;
  get('account-email').textContent = user.email;
  for (const input of document.querySelectorAll('#avatar-options input')) input.checked = input.value === user.avatar;

  const last = state.history[0];
  get('feature-title').textContent = last ? 'Последнее открытие' : 'Кейс из каталога';
  get('feature-name').textContent = last ? last.case.name : (state.cases[0]?.name || 'Орбита');
  get('feature-reward').textContent = last ? 'Награда · ' + last.item.name : '';
  get('feature-img').src = last ? last.case.image : (state.cases[0]?.image || 'cases/0.jpg');

  showList('bag', state.summary.map(row => row.name + (row.upgradeLevel ? ' +' + row.upgradeLevel : '') + ' × ' + row.count), 'Здесь появится первый предмет.');
  showList('log', state.history.map(row => dateFormat.format(new Date(row.openedAt)) + ' · ' + row.case.name + ' · ' + row.item.name + ' · −' + row.price), 'Кейсы ещё не открывались.');
}

function renderCatalog() {
  const box = get('cases');
  box.replaceChildren();
  for (const item of state.cases) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'case';
    card.setAttribute('aria-haspopup', 'dialog');
    const img = document.createElement('img');
    img.src = item.image;
    img.alt = '';
    const label = document.createElement('strong');
    label.textContent = item.name;
    card.append(img, label);
    card.onpointermove = e => {
      if (e.pointerType === 'touch') return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--rx', (0.5 - (e.clientY - r.top) / r.height) * 8 + 'deg');
      card.style.setProperty('--ry', ((e.clientX - r.left) / r.width - 0.5) * 10 + 'deg');
    };
    card.onpointerleave = () => { card.style.removeProperty('--rx'); card.style.removeProperty('--ry'); };
    card.onclick = () => openDetail(item);
    box.append(card);
  }
}

function openDetail(item) {
  selected = item;
  get('preview').src = item.image;
  get('name').textContent = item.name;
  get('rewards').textContent = 'Внутри: ' + item.items.map(i => i.name + ' (' + rarity(i.rarity) + ', ' + percent(i.chance) + ')').join(' или ') + '.';
  get('result').textContent = '';
  get('result').classList.remove('error');
  updateBuyButton();
  get('detail').setAttribute('aria-labelledby', 'name');
  if (!get('detail').open) get('detail').showModal();
}

function updateBuyButton() {
  if (!selected) return;
  get('buy').textContent = state.user ? 'Открыть за ' + coins(selected.price) : 'Войти, чтобы открыть';
}

// ---------------------------------------------------------------------------
// Открытие кейса
// ---------------------------------------------------------------------------
get('buy').onclick = async () => {
  if (!state.user) {
    afterAuth = { hash: '#catalog', caseCode: selected?.code };
    get('detail').close();
    location.hash = '#login';
    return;
  }
  const box = selected;
  if (!pendingOpen || pendingOpen.code !== box.code) pendingOpen = { code: box.code, requestId: uuid() };
  const button = get('buy');
  const result = get('result');
  button.disabled = true;
  result.classList.remove('error');
  result.textContent = 'Открываем…';
  try {
    const data = await api('/cases/' + encodeURIComponent(box.code) + '/open', { method: 'POST', body: { requestId: pendingOpen.requestId } });
    pendingOpen = null;
    state.user.balance = data.balance;
    result.textContent = 'Твоя награда — ' + data.opening.item.name + ' (' + rarity(data.opening.item.rarity) + ')!';
    await refreshAccount();
  } catch (error) {
    // Ответ сервера окончательный — следующая попытка будет новым открытием.
    // Сбой сети — оставляем requestId: повтор не спишет монеты дважды.
    if (error.status !== 0) pendingOpen = null;
    result.classList.add('error');
    result.textContent = error.message;
    if (error.code === 'insufficient_funds' && state.user && typeof error.details?.balance === 'number') {
      state.user.balance = error.details.balance;
      render();
    }
  } finally {
    button.disabled = false;
  }
};

// ---------------------------------------------------------------------------
// Вход и регистрация
// ---------------------------------------------------------------------------
function fieldInput(form, field) {
  return field ? form.querySelector('[name="' + field + '"]') : null;
}

async function submitAuth(form, errorBox, path, body) {
  const button = form.querySelector('button');
  errorBox.textContent = '';
  button.disabled = true;
  try {
    const data = await api(path, { method: 'POST', body });
    state.user = data.user;
    form.reset();
    showNotice('');
    await refreshAccount();
    const target = afterAuth;
    afterAuth = null;
    location.hash = target?.hash || '#account';
    const box = target?.caseCode && state.cases.find(c => c.code === target.caseCode);
    if (box) openDetail(box);
  } catch (error) {
    errorBox.textContent = error.message;
    fieldInput(form, error.details?.field)?.focus();
  } finally {
    button.disabled = false;
  }
}

get('login-form').onsubmit = event => {
  event.preventDefault();
  submitAuth(event.target, get('login-error'), '/auth/login', {
    login: get('login-name').value.trim(),
    password: get('login-password').value,
  });
};

get('register-form').onsubmit = event => {
  event.preventDefault();
  submitAuth(event.target, get('register-error'), '/auth/register', {
    username: get('reg-username').value.trim(),
    email: get('reg-email').value.trim(),
    password: get('reg-password').value,
  });
};

get('logout').onclick = async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (error) {
    showNotice(error.message);
    return;
  }
  afterAuth = null;
  history.replaceState(null, '', '#catalog');
  signedOut();
};

// ---------------------------------------------------------------------------
// Профиль: имя и аватарка
// ---------------------------------------------------------------------------
get('name-form').onsubmit = async event => {
  event.preventDefault();
  const input = get('nickname');
  const name = input.value.trim();
  if (!name) { input.setCustomValidity('Введите имя игрока'); input.reportValidity(); return; }
  try {
    state.user = (await api('/me', { method: 'PATCH', body: { displayName: name } })).user;
    render();
    get('saved').textContent = 'Имя сохранено';
  } catch (error) {
    get('saved').textContent = error.message;
  }
};
get('nickname').oninput = event => { event.target.setCustomValidity(''); get('saved').textContent = ''; };

function renderAvatarOptions() {
  const box = get('avatar-options');
  box.replaceChildren();
  for (const code of avatarCodes) {
    const item = state.cases.find(c => c.code === code);
    if (!item) continue;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'avatar';
    input.value = code;
    input.setAttribute('aria-label', item.name);
    input.checked = state.user?.avatar === code;
    const image = document.createElement('img');
    image.src = item.image;
    image.alt = '';
    input.onchange = async () => {
      get('avatar').src = item.image;
      try {
        state.user = (await api('/me', { method: 'PATCH', body: { avatar: code } })).user;
        get('saved').textContent = 'Аватарка сохранена';
      } catch (error) {
        get('saved').textContent = error.message;
      }
      render();
    };
    label.append(input, image);
    box.append(label);
  }
}

// ---------------------------------------------------------------------------
// Пополнение (демо, виртуальные монеты)
// ---------------------------------------------------------------------------
function openTopUp() {
  get('top-up-status').textContent = '';
  if (!get('card-demo').open) get('card-demo').showModal();
}
get('top-up').onclick = openTopUp;

for (const button of document.querySelectorAll('[data-amount]')) {
  button.onclick = async () => {
    const amount = Number(button.dataset.amount);
    if (!pendingTopUp || pendingTopUp.amount !== amount) pendingTopUp = { amount, requestId: uuid() };
    const buttons = document.querySelectorAll('[data-amount]');
    buttons.forEach(b => { b.disabled = true; });
    get('top-up-status').textContent = 'Пополняем…';
    try {
      const data = await api('/wallet/top-up', { method: 'POST', body: pendingTopUp });
      pendingTopUp = null;
      state.user.balance = data.balance;
      render();
      get('top-up-status').textContent = 'Начислено ' + coins(amount) + '. Баланс: ' + data.balance + '.';
    } catch (error) {
      if (error.status !== 0) pendingTopUp = null;
      get('top-up-status').textContent = error.message;
    } finally {
      buttons.forEach(b => { b.disabled = false; });
    }
  };
}

// ---------------------------------------------------------------------------
// Апгрейдер
// ---------------------------------------------------------------------------
const upgradeItem = get('upgrade-item');
function renderUpgrade() {
  upgradeItem.replaceChildren();
  for (const row of state.inventory) {
    if (row.canUpgrade) upgradeItem.add(new Option(row.item.name + ' · ' + row.case.name, row.id));
  }
  const hasItems = upgradeItem.length > 0;
  get('upgrade-form').hidden = !state.user || !hasItems;
  get('upgrade-empty').hidden = Boolean(state.user && hasItems);
  const text = get('upgrade-empty-text');
  const link = get('upgrade-empty-link');
  if (!state.user) {
    text.textContent = 'Чтобы улучшать предметы, ';
    link.textContent = 'войдите в аккаунт';
    link.href = '#login';
  } else {
    text.textContent = state.inventory.length ? 'Все предметы улучшены. Можно открыть ещё один ' : 'Для улучшения нужен предмет из ';
    link.textContent = state.inventory.length ? 'кейс' : 'кейса';
    link.href = '#catalog';
  }
}

get('upgrade-form').onsubmit = async event => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const data = await api('/inventory/' + encodeURIComponent(upgradeItem.value) + '/upgrade', { method: 'POST' });
    get('upgrade-status').textContent = 'Предмет «' + data.item.item.name + '» улучшен до +' + data.item.upgradeLevel + '.';
    await refreshAccount();
  } catch (error) {
    get('upgrade-status').textContent = error.message;
  } finally {
    button.disabled = false;
    renderUpgrade();
  }
};

// ---------------------------------------------------------------------------
// Навигация по разделам
// ---------------------------------------------------------------------------
function showPage() {
  const routes = { '#account': 'overview', '#collection': 'inventory', '#account/inventory': 'inventory', '#account/history': 'history', '#account/settings': 'settings' };
  let hash = location.hash;
  let reason = '';
  if ((routes[hash] || hash === '#poker') && !state.user) {
    afterAuth = { hash };
    reason = hash === '#poker' ? 'Войдите, чтобы играть в покер: бай-ин списывается с баланса аккаунта.' : 'Войдите, чтобы открыть личный кабинет.';
    hash = '#login';
    history.replaceState(null, '', hash);
  } else if ((hash === '#login' || hash === '#register') && state.user) {
    hash = '#account';
    history.replaceState(null, '', hash);
  }

  const tab = routes[hash];
  const inAccount = Boolean(tab);
  const authPage = hash === '#login' || hash === '#register';
  const activity = ['#games', '#upgrade', '#poker'].find(h => h === hash);
  document.querySelector('.hero').hidden = inAccount || authPage || Boolean(activity);
  get('catalog').hidden = inAccount || authPage || Boolean(activity);
  get('games').hidden = activity !== '#games';
  get('upgrade').hidden = activity !== '#upgrade';
  get('poker').hidden = activity !== '#poker';
  get('auth').hidden = !authPage;
  get('account').hidden = !inAccount;
  for (const link of document.querySelectorAll('.main-nav a')) {
    if (!inAccount && !authPage && link.hash === (activity || '#catalog')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (activity !== '#games') resetReaction();
  document.title = inAccount ? 'ScrumDrop — Личный кабинет' : 'ScrumDrop — Коллекция кейсов';

  if (authPage) {
    const register = hash === '#register';
    get('login-form').hidden = register;
    get('register-form').hidden = !register;
    get('auth-title').firstElementChild.textContent = register ? 'Регистрация' : 'Вход';
    get('auth-reason').textContent = reason;
    get('auth-reason').hidden = !reason;
    document.title = 'ScrumDrop — ' + (register ? 'Регистрация' : 'Вход');
    get('auth-title').focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  } else if (activity) {
    const heading = document.querySelector(activity + ' h1');
    document.title = 'ScrumDrop — ' + heading.textContent;
    heading.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (activity === '#upgrade') renderUpgrade();
    if (activity === '#poker') window.ScrumDropPoker?.open();
  } else if (inAccount) {
    get('nickname').value = state.user.displayName;
    get('saved').textContent = '';
    for (const link of document.querySelectorAll('.profile-nav a')) {
      if (routes[link.hash] === tab) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    get('overview').hidden = tab !== 'overview';
    get('inventory-panel').hidden = !['overview', 'inventory'].includes(tab);
    get('history-panel').hidden = !['overview', 'history'].includes(tab);
    get('settings-panel').hidden = tab !== 'settings';
    const heading = document.querySelector('.profile-main section:not([hidden]) :is(h1,h2)');
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  } else if (hash === '#catalog') {
    get('catalog').scrollIntoView();
  }
}

// ---------------------------------------------------------------------------
// Мини-игра «Тест реакции». Рекорд игрока — на сервере, гостя — в браузере.
// ---------------------------------------------------------------------------
const reaction = get('reaction');
const reactionStatus = get('reaction-status');
const recordKey = 'scrumdrop-reaction-v1';
let guestBest = Number(localStorage.getItem(recordKey)) || 0;
let timer;
let signalTime = 0;
function showRecord() {
  const best = state.user ? state.user.reactionBestMs : guestBest;
  get('reaction-record').textContent = best ? 'Рекорд · ' + best + ' мс' : '';
}
function resetReaction() {
  clearTimeout(timer);
  timer = undefined;
  signalTime = 0;
  reaction.classList.remove('ready');
  reaction.textContent = 'Начать';
  reactionStatus.textContent = 'Нажми «Начать» и дождись зелёного сигнала.';
}
async function saveRecord(time) {
  if (!state.user) {
    if (!guestBest || time < guestBest) {
      guestBest = time;
      localStorage.setItem(recordKey, guestBest);
    }
    showRecord();
    return;
  }
  try {
    const data = await api('/games/reaction', { method: 'POST', body: { timeMs: time } });
    state.user.reactionBestMs = data.bestMs;
  } catch (error) {
    reactionStatus.textContent += ' Рекорд не сохранён: ' + error.message;
  }
  showRecord();
}
reaction.onclick = () => {
  if (timer) {
    resetReaction();
    reactionStatus.textContent = 'Слишком рано. Попробуй ещё раз.';
  } else if (signalTime) {
    const time = Math.max(1, Math.round(performance.now() - signalTime));
    resetReaction();
    reactionStatus.textContent = 'Твоя реакция · ' + time + ' мс';
    saveRecord(time);
  } else {
    reactionStatus.textContent = 'Жди зелёного сигнала…';
    reaction.textContent = 'Жди…';
    timer = setTimeout(() => {
      timer = undefined;
      reaction.textContent = 'Сейчас!';
      reactionStatus.textContent = 'Нажимай!';
      reaction.classList.add('ready');
      signalTime = performance.now();
    }, 1100 + Math.random() * 1600);
  }
};

// ---------------------------------------------------------------------------
// Общие функции для других разделов (poker.js)
// ---------------------------------------------------------------------------
window.ScrumDrop = Object.freeze({
  api,
  uuid,
  coins,
  coinWord,
  openTopUp,
  get user() { return state.user; },
  /** Баланс пришёл из другого раздела (например, после бай-ина в покере). */
  setBalance(balance) {
    if (!state.user || state.user.balance === balance) return;
    state.user.balance = balance;
    render();
  },
});

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------
window.addEventListener('hashchange', () => {
  showPage();
  if (state.user && ['#account', '#account/inventory', '#account/history', '#upgrade'].includes(location.hash)) {
    refreshAccount().then(() => { if (location.hash === '#upgrade') renderUpgrade(); });
  }
});

(async () => {
  await Promise.all([loadCatalog(), loadSession()]);
  await refreshAccount();
  render();
  renderAvatarOptions();
  showPage();
})();

// ---------------------------------------------------------------------------
// Фоновая «аврора» на главном экране
// ---------------------------------------------------------------------------
const canvas = get('aurora');
const ctx = canvas.getContext('2d');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let width, height, active = true, frame, last = -100;
function draw(time) {
  const phase = reduced.matches ? 0 : time * 0.00016;
  ctx.clearRect(0,0,width,height);
  const mobile = width < 600;
  const overscan = 16;
  const spacing = mobile ? 4 : 5;
  const base = mobile ? 0.36 : 0.48;
  const amp = mobile ? 0.13 : 0.22;
  const count = Math.ceil((width + overscan * 2) / spacing);
  for (let strand=0;strand<38;strand++) {
    const v=(strand-18)/18;
    const green=Math.abs(v-.26)<.09;
    ctx.fillStyle=green?'rgba(150,241,46,.88)':v<-.5?'#3500d3':v<.27?'#9449ff':'#5424b8';
    ctx.globalAlpha=green?.88:.2+.53*(1-Math.abs(v));
    for(let i=0;i<count;i++){
      const x = i * spacing - overscan;
      const t = x / width;
      const angle=t*7.1+phase*.32+v*.82;
      const y=height*(base+amp*Math.sin(angle)+.14*Math.sin(t*10-phase*.22)+v*(.09+.07*Math.cos(t*8+phase)));
      const size=1.25+(1-Math.abs(v))*1.4;
      ctx.fillRect(x,y,size,size*.64);
      if((strand+i)%4===0)ctx.fillRect(x+size/2,y-size*.45,.8,size*1.5);
    }
  }
  ctx.globalAlpha=1;
}
function tick(time){
  if(time-last>45){draw(time);last=time}
  if(active&&!reduced.matches&&!document.hidden)frame=requestAnimationFrame(tick);
}
function refresh(){
  cancelAnimationFrame(frame);
  const rect=canvas.getBoundingClientRect();width=rect.width;height=rect.height;
  const scale=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
  ctx.setTransform(scale,0,0,scale,0,0);draw(performance.now());
  if(active&&!reduced.matches&&!document.hidden)frame=requestAnimationFrame(tick);
}
new ResizeObserver(refresh).observe(canvas);
new IntersectionObserver(entries=>{active=entries[0].isIntersecting;refresh()}).observe(canvas);
reduced.addEventListener('change',refresh);
document.addEventListener('visibilitychange',refresh);
