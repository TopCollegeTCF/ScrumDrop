const catalog = [
  ['Орбита','Звезда'], ['Листопад','Лист'], ['Аметист','Жеода'], ['Импульс','Молния'],
  ['Луна','Полумесяц'], ['Призма','Спектр'], ['Кассета','Микстейп'], ['Флора','Спора'],
  ['Оригами','Журавль'], ['Затмение','Корона']
];
const get = id => document.getElementById(id);
const key = 'scrumdrop-openings-v1';
const openings = JSON.parse(localStorage.getItem(key) || '[]');
const balance = () => 100 - 30 * openings.length;
let selected = 0;
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
  get('balance').textContent = balance();
  const counts = new Map();
  for (const row of openings) {
    const item = row.upgraded ? row.item+' +1' : row.item;
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  get('coins').textContent = balance();
  get('opened').textContent = openings.length;
  get('unique').textContent = new Set(openings.map(row => row.item)).size;
  const last = openings[openings.length - 1];
  if (last) {
    get('feature-title').textContent = 'Последнее открытие';
    get('feature-name').textContent = last.name;
    get('feature-reward').textContent = 'Награда · '+last.item;
    const index = catalog.findIndex(([name]) => name === last.name);
    get('feature-img').hidden = index < 0;
    if (index >= 0) get('feature-img').src = 'cases/'+index+'.jpg';
  }
  showList('bag', [...counts].map(([item,n]) => item+' × '+n), 'Здесь появится первый предмет.');
  showList('log', openings.slice().reverse().map(row => row.name+' · '+row.item+' · −30'), 'Кейсы ещё не открывались.');
}
catalog.forEach(([name, reward], index) => {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'case';
  card.setAttribute('aria-haspopup','dialog');
  const img = document.createElement('img');
  img.src = 'cases/'+index+'.jpg';
  img.alt = '';
  const label = document.createElement('strong');
  label.textContent = name;
  card.append(img,label);
  card.onpointermove = e => {
    if (e.pointerType === 'touch') return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--rx', (0.5-(e.clientY-r.top)/r.height)*8+'deg');
    card.style.setProperty('--ry', ((e.clientX-r.left)/r.width-0.5)*10+'deg');
  };
  card.onpointerleave = () => {card.style.removeProperty('--rx');card.style.removeProperty('--ry')};
  card.onclick = () => {
    selected = index;
    get('preview').src = img.src;
    get('name').textContent = name;
    get('rewards').textContent = 'Внутри: '+reward+' (обычный) или Кристалл (редкий).';
    get('result').textContent = '';
    get('detail').setAttribute('aria-labelledby','name');
    get('detail').showModal();
  };
  get('cases').append(card);
});
get('buy').onclick = () => {
  if (balance()<30) {get('result').textContent='Недостаточно монет. Для открытия нужно 30.';return}
  const [name, reward] = catalog[selected];
  const item = Math.random() < 0.75 ? reward : 'Кристалл';
  openings.push({name,item});
  localStorage.setItem(key,JSON.stringify(openings));
  render();
  get('result').textContent = 'Твоя награда — '+item+'!';
};

