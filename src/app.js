// Интерфейс NOMAD. Два режима:
//   modem — настоящий Iridium-модем RockBLOCK 9603 по USB (Web Serial), профиль хранится в браузере;
//   sim   — три виртуальных модема и симулятор сети Iridium, всё в памяти вкладки.
import { SbdModem, openWebSerial, hasWebSerial } from './sbd.js';
import { SimIridium, SKY } from './sim.js';
import { Messenger, MemoryStorage, LocalStorage, STATUS, creditsFor } from './messenger.js';
import { BODY_MAX, OVERHEAD, RB_PREFIX_LEN, HEADER_LEN, IV_LEN, TAG_LEN, PACKET_MAX, MO_MAX, MT_MAX } from './protocol.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360; return h; };
const avatar = name => `<div class="av" style="background:hsl(${hue(name)} 42% 42%)">${esc([...name][0] || '?')}</div>`;

const POLL = [[0, 'выключена'], [60000, 'раз в минуту'], [300000, 'раз в 5 минут'], [900000, 'раз в 15 минут'], [1800000, 'раз в 30 минут']];

const S = {
  mode: null,
  net: null,
  devices: [],
  active: null,
  screen: 'mode',
  chat: null,
  tab: 'session',
  built: null,
  connectMsg: '',
  error: '',
  anims: [],
};

/* ---------------- запуск ---------------- */

async function startSim() {
  S.mode = 'sim';
  go('connecting', 'Поднимаем виртуальные модемы…');
  const net = new SimIridium();
  S.net = net;
  hookNet(net);
  const seeds = [['Алия', '0204511'], ['Ерлан', '0204512'], ['Дана', '0204513']];
  for (const [name, serial] of seeds) {
    const fake = net.createModem({ serial, sky: 'open' });
    const dev = await openDevice(fake, fake);
    await attachMessenger(dev, { storage: new MemoryStorage(), name, serial, retryBaseMs: 5000, pollMs: 60000 });
  }
  // Алия и Ерлан уже обменялись кодами; Дану можно добавить на экране «Контакты»
  const [a, e] = S.devices;
  await a.m.addContact(e.m.contactCode);
  await e.m.addContact(a.m.contactCode);
  S.active = a;
  setInterval(refreshSignals, 8000);
  refreshSignals();
  go('home');
}

async function startModem() {
  let io;
  try {
    io = await openWebSerial();
  } catch (e) {
    if (e.name === 'NotFoundError') return; // пользователь закрыл окно выбора порта
    return fail('Не удалось открыть порт: ' + e.message);
  }
  S.mode = 'modem';
  go('connecting', 'Проверяем модем (AT)…');
  try {
    const dev = await openDevice(io, null);
    dev.storage = new LocalStorage('nomad.');
    io.onClose = () => {
      dev.disconnected = true;
      dev.m?.stop();
      toast('Модем отключён', true);
      schedule();
    };
    S.active = dev;
    if (Messenger.hasProfile(dev.storage)) {
      await attachMessenger(dev, { storage: dev.storage });
      go('home');
    } else {
      go('setup');
    }
    setInterval(refreshSignals, 30000);
    refreshSignals();
  } catch (e) {
    await io.close?.();
    S.devices = [];
    S.active = null;
    fail(e.message);
  }
}

async function openDevice(io, fake) {
  const modem = new SbdModem(io);
  const dev = { modem, fake, m: null, log: [], signal: null, imei: null };
  modem.on('log', e => {
    dev.log.push({ t: Date.now(), ...e });
    if (dev.log.length > 400) dev.log.shift();
    if (dev === S.active && S.tab === 'at') scheduleLab(true);
  });
  dev.imei = (await modem.init()).imei;
  S.devices.push(dev);
  return dev;
}

async function attachMessenger(dev, { storage, name, serial, retryBaseMs = 30000, pollMs = 300000 }) {
  const settings = storage.get('settings') || {};
  const m = new Messenger({ modem: dev.modem, storage, retryBaseMs, receipts: settings.receipts ?? true });
  await m.init({ name, serial });
  dev.m = m;
  dev.storage = storage;
  m.on('change', schedule);
  m.on('error', e => toast(e.message, true));
  m.on('message', ({ contact }) => {
    const watching = dev === S.active && S.screen === 'chat' && S.chat === contact.id;
    if (!watching) toast(`${S.mode === 'sim' ? m.name + ': ' : ''}сообщение от ${contact.name}`);
    if (watching) m.markRead(contact.id);
  });
  m.on('session', e => onSession(dev, e));
  m.on('request', r => toast(`${S.mode === 'sim' ? m.name + ': ' : ''}${r.name} хочет добавить вас в чаты`));
  m.on('contact', ({ contact, via }) => { if (via === 'their-accept') toast(`${S.mode === 'sim' ? m.name + ': ' : ''}${contact.name} принимает запрос — можно писать`); });
  m.start({ pollMs: settings.pollMs ?? pollMs });
  return m;
}

async function refreshSignals() {
  for (const d of S.devices) {
    if (d.disconnected) continue;
    try { d.signal = await d.modem.signal(); } catch { d.signal = null; }
  }
  schedule();
}

function saveSettings(dev, patch) {
  const s = { ...(dev.storage.get('settings') || {}), ...patch };
  dev.storage.set('settings', s);
}

