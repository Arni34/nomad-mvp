// Ядро мессенджера: личность, контакты, переписка, исходящая очередь и сеансы связи.
// Не знает, настоящий модем перед ним или симулятор — работает через SbdModem.
import { Emitter, hex, b64u, unb64u } from './util.js';
import * as P from './protocol.js';

export const STATUS = {
  QUEUED: 'queued',       // ждёт сеанса со спутником
  SENDING: 'sending',     // идёт сеанс
  SENT: 'sent',           // принято сетью Iridium, лежит на шлюзе у получателя
  DELIVERED: 'delivered', // получатель забрал и расшифровал (пришло подтверждение)
  CANCELED: 'canceled',
};

export class MemoryStorage {
  constructor() { this.m = new Map(); }
  get(k) { return this.m.has(k) ? JSON.parse(this.m.get(k)) : null; }
  set(k, v) { this.m.set(k, JSON.stringify(v)); }
}

export class LocalStorage {
  constructor(prefix) { this.p = prefix; }
  get(k) {
    try { const v = localStorage.getItem(this.p + k); return v == null ? null : JSON.parse(v); } catch { return null; }
  }
  set(k, v) {
    try { localStorage.setItem(this.p + k, JSON.stringify(v)); } catch { /* приватный режим / нет места */ }
  }
}

const SEEN_MAX = 2000;
// RockBLOCK списывает 1 кредит за каждые начатые 50 байт сообщения (оценка, без учёта абонплаты).
export const creditsFor = bytes => Math.ceil(bytes / 50);
const MESSAGES_MAX = 2000;

export class Messenger extends Emitter {
  constructor({ modem = null, storage = new MemoryStorage(), clock = () => Date.now(), receipts = true, retryBaseMs = 30000, retryMaxMs = 10 * 60000 } = {}) {
    super();
    Object.assign(this, { modem, storage, clock, receipts, retryBaseMs, retryMaxMs });
    this.keys = new Map();
    this.stats = { sessions: 0, failed: 0, moBytes: 0, mtBytes: 0, rejected: 0, credits: 0 };
    this.lastSession = null;
    this.lastReject = null;
    this.syncing = null;
    this.timer = null;
    this.pollMs = 0;
    this.lastPoll = 0;
  }

  static hasProfile(storage) { return !!storage.get('identity'); }

  async init({ name, serial } = {}) {
    const saved = this.storage.get('identity');
    if (saved) {
      this.identity = await P.importIdentity(saved.key);
      this.name = saved.name;
      this.serial = saved.serial;
    } else {
      if (!name || !String(name).trim()) throw new Error('Укажите имя');
      this.serial = P.normSerial(serial);
      this.name = String(name).trim().slice(0, 40);
      this.identity = await P.createIdentity();
      this.storage.set('identity', { key: await P.exportIdentity(this.identity), name: this.name, serial: this.serial });
    }
    this.kid = hex(this.identity.kid);
    this.contacts = this.storage.get('contacts') || [];
    this.messages = this.storage.get('messages') || [];
    this.outbox = this.storage.get('outbox') || [];
    this.seen = this.storage.get('seen') || {};
    this.unread = this.storage.get('unread') || {};
    for (const m of this.messages) if (m.status === STATUS.SENDING) m.status = STATUS.QUEUED;
    this.modem?.on('ring', () => {
      this.emit('ring');
      this.sync({ answer: true }).catch(e => this.emit('error', e));
    });
    return this;
  }

  _save() {
    if (this.messages.length > MESSAGES_MAX) this.messages = this.messages.slice(-MESSAGES_MAX);
    this.storage.set('contacts', this.contacts);
    this.storage.set('messages', this.messages);
    this.storage.set('outbox', this.outbox);
    this.storage.set('seen', this.seen);
    this.storage.set('unread', this.unread);
  }

  _changed() { this._save(); this.emit('change'); }

  /* ---------- контакты ---------- */

  get contactCode() { return P.makeContactCode({ serial: this.serial, pub: this.identity.pub, name: this.name }); }

  contact(id) { return this.contacts.find(c => c.id === id) || null; }

  async addContact(code, name) {
    const c = P.parseContactCode(code);
    const id = hex(await P.keyId(c.pub));
    if (id === this.kid) throw new Error('Это ваш собственный код');
    const displayName = String(name || c.name || 'Контакт').trim().slice(0, 40);
    let existing = this.contact(id);
    if (existing) Object.assign(existing, { serial: c.serial, name: displayName });
    else {
      existing = { id, name: displayName, serial: c.serial, pub: b64u(c.pub), added: this.clock() };
      this.contacts.push(existing);
    }
    this._changed();
    return existing;
  }

