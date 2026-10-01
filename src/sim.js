// Симулятор сети Iridium + облака RockBLOCK.
//
// FakeModem — виртуальный модем 9603, который отвечает на те же AT-команды, что и настоящий.
// Поэтому в демо-режиме и в тестах работает ровно тот же драйвер (sbd.js) и тот же мессенджер,
// что и с реальным железом; подменяется только байтовый канал.
//
// SimIridium моделирует то, что происходит «наверху»: принимает MO, разбирает адрес RB<serial>,
// кладёт сообщение в очередь получателя на шлюзе и шлёт ему SBDRING. Получатель забирает
// сообщение своим сеансом SBDIX — как в реальной сети, store-and-forward происходит на шлюзе.
import { te, concat, Emitter, bytesEqual } from './util.js';
import { parseRbAddress, MO_MAX } from './protocol.js';
import { checksum } from './sbd.js';

export const SKY = {
  open: { label: 'Открытое небо', csq: [3, 5], fail: 0.08 },
  partial: { label: 'Деревья / здания рядом', csq: [1, 3], fail: 0.45 },
  blocked: { label: 'В помещении', csq: [0, 0], fail: 1 },
};

const between = (rng, [a, b]) => a + rng() * (b - a);

export class SimIridium extends Emitter {
  constructor({
    sessionMs = [1800, 4200],
    gatewayMs = [700, 1500],
    ringDelayMs = [400, 1200],
    failRate = null,          // null — по условиям неба, число — принудительно (в тестах 0)
    rng = Math.random,
  } = {}) {
    super();
    Object.assign(this, { sessionMs, gatewayMs, ringDelayMs, failRate, rng });
    this.devices = new Map();
    this.queues = new Map();
    this.timers = new Set();
    this.stats = { mo: 0, mt: 0, dropped: 0, bytes: 0 };
  }

  later(fn, ms) {
    // мгновенные ответы модема — микрозадачей: в фоновой вкладке setTimeout(0) растягивается до секунды
    if (!ms) { queueMicrotask(() => { if (!this.disposed) fn(); }); return; }
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  createModem({ serial, imei, sky = 'open' }) {
    const m = new FakeModem(this, { serial, imei, sky });
    this.devices.set(serial, m);
    if (!this.queues.has(serial)) this.queues.set(serial, []);
    return m;
  }

  queued(serial) { return (this.queues.get(serial) || []).length; }

  _mo(from, bytes) {
    this.stats.mo++;
    this.stats.bytes += bytes.length;
    this.emit('mo', { from, size: bytes.length });
    const addr = parseRbAddress(bytes);
    if (!addr) {
      this.stats.dropped++;
      this.emit('drop', { from, reason: 'нет адреса RB — ушло бы на webhook владельца' });
      return;
    }
    this.later(() => {
      const q = this.queues.get(addr.serial);
      if (!q) {
        this.stats.dropped++;
        this.emit('drop', { from, to: addr.serial, reason: 'модем с таким серийным номером не найден' });
        return;
      }
      q.push(addr.payload);
      this.emit('queued', { from, to: addr.serial, size: addr.payload.length });
      this.devices.get(addr.serial)?._ring();
    }, between(this.rng, this.gatewayMs));
  }

  _takeMT(serial) {
    const q = this.queues.get(serial) || [];
    const msg = q.shift();
    if (msg) { this.stats.mt++; this.emit('mt', { to: serial, size: msg.length }); }
    return { msg, queued: q.length };
  }
}

export class FakeModem {
  constructor(net, { serial, imei, sky }) {
    this.net = net;
    this.serial = serial;
    this.imei = imei || '30043406' + serial;
    this.sky = sky;
    this.onData = null;
    this.echo = true;           // как у настоящего модема после включения
    this.ringAlerts = false;
    this.mo = null;
    this.mt = new Uint8Array(0);
    this.momsn = 0;
    this.mtmsn = 0;
    this.rx = new Uint8Array(0);
    this.binary = null;
  }

  /* --- io-интерфейс для SbdModem --- */
  async write(u8) { this.rx = concat(this.rx, u8); this._process(); }
  close() {}

  _out(data) {
    const b = typeof data === 'string' ? te.encode(data) : data;
    this.net.later(() => this.onData?.(b), 0);
  }
  _resp(...lines) { this._out(lines.map(l => `\r\n${l}\r\n`).join('')); }