const nicknameKey = 'scrumdrop-nickname-v1';
function displayName() {
  const name = localStorage.getItem(nicknameKey) || 'Игрок';
  get('player').textContent = name;
  get('nickname').value = name;
}
function showPage() {
  const routes = {'#account':'overview','#collection':'inventory','#account/inventory':'inventory','#account/history':'history','#account/settings':'settings'};
  const tab = routes[location.hash];
  const inAccount = Boolean(tab);
  const activity = ['#games','#upgrade'].find(hash => hash === location.hash);
  document.querySelector('.hero').hidden = inAccount || Boolean(activity);
  get('catalog').hidden = inAccount || Boolean(activity);
  get('games').hidden = activity !== '#games';
  get('upgrade').hidden = activity !== '#upgrade';
  for (const link of document.querySelectorAll('.main-nav a')) {
    if (!inAccount && link.hash === (activity || '#catalog')) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  if (activity !== '#games') resetReaction();
  get('account').hidden = !inAccount;
  document.title = inAccount ? 'ScrumDrop — Личный кабинет' : 'ScrumDrop — Коллекция кейсов';
  if (activity) {
    const heading = document.querySelector(activity+' h1');
    document.title = 'ScrumDrop — '+heading.textContent;
    heading.focus({preventScroll:true});
    window.scrollTo({top:0,behavior:'instant'});
    if (activity === '#upgrade') renderUpgrade();
  } else if (inAccount) {
    displayName();
    get('saved').textContent = '';
    for (const link of document.querySelectorAll('.profile-nav a')) {
      if (routes[link.hash] === tab) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
    get('overview').hidden = tab !== 'overview';
    get('inventory-panel').hidden = !['overview','inventory'].includes(tab);
    get('history-panel').hidden = !['overview','history'].includes(tab);
    get('settings-panel').hidden = tab !== 'settings';
    const heading = document.querySelector('.profile-main section:not([hidden]) :is(h1,h2)');
    heading.tabIndex = -1;
    heading.focus({preventScroll:true});
    window.scrollTo({top:0,behavior:'instant'});
  } else if (location.hash === '#catalog') {
    get('catalog').scrollIntoView();
  }
}
get('name-form').onsubmit = event => {
  event.preventDefault();
  const input = get('nickname');
  const name = input.value.trim();
  if (!name) { input.setCustomValidity('Введите имя игрока'); input.reportValidity(); return; }
  localStorage.setItem(nicknameKey,name);
  displayName();
  get('saved').textContent = 'Имя сохранено';
};
get('nickname').oninput = event => { event.target.setCustomValidity(''); get('saved').textContent = ''; };
const avatars = [5, 0, 1, 4, 9];
const avatarKey = 'scrumdrop-avatar-v1';
for (const id of avatars) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'avatar';
  input.value = id;
  input.setAttribute('aria-label', catalog[id][0]);
  input.checked = id === Number(localStorage.getItem(avatarKey) ?? 5);
  const image = document.createElement('img');
  image.src = 'cases/'+id+'.jpg';
  image.alt = '';
  if (input.checked) get('avatar').src = image.src;
  input.onchange = () => {
    get('avatar').src = image.src;
    localStorage.setItem(avatarKey,id);
  };
  label.append(input,image);
  get('avatar-options').append(label);
}
get('top-up').onclick = () => get('card-demo').showModal();

const upgradeItem = get('upgrade-item');
function renderUpgrade() {
  upgradeItem.replaceChildren();
  openings.forEach((row, index) => {
    if (!row.upgraded) upgradeItem.add(new Option(row.item+' · '+row.name,index));
  });
  get('upgrade-form').hidden = !upgradeItem.length;
  get('upgrade-empty').hidden = Boolean(upgradeItem.length);
  get('upgrade-empty').firstChild.textContent = openings.length
    ? 'Все предметы улучшены. Можно открыть ещё один '
    : 'Для улучшения нужен предмет из ';
  get('upgrade-empty').querySelector('a').textContent = openings.length ? 'кейс' : 'кейса';
}
get('upgrade-form').onsubmit = event => {
  event.preventDefault();
  const row = openings[Number(upgradeItem.value)];
  row.upgraded = true;
  localStorage.setItem(key,JSON.stringify(openings));
  get('upgrade-status').textContent = row.item+' улучшен до +1.';
  render();
  renderUpgrade();
};

const reaction = get('reaction');
const reactionStatus = get('reaction-status');
const recordKey = 'scrumdrop-reaction-v1';
let best = Number(localStorage.getItem(recordKey));
let timer;
let signalTime = 0;
function showRecord() {
  get('reaction-record').textContent = best ? 'Рекорд · '+best+' мс' : '';
}
function resetReaction() {
  clearTimeout(timer);
  timer = undefined;
  signalTime = 0;
  reaction.classList.remove('ready');
  reaction.textContent = 'Начать';
  reactionStatus.textContent = 'Нажми «Начать» и дождись зелёного сигнала.';
}
reaction.onclick = () => {
  if (timer) {
    resetReaction();
    reactionStatus.textContent = 'Слишком рано. Попробуй ещё раз.';
  } else if (signalTime) {
    const time = Math.max(1, Math.round(performance.now()-signalTime));
    resetReaction();
    if (!best || time < best) {
      best = time;
      localStorage.setItem(recordKey,best);
      showRecord();
    }
    reactionStatus.textContent = 'Твоя реакция · '+time+' мс';
  } else {
    reactionStatus.textContent = 'Жди зелёного сигнала…';
    reaction.textContent = 'Жди…';
    timer = setTimeout(() => {
      timer = undefined;
      reaction.textContent = 'Сейчас!';
      reactionStatus.textContent = 'Нажимай!';
      reaction.classList.add('ready');
      signalTime = performance.now();
    }, 1100+Math.random()*1600);
  }
};
showRecord();
render();
window.addEventListener('hashchange',showPage);
showPage();

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