  async _key(contact) {
    if (!this.keys.has(contact.id)) this.keys.set(contact.id, await P.deriveSessionKey(this.identity, unb64u(contact.pub)));
    return this.keys.get(contact.id);
  }

  /* ---------- переписка ---------- */

  conversation(contactId) { return this.messages.filter(m => m.contact === contactId); }

  markRead(contactId) {
    if (this.unread[contactId]) { this.unread[contactId] = 0; this._changed(); }
  }

  get unreadTotal() { return Object.values(this.unread).reduce((a, b) => a + b, 0); }

  // Сколько байт займёт текст после сжатия — для счётчика в поле ввода.
  async measure(text) { return (await P.encodeText(text)).body.length; }

  async send(contactId, text) {
    text = String(text).trim();
    if (!text) throw new Error('Пустое сообщение');
    const c = this.contact(contactId);
    if (!c) throw new Error('Нет такого контакта');
    const { flags, body } = await P.encodeText(text);
    if (body.length > P.BODY_MAX) throw new Error(`Слишком длинно: ${body.length} из ${P.BODY_MAX} байт`);
    const msgId = P.newMsgId();
    const packet = await P.seal({ key: await this._key(c), type: P.TYPE.TEXT, flags, msgId, senderKid: this.identity.kid, ts: Math.floor(this.clock() / 1000), body });
    const id = hex(msgId);
    const msg = { id, contact: c.id, dir: 'out', text, ts: this.clock(), status: STATUS.QUEUED, bytes: packet.length + P.RB_PREFIX_LEN, error: null };
    this.messages.push(msg);
    this.outbox.push({ id, contact: c.id, kind: 'text', packet: b64u(packet), attempts: 0, nextTry: 0 });
    this._changed();
    return msg;
  }

  cancel(id) {
    const i = this.outbox.findIndex(o => o.id === id);
    if (i < 0) return false;
    this.outbox.splice(i, 1);
    this._setStatus(id, STATUS.CANCELED, null);
    this._changed();
    return true;
  }

  retryNow() {
    for (const o of this.outbox) o.nextTry = 0;
    this._changed();
  }

  _setStatus(id, status, error) {
    const m = this.messages.find(x => x.id === id && x.dir === 'out');
    if (m && m.status !== STATUS.DELIVERED) { m.status = status; if (error !== undefined) m.error = error; }
  }

  async _queueAck(sender, refId) {
    const msgId = P.newMsgId();
    const packet = await P.seal({ key: await this._key(sender), type: P.TYPE.ACK, msgId, senderKid: this.identity.kid, ts: Math.floor(this.clock() / 1000), body: refId });
    this.outbox.push({ id: hex(msgId), contact: sender.id, kind: 'ack', packet: b64u(packet), attempts: 0, nextTry: 0 });
  }

  _reject(reason) {
    this.stats.rejected++;
    this.lastReject = { at: this.clock(), reason };
    this.emit('reject', reason);
    this.emit('change');
    return { rejected: reason };
  }

  // Входящий пакет — то, что модем отдал по AT+SBDRB.
  async receive(bytes) {
    let p;
    try { p = P.parsePacket(bytes); } catch (e) { return this._reject(e.message); }
    const sender = this.contact(hex(p.senderKid));
    if (!sender) return this._reject('Отправитель не в контактах');
    let body;
    try { body = await P.open(await this._key(sender), p); } catch { return this._reject('Не удалось расшифровать — пакет подделан или повреждён'); }
    const id = hex(p.msgId);
    if (this.seen[id]) return { duplicate: id };

    if (p.type === P.TYPE.TEXT) {
      let text;
      try { text = await P.decodeText(p.flags, body); } catch (e) { return this._reject(e.message); }
      this._remember(id);
      const msg = { id, contact: sender.id, dir: 'in', text, ts: this.clock(), sentTs: p.ts * 1000, status: STATUS.DELIVERED };
      this.messages.push(msg);
      this.unread[sender.id] = (this.unread[sender.id] || 0) + 1;
      if (this.receipts) await this._queueAck(sender, p.msgId);
      this._changed();
      this.emit('message', { message: msg, contact: sender });
      return { message: msg };
    }

    if (body.length !== P.ID_LEN) return this._reject('Неверное подтверждение');
    this._remember(id);
    const ref = hex(body);
    const m = this.messages.find(x => x.id === ref && x.dir === 'out' && x.contact === sender.id);
    if (m && m.status !== STATUS.DELIVERED) { m.status = STATUS.DELIVERED; m.deliveredAt = this.clock(); m.error = null; }
    this._changed();
    return { ack: ref };
  }