/* ---------------- навигация ---------------- */

function go(screen, msg) {
  S.screen = screen;
  if (msg !== undefined) S.connectMsg = msg;
  S.built = null;
  schedule();
  scheduleLab(true);
}

function fail(message) {
  S.error = message;
  go('error');
}

let toastT = 0;
function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 3200);
}

/* ---------------- телефон ---------------- */

function sigBars(n) {
  if (n == null) return '<span class="muted">—</span>';
  return `<span class="sig ${n <= 2 ? 'low' : ''}" title="Сигнал ${n}/5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}" style="height:${2 + i * 2}px"></i>`).join('')}</span>`;
}

function statusOf(m) {
  switch (m.status) {
    case STATUS.QUEUED: return [m.error ? `⏳ ${m.error}` : '⏳ ждёт спутник', 'wait'];
    case STATUS.SENDING: return ['🛰 сеанс связи…', 'wait'];
    case STATUS.SENT: return ['✓ в сети Iridium', ''];
    case STATUS.DELIVERED: return ['✓✓ доставлено', 'ok'];
    case STATUS.CANCELED: return ['отменено', 'bad'];
    default: return ['', ''];
  }
}

function mountPhone() {
  const el = $('#screen');
  const dev = S.active;
  S.built = buildKey();
  switch (S.screen) {
    case 'mode': {
      const serial = hasWebSerial();
      el.innerHTML = `<div class="center">
        <div class="logo" aria-hidden="true">🛰</div><h2>NOMAD</h2>
        <p>Переписка через спутники Iridium там, где нет ни интернета, ни связи.</p>
        <button class="btn" data-act="startSim">Демо: симуляция спутника</button>
        <button class="btn ghost" data-act="startModem" ${serial ? '' : 'disabled'}>Подключить модем RockBLOCK</button>
        <p class="small">${serial ? 'Iridium 9603 по USB, скорость 19200' : 'Для модема нужен Chrome или Edge на компьютере (Web Serial)'}</p>
      </div>`;
      return;
    }
    case 'connecting':
      el.innerHTML = `<div class="center"><div class="logo" aria-hidden="true">📡</div><p>${esc(S.connectMsg)}</p></div>`;
      return;
    case 'error':
      el.innerHTML = `<div class="center"><div class="logo" aria-hidden="true">⚠️</div><p>${esc(S.error)}</p>
        <button class="btn" data-act="toMode">Назад</button></div>`;
      return;
    case 'setup':
      el.innerHTML = `<div class="sec">
        <h3>Модем подключён</h3>
        <p class="muted">IMEI ${esc(dev.imei || '—')}. Создайте профиль: ключи шифрования появятся только на этом компьютере.</p>
        <label class="field">Ваше имя<input id="suName" maxlength="40" autocomplete="name"></label>
        <label class="field">Серийный номер RockBLOCK (на наклейке модема)<input id="suSerial" inputmode="numeric" maxlength="7" placeholder="например 12345"></label>
        <p class="err" id="suErr"></p>
        <button class="btn" data-act="createProfile">Создать профиль</button>
        <p class="note">Серийный номер — ваш адрес: собеседники отправляют сообщения на RB&lt;номер&gt;, и облако RockBLOCK пересылает их на ваш модем.</p>
      </div>`;
      return;
    case 'home':
      el.innerHTML = `<div class="apphead"><h2>Чаты</h2><button class="ib" data-act="contacts">+ Добавить</button></div>
        <div class="list" id="list"></div><div class="foot" id="foot"></div>`;
      return;
    case 'chat':
      el.innerHTML = `<div class="chead"><button class="back" data-act="home" aria-label="Назад">←</button><div id="cav"></div><div class="t" id="ctitle"></div></div>
        <div class="msgs" id="msgs"></div>
        <div class="compose"><textarea id="inp" rows="1" placeholder="Сообщение…" aria-label="Сообщение"></textarea><button class="send" data-act="send" aria-label="Отправить">➤</button></div>
        <div class="meter" id="meter"></div>`;
      updateMeter();
      return;
    case 'contacts':
      el.innerHTML = `<div class="chead"><button class="back" data-act="home" aria-label="Назад">←</button><div class="t">Добавить в чаты</div></div>
        <div class="sec">
          <h3>По номеру модема</h3>
          <p class="muted small">Введите серийный номер RockBLOCK собеседника. Запрос уйдёт через спутник; когда собеседник примет его, вы появитесь в чатах друг у друга.</p>
          <div class="atline" style="margin-top:0"><input id="reqSerial" inputmode="numeric" maxlength="7" placeholder="например 0204513" aria-label="Номер модема собеседника"><button class="btn sm" data-act="requestContact">Отправить запрос</button></div>
          <p class="err" id="reqErr"></p>
          <div id="simNear"></div>
          <div id="invites"></div>
          <h3>Мои контакты</h3>
          <div id="clist"></div>
          <details class="alt">
            <summary>Без спутника: обмен кодами</summary>
            <p class="muted small">Если связь ещё есть, обменяйтесь кодами заранее — сообщением, QR, на бумажке. Это не тратит кредиты.</p>
            <textarea class="code" id="mycode" readonly>${esc(dev.m.contactCode)}</textarea>
            <div class="btns" style="margin:6px 0 10px"><button class="btn sm" data-act="copyCode">Скопировать мой код</button></div>
            <textarea class="code" id="peerCode" placeholder="Код собеседника: nomad1.…" aria-label="Код контакта"></textarea>
            <input id="peerName" placeholder="Имя (необязательно)" maxlength="40" style="margin-top:6px" aria-label="Имя контакта">
            <p class="err" id="addErr"></p>
            <button class="btn sm" data-act="addContact">Добавить по коду</button>
          </details>
        </div>`;
      return;
  }
}

const buildKey = () => `${S.screen}|${S.chat || ''}|${S.devices.indexOf(S.active)}`;

function refreshPhone() {
  const dev = S.active;
  const m = dev?.m;
  $('#sbar').innerHTML = dev
    ? `<b>${esc(m?.name || 'Модем')}</b><span>${m ? `RB${m.serial} · ` : ''}${dev.disconnected ? 'модем отключён' : sigBars(dev.signal)}</span>`
    : '<b>NOMAD</b><span>спутниковая связь</span>';
  if (S.built !== buildKey()) mountPhone();
  if (!m) return;

  if (S.screen === 'home') {
    const rows = m.contacts.map(c => {
      const conv = m.conversation(c.id);
      const last = conv[conv.length - 1];
      return { c, last, u: m.unread[c.id] || 0, t: last ? last.ts : c.added || 0 };
    }).sort((a, b) => b.t - a.t);
    $('#list').innerHTML = rows.length ? rows.map(({ c, last, u }) => `<button class="row" data-act="open" data-id="${c.id}">${avatar(c.name)}
      <div class="rt"><div class="n"><span>${esc(c.name)}</span><small>${last ? fmtT(last.ts) : ''}</small></div>
      <div class="p">${last ? (last.dir === 'out' ? statusOf(last)[0].split(' ')[0] + ' ' : '') + esc(last.text) : 'Нет сообщений'}${u ? `<span class="badge">${u}</span>` : ''}</div></div></button>`).join('')
      : (m.requests.length ? '' : '<div class="empty">Чатов пока нет. Нажмите «+ Добавить» и введите номер модема собеседника.</div>');
    $('#list').insertAdjacentHTML('afterbegin', requestCards(m));
    const ls = m.lastSession;
    const queued = m.outbox.length;
    $('#foot').innerHTML = `<span>${m.syncing ? '🛰 сеанс связи…' : ls ? `<span class="${ls.ok ? 'ok' : 'bad'}">${ls.ok ? '✓' : '✗'}</span> ${fmtT(ls.at)} · ${esc(ls.ok ? (ls.received ? 'есть входящие' : 'связь есть') : ls.text)}` : 'Сеансов ещё не было'}${queued ? ` · в очереди ${queued}` : ''}</span>
      <button class="ib" data-act="sync" ${m.syncing || dev.disconnected ? 'disabled' : ''}>Проверить</button>`;
  }

  if (S.screen === 'chat') {
    const c = m.contact(S.chat);
    if (!c) { go('home'); return; }
    if (m.unread[c.id]) m.markRead(c.id);
    $('#cav').innerHTML = avatar(c.name);
    const peer = S.mode === 'sim' ? S.devices.find(d => d.m?.serial === c.serial) : null;
    $('#ctitle').innerHTML = `${esc(c.name)}<small>RB${c.serial}${peer ? ' · ' + SKY[peer.fake.sky].label.toLowerCase() : ''}</small>`;
    const box = $('#msgs');
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const conv = m.conversation(c.id);
    box.innerHTML = conv.map(x => {
      const [t, k] = x.dir === 'out' ? statusOf(x) : ['', ''];
      const cancel = x.dir === 'out' && x.status === STATUS.QUEUED ? `<button class="link" data-act="cancel" data-id="${x.id}">отменить</button>` : '';
      return `<div class="b ${x.dir}">${esc(x.text)}<small class="${k}">${fmtT(x.sentTs || x.ts)}${t ? ' · ' + esc(t) : ''}${cancel}</small></div>`;
    }).join('') || '<div class="empty">Сообщения уходят через спутник, когда модем видит небо. Без связи они ждут в очереди.</div>';
    if (near) box.scrollTop = box.scrollHeight;
  }

  if (S.screen === 'contacts') {
    $('#clist').innerHTML = m.contacts.length
      ? m.contacts.map(c => `<div class="crow"><span>${esc(c.name)}<small class="muted mono" style="display:block">номер безопасности ${esc(c.safety || '—')}</small></span><span class="mono muted">RB${c.serial}</span></div>`).join('')
      : '<p class="muted small">Пока пусто.</p>';
    $('#invites').innerHTML = m.invites.length
      ? `<h3>Отправленные запросы</h3>${m.invites.map(r => `<div class="crow"><span class="mono">RB${r.serial}<small class="muted" style="display:block;font-family:system-ui">${esc(inviteStatus(r))}</small></span><button class="btn sm ghost" data-act="cancelInvite" data-id="${r.id}">Отменить</button></div>`).join('')}`
      : '';
    if (S.mode === 'sim') {
      const others = S.devices.filter(d => d !== dev && d.m && !m.contacts.some(c => c.serial === d.m.serial));
      $('#simNear').innerHTML = others.length
        ? `<p class="muted small">В демо: ${others.map(d => `<button class="link" style="color:var(--accent)" data-act="fillSerial" data-serial="${d.m.serial}">${esc(d.m.name)} — ${d.m.serial}</button>`).join(', ')}</p>`
        : '';
    }
  }
}

function inviteStatus(r) {
  if (r.status === STATUS.QUEUED) return r.error ? `⏳ ${r.error}` : '⏳ ждёт спутник';
  if (r.status === STATUS.SENDING) return '🛰 сеанс связи…';
  return '✓ отправлен, ждём ответа';
}

function requestCards(m) {
  return m.requests.map(r => `<div class="req">
    <div class="req-h">${avatar(r.name)}<div><b>${esc(r.name)}</b> хочет переписываться с вами<small class="muted" style="display:block">RB${r.serial} · номер безопасности <span class="mono">${esc(r.safety)}</span></small></div></div>
    ${r.keyChanged ? '<p class="err" style="margin:6px 0 0">С этим номером у вас уже есть контакт, но с другим ключом. Убедитесь, что это тот же человек.</p>' : ''}
    <div class="btns" style="margin-top:8px"><button class="btn sm" data-act="acceptReq" data-id="${r.id}">Принять</button><button class="btn sm ghost" data-act="declineReq" data-id="${r.id}">Отклонить</button></div>
  </div>`).join('');
}

let meterSeq = 0;
async function updateMeter() {
  const dev = S.active, el = $('#meter'), inp = $('#inp');
  if (!el || !inp || !dev?.m) return;
  const seq = ++meterSeq;
  const text = inp.value.trim();
  const n = text ? await dev.m.measure(text) : 0;
  if (seq !== meterSeq) return;
  const total = n + OVERHEAD + RB_PREFIX_LEN;
  el.className = 'meter' + (n > BODY_MAX ? ' over' : '');
  el.innerHTML = `<span>${n} / ${BODY_MAX} байт${n > BODY_MAX ? ' — слишком длинно' : ''}</span><span>${text ? `пакет ${total} Б · ≈${creditsFor(total)} кр.` : 'E2E · AES-256-GCM'}</span>`;
  $('[data-act="send"]').disabled = !text || n > BODY_MAX;
}

async function sendDraft() {
  const dev = S.active, inp = $('#inp');
  const text = inp.value.trim();
  if (!text) return;
  try {
    await dev.m.send(S.chat, text);
    inp.value = '';
    autoGrow(inp);
    updateMeter();
  } catch (e) {
    toast(e.message, true);
  }
  inp.focus();
}

function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; }

function refreshChips() {
  $('#chips').innerHTML = S.mode === 'sim' ? S.devices.filter(d => d.m).map((d, i) => {
    const u = d.m.unreadTotal + d.m.requests.length;
    return `<button class="chip" data-act="pick" data-i="${i}" aria-pressed="${d === S.active}"><span class="dot ${d.fake.sky}"></span>${esc(d.m.name)}${u ? `<span class="badge">${u}</span>` : ''}</button>`;
  }).join('') : '';
  $('#modeTag').textContent = S.mode === 'sim' ? 'демо · симуляция' : S.mode === 'modem' ? 'модем RockBLOCK' : 'спутник';
  const total = S.devices.reduce((a, d) => a + (d.m?.unreadTotal || 0), 0);
  document.title = (total && S.mode === 'modem' ? `(${total}) ` : '') + 'NOMAD — спутниковый мессенджер';
}

function refreshSkyTools() {
  const dev = S.active;
  const tools = $('#skytools'), hint = $('#skyhint');
  if (!dev || !dev.m) {
    tools.innerHTML = '';
    tools.dataset.key = '';
    hint.textContent = S.mode ? '' : 'Выберите режим на экране телефона. В демо сообщения ходят между тремя виртуальными модемами через симулятор сети Iridium.';
    return;
  }
  const key = `${S.mode}|${S.devices.indexOf(dev)}|${dev.fake?.sky}|${!!dev.m.syncing}|${!!dev.disconnected}`;
  if (tools.dataset.key === key) return;
  tools.dataset.key = key;
  const busy = dev.m.syncing || dev.disconnected ? 'disabled' : '';
  tools.innerHTML = (S.mode === 'sim'
    ? `<label>Небо у ${esc(dev.m.name)} <select id="skySel">${Object.entries(SKY).map(([k, v]) => `<option value="${k}" ${dev.fake.sky === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>`
    : `<span class="mono muted">IMEI ${esc(dev.imei || '—')}</span>`)
    + `<button class="tool" data-act="sync" ${busy}>🛰 Сеанс связи</button><button class="tool" data-act="signal" ${dev.disconnected ? 'disabled' : ''}>Сигнал</button>`
    + (S.mode === 'modem' ? `<button class="tool" data-act="disconnect" ${dev.disconnected ? 'disabled' : ''}>Отключить</button>` : '');
  hint.textContent = S.mode === 'sim'
    ? 'Напишите от Алии Ерлану. Добавить Дану можно по номеру модема: «+ Добавить» → 0204513, потом откройте Дану и примите запрос. Поставьте кому-нибудь «В помещении» — сообщения подождут на шлюзе Iridium.'
    : 'Антенне нужен открытый вид на небо. Сеанс SBD занимает от 10 секунд до пары минут; если связи нет, сообщения ждут в очереди и уходят сами.';
}