  csq() {
    const [a, b] = SKY[this.sky].csq;
    return Math.round(between(this.net.rng, [a, b]));
  }

  _process() {
    for (;;) {
      if (this.binary) {
        const need = this.binary.len + 2;
        if (this.rx.length < need) return;
        const data = this.rx.slice(0, this.binary.len);
        const cs = this.rx.slice(this.binary.len, need);
        this.rx = this.rx.slice(need);
        this.binary = null;
        const ok = bytesEqual(checksum(data), cs);
        if (ok) this.mo = data;
        this._resp(ok ? '0' : '2', 'OK');
        continue;
      }
      const i = this.rx.indexOf(0x0d);
      if (i < 0) return;
      const cmd = String.fromCharCode(...this.rx.slice(0, i)).trim();
      this.rx = this.rx.slice(i + 1);
      if (!cmd) continue;
      if (this.echo) this._out(cmd + '\r');
      this._exec(cmd.toUpperCase());
    }
  }

  _exec(cmd) {
    let m;
    if (cmd === 'AT' || cmd === 'AT&K0' || cmd === 'AT&K3') return this._resp('OK');
    if (cmd === 'ATE0' || cmd === 'ATE1') { this.echo = cmd === 'ATE1'; return this._resp('OK'); }
    if (cmd === 'AT+CGSN') return this._resp(this.imei, 'OK');
    if ((m = cmd.match(/^AT\+CSQ(F?)$/))) return this._resp(`+CSQ${m[1]}:${this.csq()}`, 'OK');
    if ((m = cmd.match(/^AT\+SBDMTA=([01])$/))) { this.ringAlerts = m[1] === '1'; return this._resp('OK'); }
    if ((m = cmd.match(/^AT\+SBDWB=(\d+)$/))) {
      const len = +m[1];
      if (len < 1 || len > MO_MAX) return this._resp('3', 'OK');
      this.binary = { len };
      return this._out('READY\r\n');
    }
    if (cmd === 'AT+SBDIX' || cmd === 'AT+SBDIXA') return this._session();
    if (cmd === 'AT+SBDRB') {
      const len = this.mt.length;
      return this._out(concat(new Uint8Array([len >> 8, len & 0xff]), this.mt, checksum(this.mt), te.encode('\r\nOK\r\n')));
    }
    if ((m = cmd.match(/^AT\+SBDD([012])$/))) {
      if (m[1] !== '1') this.mo = null;
      if (m[1] !== '0') this.mt = new Uint8Array(0);
      return this._resp('0', 'OK');
    }
    return this._resp('ERROR');
  }

  _session() {
    const net = this.net;
    const csq = this.csq();
    net.emit('session-start', { serial: this.serial, csq, sending: !!this.mo });
    net.later(() => {
      const failRate = net.failRate ?? SKY[this.sky].fail;
      const code = csq === 0 ? 32 : net.rng() < failRate ? (net.rng() < 0.5 ? 18 : 13) : 0;
      if (code) {
        net.emit('session-end', { serial: this.serial, ok: false, code });
        return this._resp(`+SBDIX: ${code}, ${this.momsn}, 2, ${this.mtmsn}, 0, 0`, 'OK');
      }
      const sent = !!this.mo;
      if (sent) {
        this.momsn = (this.momsn + 1) & 0xffff;
        net._mo(this.serial, this.mo);   // MO-буфер не очищается — как у настоящего модема
      }
      const { msg, queued } = net._takeMT(this.serial);
      let mt = 0;
      if (msg) { this.mt = msg; this.mtmsn = (this.mtmsn + 1) & 0xffff; mt = 1; }
      net.emit('session-end', { serial: this.serial, ok: true, code: 0, sent, received: !!msg });
      this._resp(`+SBDIX: 0, ${this.momsn}, ${mt}, ${this.mtmsn}, ${msg ? msg.length : 0}, ${queued}`, 'OK');
    }, between(net.rng, net.sessionMs));
  }

  _ring() {
    if (!this.ringAlerts || this.csq() === 0) return;
    this.net.later(() => this._out('SBDRING\r\n'), between(this.net.rng, this.net.ringDelayMs));
  }
}