  _remember(id) {
    this.seen[id] = this.clock();
    const keys = Object.keys(this.seen);
    if (keys.length > SEEN_MAX) {
      keys.sort((a, b) => this.seen[a] - this.seen[b]);
      for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete this.seen[k];
    }
  }

  /* ---------- сеансы связи ---------- */

  _due() { const now = this.clock(); return this.outbox.find(o => o.nextTry <= now) || null; }

  _backoff(attempts) { return Math.min(this.retryBaseMs * 2 ** Math.max(0, attempts - 1), this.retryMaxMs); }

  // Один или несколько сеансов подряд: отправляет первое готовое сообщение из очереди,
  // забирает входящее и продолжает, пока на шлюзе что-то лежит или очередь не пуста.
  sync({ answer = false } = {}) {
    if (!this.modem) return Promise.reject(new Error('Модем не подключён'));
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        for (let i = 0; i < 12; i++) {
          this.again = false;
          const more = await this._cycle(answer);
          answer = false;
          if (!more && !this.again) break;
        }
      } finally {
        this.syncing = null;
        this.emit('change');
      }
    })();
    return this.syncing;
  }

  async _cycle(answer) {
    this.lastPoll = this.clock();
    const item = this._due();
    const contact = item && this.contact(item.contact);
    if (item && !contact) { this.outbox.splice(this.outbox.indexOf(item), 1); this._save(); return true; }

    let r = null, error = null, mo = null;
    try {
      if (item) {
        mo = P.rbAddress(contact.serial, unb64u(item.packet));
        await this.modem.writeMO(mo);
        item.attempts++;
        if (item.kind === 'text') this._setStatus(item.id, STATUS.SENDING, null);
        this.emit('change');
      }
      this.emit('session', { phase: 'start', sending: !!item });
      r = await this.modem.session({ answer });
    } catch (e) {
      error = e;
    }
    this.stats.sessions++;

    if (!r || !r.moOk) {
      this.stats.failed++;
      const text = r ? r.text : error.message;
      this.lastSession = { at: this.clock(), ok: false, text, code: r?.mo };
      if (item) {
        item.nextTry = this.clock() + this._backoff(item.attempts);
        if (item.kind === 'text') this._setStatus(item.id, STATUS.QUEUED, text);
        // в MO-буфере осталось сообщение — иначе проверка почты отправит его без нашего ведома
        await this.modem.clearMO().catch(() => {});
      }
      this._save();
      this.emit('session', { phase: 'end', ok: false, text });
      return false;
    }

    if (item) {
      this.outbox.splice(this.outbox.indexOf(item), 1);
      this.stats.moBytes += mo.length;
      this.stats.credits += creditsFor(mo.length);
      if (item.kind === 'text') {
        this._setStatus(item.id, STATUS.SENT, null);
        const m = this.messages.find(x => x.id === item.id);
        if (m) m.sentAt = this.clock();
      }
      await this.modem.clearMO();
    }
    let received = false;
    if (r.mt === 1) {
      const bytes = await this.modem.readMT();
      this.stats.mtBytes += bytes.length;
      this.stats.credits += creditsFor(bytes.length);
      received = true;
      await this.receive(bytes);
    }
    this.lastSession = { at: this.clock(), ok: true, text: r.text, sent: !!item, received, queued: r.mtQueued };
    this._save();
    this.emit('session', { phase: 'end', ok: true, sent: !!item, received, queued: r.mtQueued });
    return r.mtQueued > 0 || !!this._due();
  }

  // Автоматика: отправляет очередь по мере готовности и периодически проверяет почтовый ящик.
  start({ pollMs = 0, tickMs = 1000 } = {}) {
    this.stop();
    this.pollMs = pollMs;
    this.lastPoll = this.clock();
    this.timer = setInterval(() => {
      if (this.syncing) return;
      const poll = this.pollMs > 0 && this.clock() - this.lastPoll >= this.pollMs;
      if (this._due() || poll) this.sync().catch(e => this.emit('error', e));
    }, tickMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