/* ---------------- правая панель ---------------- */

function setTab(t) {
  S.tab = t;
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === t));
  scheduleLab(true);
}

function renderLab() {
  const b = $('#labbody');
  const dev = S.active;
  const m = dev?.m;
  if (S.tab === 'proto') return renderProto(b);
  if (S.tab === 'net') return renderNet(b);
  if (!dev) { b.innerHTML = '<p class="muted">Модем ещё не подключён.</p>'; return; }

  if (S.tab === 'at') {
    const keepInput = $('#atCmd')?.value || '';
    const focus = document.activeElement?.id === 'atCmd';
    b.innerHTML = `<p class="muted" style="margin-top:0">Обмен с ${S.mode === 'sim' ? 'виртуальным модемом' : 'модемом'} ${esc(m?.name || '')}: те же AT-команды, что у Iridium 9603.</p>
      <div class="log mono" id="atlog">${dev.log.slice(-200).map(l => `<div class="${l.dir === '>' ? 'tx' : ''}">${fmtT(l.t)} ${l.dir} ${esc(l.text)}</div>`).join('') || '<div class="muted">пусто</div>'}</div>
      <div class="atline"><input id="atCmd" class="mono" placeholder="AT+CSQ" value="${esc(keepInput)}" aria-label="AT-команда"><button class="tool" data-act="atSend">Отправить</button></div>`;
    const log = $('#atlog');
    log.scrollTop = log.scrollHeight;
    if (focus) $('#atCmd').focus();
    return;
  }

  if (!m) { b.innerHTML = `<p class="muted">IMEI ${esc(dev.imei || '—')}. Создайте профиль на экране телефона.</p>`; return; }
  const st = m.stats, ls = m.lastSession;
  const settings = dev.storage.get('settings') || {};
  const kv = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const texts = m.outbox.filter(o => o.kind === 'text').length;
  b.innerHTML = `<table class="kv">
    ${kv('Имя', esc(m.name))}${kv('Адрес (серийный RockBLOCK)', `<span class="mono">RB${m.serial}</span>`)}${kv('IMEI', `<span class="mono">${esc(dev.imei || '—')}</span>`)}
    ${kv('Сигнал', dev.signal == null ? '—' : `${dev.signal} / 5`)}
    ${kv('Последний сеанс', ls ? `${fmtT(ls.at)} · ${esc(ls.text)}` : '—')}
    ${kv('Сеансов / неудачных', `${st.sessions} / ${st.failed}`)}
    ${kv('В очереди', `${m.outbox.length}${m.outbox.length ? ` (сообщений ${texts}, подтверждений ${m.outbox.length - texts})` : ''}`)}
    ${kv('Передано / принято', `${st.moBytes} / ${st.mtBytes} байт`)}
    ${kv('≈ Кредиты RockBLOCK', `${st.credits} <span class="muted">(1 кр. = до 50 байт)</span>`)}
    ${kv('Отклонено пакетов', st.rejected ? `${st.rejected} · ${esc(m.lastReject?.reason || '')}` : '0')}
    ${kv('Отпечаток ключа', `<span class="mono">${m.kid}</span>`)}
  </table>
  <div class="btns">
    <label class="tools" style="margin:0"><input type="checkbox" id="optReceipts" ${m.receipts ? 'checked' : ''}> Подтверждения доставки (+1 кредит на сообщение)</label>
  </div>
  <div class="btns">
    <label class="tools" style="margin:0">Проверка почты <select id="optPoll">${POLL.map(([v, l]) => `<option value="${v}" ${(settings.pollMs ?? m.pollMs) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <button class="tool" data-act="retryNow" ${m.outbox.length ? '' : 'disabled'}>Повторить очередь сейчас</button>
  </div>
  <p class="note">Входящие приходят сами: модем получает от сети сигнал SBDRING и забирает сообщение. Периодическая проверка нужна на случай, если сигнал пропущен (антенна была закрыта).</p>`;
}

function renderNet(b) {
  if (S.mode === 'sim') {
    const n = S.net;
    b.innerHTML = `<table><tr><th>Устройство</th><th>Адрес</th><th>Небо</th><th>Сигнал</th><th>Ждут на шлюзе</th></tr>
      ${S.devices.filter(d => d.m).map(d => `<tr><td>${esc(d.m.name)}</td><td class="mono">RB${d.m.serial}</td><td>${SKY[d.fake.sky].label}</td><td>${d.signal ?? '—'}</td><td>${n.queued(d.m.serial)}</td></tr>`).join('')}</table>
      <table class="kv" style="margin-top:12px">
        <tr><td>MO принято сетью</td><td>${n.stats.mo}</td></tr><tr><td>MT доставлено на модемы</td><td>${n.stats.mt}</td></tr>
        <tr><td>Отброшено шлюзом</td><td>${n.stats.dropped}</td></tr><tr><td>Байт через спутники</td><td>${n.stats.bytes}</td></tr></table>
      <p class="note">Путь сообщения: модем → спутник Iridium → наземный шлюз → облако RockBLOCK видит адрес «RB&lt;серийный&gt;» → очередь MT получателя → SBDRING → сеанс получателя → спутник → модем. Шлюз хранит сообщение, пока получатель не выйдет на связь.</p>`;
    return;
  }
  b.innerHTML = `<p style="margin-top:0">Что нужно для настоящей связи:</p>
    <ol class="note">
      <li>Два модема RockBLOCK 9603 (или 9602) — у вас и у собеседника.</li>
      <li>Активная линия и кредиты на каждом (настраивается заранее в аккаунте Rock7, пока есть интернет).</li>
      <li>Обмен кодами NOMAD заранее, на экране «Контакты».</li>
      <li>Chrome или Edge на компьютере: модем подключается по USB, сайт работает с ним через Web Serial.</li>
    </ol>
    <p class="note">После первой загрузки сайт сохраняется в браузере и открывается без интернета. Сообщения ходят только через спутники: облако RockBLOCK пересылает пакет с адресом RB&lt;серийный&gt; на модем получателя. Интернет не нужен ни вам, ни собеседнику.</p>
    <p class="note">Модемы RockBLOCK 9704 (протокол IMT/JSPR) пока не поддерживаются.</p>`;
}

function renderProto(b) {
  b.innerHTML = `<p style="margin-top:0">Пакет NOMAD внутри одного SBD-сообщения:</p>
    <div class="pk">
      <span><b>адрес</b>RB+7 цифр · ${RB_PREFIX_LEN}</span>
      <span><b>заголовок</b>версия, тип, id, отправитель, время · ${HEADER_LEN}</span>
      <span><b>IV</b>${IV_LEN}</span>
      <span class="enc"><b>шифротекст</b>текст (deflate) · до ${BODY_MAX}</span>
      <span class="enc"><b>GCM-тег</b>${TAG_LEN}</span>
    </div>
    <table class="kv">
      <tr><td>Лимит Iridium 9603: MO / MT</td><td>${MO_MAX} / ${MT_MAX} байт</td></tr>
      <tr><td>Максимальный пакет NOMAD</td><td>${PACKET_MAX} байт</td></tr>
      <tr><td>Полезная нагрузка</td><td>до ${BODY_MAX} байт ≈ ${BODY_MAX} лат. / ${Math.floor(BODY_MAX / 2)} кирил. символов (больше со сжатием)</td></tr>
      <tr><td>Подтверждение доставки</td><td>${OVERHEAD + 8 + RB_PREFIX_LEN} байт</td></tr>
    </table>
    <ul class="note">
      <li>Ключи: ECDH P-256 → HKDF-SHA256 → AES-256-GCM. Секретный ключ не покидает устройство.</li>
      <li>Заголовок не шифруется, но защищён тегом GCM (AAD): подмену любого байта получатель отбросит.</li>
      <li>Шлюз Iridium и RockBLOCK видят только адрес и шифротекст.</li>
      <li>Повторно пришедший пакет показывается один раз (дедупликация по id).</li>
      <li>Неотправленное хранится в очереди и уходит при следующем удачном сеансе; на стороне сети сообщение ждёт получателя на шлюзе.</li>
    </ul>`;
}

/* ---------------- небо (canvas) ---------------- */

let C = {};
let colorsFrame = 0;
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  C = { line: g('--line'), ink: g('--ink'), muted: g('--muted'), accent: g('--accent'), amber: g('--amber'), danger: g('--danger'), sky1: g('--sky1'), sky2: g('--sky2'), panel: g('--panel2') };
}

function layout(W, H) {
  const ground = H * 0.82;
  const devs = S.devices.filter(d => d.m);
  const pos = new Map();
  devs.forEach((d, i) => pos.set(d, { x: W * (devs.length === 1 ? 0.3 : 0.12 + i * (0.56 / Math.max(1, devs.length - 1))), y: ground }));
  return { ground, pos, gw: { x: W * 0.88, y: ground }, cx: W / 2, rx: W * 0.47, ry: H * 0.72 };
}

function satPositions(L, t) {
  const out = [];
  for (let i = 0; i < 5; i++) {
    const ph = (t / 46000 + i / 5) % 1;
    const a = ph * Math.PI;
    out.push({ x: L.cx - L.rx * Math.cos(a), y: L.ground - L.ry * Math.sin(a) * (0.72 + 0.28 * ((i * 37) % 5) / 4) });
  }
  return out;
}

function nearestSat(L, x) {
  const sats = satPositions(L, performance.now()).filter(s => s.y < L.ground - 30);
  return sats.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0] || { x, y: L.ground - L.ry * 0.8 };
}

function anim(kind, dev) {
  const c = $('#sky');
  if (!c.clientWidth || !dev) return;
  const L = layout(c.clientWidth, c.clientHeight);
  const p = L.pos.get(dev);
  if (!p) return;
  const now = performance.now();
  if (kind === 'pulse' || kind === 'fail') S.anims.push({ kind: 'ring', x: p.x, y: p.y - 18, t0: now, dur: 1400, color: kind === 'fail' ? C.danger : C.accent });
  if (kind === 'up') { const s = nearestSat(L, (p.x + L.gw.x) / 2); S.anims.push({ kind: 'dot', pts: [{ x: p.x, y: p.y - 18 }, s, { x: L.gw.x, y: L.gw.y - 18 }], t0: now, dur: 1600, color: C.accent }); }
  if (kind === 'down') { const s = nearestSat(L, (p.x + L.gw.x) / 2); S.anims.push({ kind: 'dot', pts: [{ x: L.gw.x, y: L.gw.y - 18 }, s, { x: p.x, y: p.y - 18 }], t0: now, dur: 1600, color: C.amber }); }
  if (kind === 'drop') S.anims.push({ kind: 'ring', x: L.gw.x, y: L.gw.y - 18, t0: now, dur: 1400, color: C.danger });
}

function hookNet(net) {
  const dev = serial => S.devices.find(d => d.m?.serial === serial || d.fake?.serial === serial);
  net.on('session-start', e => anim('pulse', dev(e.serial)));
  net.on('session-end', e => { if (!e.ok) anim('fail', dev(e.serial)); });
  net.on('mo', e => anim('up', dev(e.from)));
  net.on('mt', e => anim('down', dev(e.to)));
  net.on('drop', () => anim('drop', S.devices[0]));
  for (const t of ['mo', 'mt', 'queued', 'drop']) net.on(t, () => { if (S.tab === 'net') scheduleLab(); });
}

function onSession(dev, e) {
  if (S.mode !== 'modem') return;
  if (e.phase === 'start') anim('pulse', dev);
  if (e.phase === 'end' && !e.ok) anim('fail', dev);
  if (e.phase === 'end' && e.ok && e.sent) anim('up', dev);
  if (e.phase === 'end' && e.ok && e.received) anim('down', dev);
}

function drawSky() {
  const c = $('#sky');
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  if (W && (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr))) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  if (!(colorsFrame++ % 60)) readColors();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, C.sky1); g.addColorStop(1, C.sky2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (!W) return requestAnimationFrame(drawSky);
  const L = layout(W, H);
  const now = performance.now();

  // орбиты и спутники
  ctx.strokeStyle = C.line; ctx.setLineDash([3, 6]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(L.cx, L.ground, L.rx, L.ry * 0.86, 0, Math.PI, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
  for (const s of satPositions(L, now)) {
    if (s.y > L.ground - 4) continue;
    ctx.fillStyle = C.muted; ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    ctx.fillStyle = C.accent; ctx.globalAlpha = .7; ctx.fillRect(s.x - 13, s.y - 2, 8, 4); ctx.fillRect(s.x + 5, s.y - 2, 8, 4); ctx.globalAlpha = 1;
  }

  // земля
  ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, L.ground); ctx.lineTo(W, L.ground); ctx.stroke();

  ctx.textAlign = 'center'; ctx.font = '500 11.5px system-ui,sans-serif';
  // шлюз
  ctx.fillStyle = C.muted;
  ctx.beginPath(); ctx.arc(L.gw.x, L.gw.y - 18, 14, Math.PI * 0.95, Math.PI * 2.05); ctx.fill();
  ctx.fillRect(L.gw.x - 2, L.gw.y - 18, 4, 18);
  ctx.fillStyle = C.ink; ctx.fillText('Шлюз Iridium', L.gw.x, L.gw.y + 15);

  // устройства
  for (const [d, p] of L.pos) {
    const active = d === S.active;
    const sky = d.fake?.sky || 'open';
    ctx.fillStyle = active ? C.accent : C.muted;
    roundRect(ctx, p.x - 9, p.y - 32, 18, 30, 4); ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.fillText(d.m.name + (sky === 'blocked' ? ' · в помещении' : ''), p.x, p.y + 15);
    if (sky === 'blocked') { // крыша над устройством
      ctx.strokeStyle = C.danger; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x - 30, p.y - 40); ctx.lineTo(p.x, p.y - 62); ctx.lineTo(p.x + 30, p.y - 40); ctx.stroke();
    } else if (sky === 'partial') { // дерево рядом
      ctx.fillStyle = C.amber; ctx.globalAlpha = .55;
      ctx.beginPath(); ctx.arc(p.x + 22, p.y - 40, 14, 0, 7); ctx.fill(); ctx.fillRect(p.x + 20, p.y - 28, 4, 28); ctx.globalAlpha = 1;
    }
    const u = d.m.unreadTotal;
    if (u) { ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(p.x + 10, p.y - 32, 7, 0, 7); ctx.fill(); ctx.fillStyle = '#000'; ctx.font = '700 9px system-ui'; ctx.textBaseline = 'middle'; ctx.fillText(u > 9 ? '9+' : u, p.x + 10, p.y - 31.5); ctx.textBaseline = 'alphabetic'; ctx.font = '500 11.5px system-ui,sans-serif'; }
  }

  // анимации
  S.anims = S.anims.filter(a => now < a.t0 + a.dur);
  for (const a of S.anims) {
    const t = (now - a.t0) / a.dur;
    if (a.kind === 'ring') {
      ctx.strokeStyle = a.color; ctx.globalAlpha = 1 - t; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(a.x, a.y, 10 + t * 40, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
    } else {
      const seg = t < 0.5 ? 0 : 1, k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const A = a.pts[seg], B = a.pts[seg + 1];
      ctx.strokeStyle = a.color; ctx.globalAlpha = .35; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.pts[0].x, a.pts[0].y); ctx.lineTo(a.pts[1].x, a.pts[1].y); ctx.lineTo(a.pts[2].x, a.pts[2].y); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(A.x + (B.x - A.x) * k, A.y + (B.y - A.y) * k, 5, 0, 7); ctx.fill();
    }
  }
  if (!S.devices.some(d => d.m)) {
    ctx.fillStyle = C.muted; ctx.font = '500 12.5px system-ui,sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('66 спутников Iridium покрывают всю Землю', 12, L.ground + 16);
  }
  requestAnimationFrame(drawSky);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/* ---------------- перерисовка ---------------- */

// В фоновой вкладке requestAnimationFrame стоит на паузе, а сообщения со спутника всё равно приходят.
const nextFrame = fn => (document.hidden ? setTimeout(fn, 50) : requestAnimationFrame(fn));

let raf = 0, labT = 0, labForce = false;
function schedule() {
  if (raf) return;
  raf = nextFrame(() => {
    raf = 0;
    refreshPhone(); refreshChips(); refreshSkyTools();
    const t = performance.now();
    // правую панель перерисовываем не чаще ~3 раз в секунду и не трогаем, пока в ней что-то выбирают
    const editing = ['optPoll', 'optReceipts', 'atCmd'].includes(document.activeElement?.id);
    if (labForce || (t - labT > 350 && !editing)) {
      renderLab();
      labT = t; labForce = false;
    }
  });
}
function scheduleLab(force = false) { if (force) labForce = true; schedule(); }

/* ---------------- события ---------------- */

document.addEventListener('click', async e => {
  const view = e.target.closest('#mobnav [data-view]');
  if (view) {
    document.body.dataset.view = view.dataset.view;
    document.querySelectorAll('#mobnav button').forEach(b => b.setAttribute('aria-pressed', b === view));
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const dev = S.active, m = dev?.m, id = el.dataset.id;
  switch (el.dataset.act) {
    case 'startSim': return startSim();
    case 'startModem': return startModem();
    case 'toMode': S.mode = null; S.devices = []; S.active = null; return go('mode');
    case 'pick': S.active = S.devices.filter(d => d.m)[+el.dataset.i]; S.chat = null; return go(S.screen === 'contacts' ? 'contacts' : 'home');
    case 'home': S.chat = null; return go('home');
    case 'contacts': return go('contacts');
    case 'open': S.chat = id; go('chat'); setTimeout(() => $('#inp')?.focus(), 50); return;
    case 'send': return sendDraft();
    case 'cancel': m.cancel(id); return;
    case 'sync': m.sync().catch(err => toast(err.message, true)); return schedule();
    case 'signal': await refreshSignals(); toast(dev.signal == null ? 'Модем не ответил' : `Сигнал: ${dev.signal} из 5`); return;
    case 'retryNow': m.retryNow(); m.sync().catch(err => toast(err.message, true)); return;
    case 'disconnect': m.stop(); await dev.modem.close(); dev.disconnected = true; return schedule();
    case 'copyCode': {
      const t = $('#mycode');
      try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand('copy'); }
      return toast('Код скопирован');
    }
    case 'addContact': {
      try {
        const c = await m.addContact($('#peerCode').value, $('#peerName').value);
        $('#peerCode').value = ''; $('#peerName').value = ''; $('#addErr').textContent = '';
        toast(`Контакт ${c.name} добавлен`);
      } catch (err) { $('#addErr').textContent = err.message; }
      return;
    }
    case 'fillSerial': $('#reqSerial').value = el.dataset.serial; $('#reqSerial').focus(); return;
    case 'requestContact': {
      try {
        const r = await m.requestContact($('#reqSerial').value);
        $('#reqSerial').value = ''; $('#reqErr').textContent = '';
        toast(r.status ? `Запрос на RB${r.serial} отправляется через спутник` : `${r.name} теперь в ваших контактах`);
      } catch (err) { $('#reqErr').textContent = err.message; }
      return;
    }
    case 'cancelInvite': m.cancelInvite(id); return;
    case 'acceptReq': {
      const c = await m.acceptRequest(id);
      toast(`${c.name} теперь в ваших чатах`);
      return;
    }
    case 'declineReq': m.declineRequest(id); return;
    case 'createProfile': {
      try {
        await attachMessenger(dev, { storage: dev.storage, name: $('#suName').value, serial: $('#suSerial').value });
        go('home');
      } catch (err) { $('#suErr').textContent = err.message; }
      return;
    }
    case 'atSend': {
      const inp = $('#atCmd');
      const cmd = inp.value.trim();
      if (!cmd) return;
      inp.value = '';
      try { await dev.modem.command(cmd, { timeout: 15000 }); } catch (err) { toast(err.message, true); }
      return scheduleLab(true);
    }
  }
});

document.addEventListener('change', e => {
  const dev = S.active;
  if (e.target.id === 'skySel') { dev.fake.sky = e.target.value; refreshSignals(); return scheduleLab(true); }
  if (e.target.id === 'optReceipts') { dev.m.receipts = e.target.checked; saveSettings(dev, { receipts: e.target.checked }); return; }
  if (e.target.id === 'optPoll') { const v = +e.target.value; dev.m.start({ pollMs: v }); saveSettings(dev, { pollMs: v }); }
});

document.addEventListener('input', e => {
  if (e.target.id === 'inp') { autoGrow(e.target); updateMeter(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'inp') { e.preventDefault(); sendDraft(); }
  if (e.key === 'Enter' && e.target.id === 'atCmd') { e.preventDefault(); $('[data-act="atSend"]').click(); }
});

/* ---------------- старт ---------------- */

readColors();
schedule();
scheduleLab(true);
requestAnimationFrame(drawSky);

// Офлайн: после первой загрузки сайт открывается без интернета (service worker кэширует все файлы).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
