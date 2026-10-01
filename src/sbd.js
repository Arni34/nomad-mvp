// Драйвер Iridium SBD-модема (9602 / 9603, в т.ч. RockBLOCK 9603) по AT-командам.
//
// io — любой байтовый канал: { write(Uint8Array): Promise, onData: (Uint8Array) => void, close() }.
// В браузере это Web Serial (openWebSerial ниже), в симуляторе и тестах — FakeModem из sim.js.
//
// Используемые команды (Iridium ISU AT Command Reference):
//   AT, ATE0, AT&K0          — проверка связи, без эха, без аппаратного flow control
//   AT+CGSN                  — IMEI
//   AT+CSQF                  — уровень сигнала 0..5 (быстрый, без ожидания)
//   AT+SBDMTA=1              — включить SBDRING (уведомление о входящем на шлюзе)
//   AT+SBDWB=<n>             — записать n байт в MO-буфер: READY → данные + 2 байта checksum → 0/1/2/3
//   AT+SBDIX[A]              — сеанс связи: +SBDIX: mo, momsn, mt, mtmsn, mtLen, mtQueued
//   AT+SBDRB                 — прочитать MT-буфер: [len 2][data][checksum 2]
//   AT+SBDD0                 — очистить MO-буфер (иначе следующий сеанс отправит его повторно)
import { te, concat, Emitter } from './util.js';

const CR = 0x0d, LF = 0x0a;

export class ModemError extends Error {}

export const MO_STATUS = {
  0: 'Передано на спутник',
  1: 'Передано (входящее слишком велико)',
  2: 'Передано (без location update)',
  10: 'Сеанс не завершился вовремя',
  11: 'Очередь на шлюзе переполнена',
  12: 'Слишком много сегментов',
  13: 'Сеанс прервался',
  14: 'Неверный размер сегмента',
  15: 'Доступ запрещён (нет активной линии?)',
  16: 'Модем заблокирован',
  17: 'Шлюз не отвечает',
  18: 'Потеря радиосвязи',
  19: 'Сбой канала',
  32: 'Нет сети: спутники не видны',
  33: 'Неисправна антенна',
  34: 'Радио выключено',
  35: 'Модем занят',
  36: 'Подождите 3 минуты',
  37: 'SBD временно недоступен',
  38: 'Ограничение трафика, повторите позже',
};
export const moOk = code => code >= 0 && code <= 4;
export const moText = code => MO_STATUS[code] ?? `Ошибка сеанса ${code}`;

const SBDWB_RESULT = {
  1: 'SBDWB: таймаут передачи данных',
  2: 'SBDWB: неверная контрольная сумма',
  3: 'SBDWB: неверный размер сообщения',
};

// Контрольная сумма SBD: сумма байтов, младшие 16 бит, big-endian.
export function checksum(bytes) {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xffff;
  return new Uint8Array([s >> 8, s & 0xff]);
}

const ascii = u8 => String.fromCharCode(...u8);
const isText = b => b >= 0x41 && b <= 0x5a; // A..Z — начало эха команды или SBDRING

export class SbdModem extends Emitter {
  constructor(io, { timeoutMs = 10000, sessionTimeoutMs = 120000 } = {}) {
    super();
    this.io = io;
    this.timeoutMs = timeoutMs;
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.buf = new Uint8Array(0);
    this.waiter = null;
    this.chain = Promise.resolve();
    this.busy = false;
    this.imei = null;
    io.onData = chunk => this._onData(chunk);
  }

  /* ---------- приём байтов ---------- */

  _onData(chunk) {
    this.buf = concat(this.buf, chunk);
    if (!this.busy) this._drainIdle();
    const w = this.waiter;
    if (w) { this.waiter = null; w(); }
  }

  // Между командами модем может прислать только незапрошенные строки (SBDRING).
  _drainIdle() {
    while (this._takeLine() !== undefined) { /* _takeLine сам сообщает о SBDRING */ }
  }

  // Ровно одна строка из буфера (может быть пустой); undefined — строка ещё не пришла целиком.
  _takeRawLine() {
    let i = 0;
    while (i < this.buf.length && this.buf[i] !== CR && this.buf[i] !== LF) i++;
    if (i === this.buf.length) return undefined;
    const s = ascii(this.buf.slice(0, i)).trim();
    this.buf = this.buf.slice(i + 1);
    if (s === 'SBDRING') { this._log('<', s); this.emit('ring'); return ''; }
    return s;
  }

  // Следующая непустая строка (разделители CR и LF) или undefined, если строка ещё не пришла целиком.
  _takeLine() {
    for (;;) {
      const s = this._takeRawLine();
      if (s === undefined) return undefined;
      if (s) return s;
    }
  }

  _until(take, timeout) {
    const end = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const step = () => {
        let v;
        try { v = take(); } catch (e) { return reject(e); }
        if (v !== undefined) return resolve(v);
        const left = end - Date.now();
        if (left <= 0) return reject(new ModemError('Модем не ответил вовремя'));
        const t = setTimeout(() => { if (this.waiter === wake) this.waiter = null; step(); }, left);
        const wake = () => { clearTimeout(t); step(); };
        this.waiter = wake;
      };
      step();
    });
  }

  _line(timeout = this.timeoutMs) { return this._until(() => this._takeLine(), timeout); }

  _log(dir, text) { this.emit('log', { dir, text }); }

  /* ---------- команды ---------- */

  // Команды выполняются строго по одной.
  _exclusive(fn) {
    const run = this.chain.then(async () => {
      this.busy = true;
      try { return await fn(); }
      finally { this.busy = false; this._drainIdle(); }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  async _send(cmd) {
    this._drainIdle();
    this.buf = new Uint8Array(0);
    this._log('>', cmd);
    await this.io.write(te.encode(cmd + '\r'));
  }

  async _cmd(cmd, timeout = this.timeoutMs) {
    await this._send(cmd);
    const lines = [];
    for (;;) {
      const l = await this._line(timeout);
      if (l === cmd) continue; // эхо
      this._log('<', l);
      if (l === 'OK') return lines;
      if (l === 'ERROR') throw new ModemError(`${cmd}: ERROR`);
      lines.push(l);
    }
  }

  command(cmd, opts = {}) { return this._exclusive(() => this._cmd(cmd, opts.timeout)); }

  init() {
    return this._exclusive(async () => {
      let alive = false;
      for (let i = 0; i < 3 && !alive; i++) {
        try { await this._cmd('AT', 2500); alive = true; } catch { /* модем мог просыпаться */ }
      }
      if (!alive) throw new ModemError('Модем не отвечает. Проверьте кабель, питание и скорость 19200.');
      await this._cmd('ATE0');
      await this._cmd('AT&K0');
      await this._cmd('AT+SBDMTA=1');
      const lines = await this._cmd('AT+CGSN');
      this.imei = lines.find(l => /^\d{15}$/.test(l)) || lines[0] || null;
      return { imei: this.imei };
    });
  }

  async signal() {
    const lines = await this.command('AT+CSQF');
    const m = lines.join(' ').match(/\+CSQF?:\s*(\d)/);
    if (!m) throw new ModemError('Не удалось прочитать уровень сигнала');
    return +m[1];
  }

  writeMO(bytes) {
    if (bytes.length < 1 || bytes.length > 340) return Promise.reject(new ModemError('MO-сообщение: от 1 до 340 байт'));
    return this._exclusive(async () => {
      const cmd = `AT+SBDWB=${bytes.length}`;
      await this._send(cmd);
      for (;;) {
        const l = await this._line();
        if (l === cmd) continue;
        this._log('<', l);
        if (l === 'READY') break;
        if (l === 'ERROR') throw new ModemError(`${cmd}: ERROR`);
        if (SBDWB_RESULT[l]) throw new ModemError(SBDWB_RESULT[l]);
      }
      this._log('>', `[${bytes.length} байт + checksum]`);
      await this.io.write(concat(bytes, checksum(bytes)));
      let code = null;
      for (;;) {
        const l = await this._line();
        this._log('<', l);
        if (/^[0-3]$/.test(l)) code = +l;
        else if (l === 'OK') break;
        else if (l === 'ERROR') throw new ModemError(`${cmd}: ERROR`);
      }
      if (code !== 0) throw new ModemError(SBDWB_RESULT[code] || 'SBDWB: неожиданный ответ');
    });
  }

  async session({ answer = false } = {}) {
    const lines = await this.command(answer ? 'AT+SBDIXA' : 'AT+SBDIX', { timeout: this.sessionTimeoutMs });
    const l = lines.find(x => x.startsWith('+SBDIX'));
    if (!l) throw new ModemError('Нет ответа +SBDIX');
    const n = l.slice(l.indexOf(':') + 1).split(',').map(s => parseInt(s, 10));
    if (n.length < 6 || n.some(Number.isNaN)) throw new ModemError('Не разобран ответ +SBDIX');
    const [mo, momsn, mt, mtmsn, mtLength, mtQueued] = n;
    return { mo, momsn, mt, mtmsn, mtLength, mtQueued, moOk: moOk(mo), text: moText(mo) };
  }

  readMT() {
    return this._exclusive(async () => {
      await this._send('AT+SBDRB');
      const take = () => {
        // перед бинарным ответом могут оказаться пустые строки, эхо или SBDRING —
        // длина не больше 270, её старший байт (0 или 1) никогда не буква.
        // Снимаем строго по одной текстовой строке, чтобы не залезть в бинарные данные.
        for (;;) {
          let i = 0;
          while (i < this.buf.length && (this.buf[i] === CR || this.buf[i] === LF)) i++;
          this.buf = this.buf.slice(i);
          if (!this.buf.length || !isText(this.buf[0])) break;
          if (this._takeRawLine() === undefined) return undefined;
        }
        const b = this.buf;
        if (b.length < 2) return undefined;
        const len = (b[0] << 8) | b[1];
        if (len > 340) throw new ModemError('MT: неверная длина');
        if (b.length < len + 4) return undefined;
        this.buf = b.slice(len + 4);
        return { msg: b.slice(2, 2 + len), cs: b.slice(2 + len, 4 + len) };
      };
      const { msg, cs } = await this._until(take, this.timeoutMs);
      for (;;) {
        const l = await this._line();
        if (l === 'OK') break;
        if (l === 'ERROR') throw new ModemError('AT+SBDRB: ERROR');
      }
      const exp = checksum(msg);
      if (exp[0] !== cs[0] || exp[1] !== cs[1]) throw new ModemError('MT: неверная контрольная сумма');
      this._log('<', `[${msg.length} байт]`);
      return msg;
    });
  }

  async clearMO() {
    const lines = await this.command('AT+SBDD0');
    if (lines.includes('1')) throw new ModemError('Не удалось очистить MO-буфер');
  }

  close() { return this.io.close?.(); }
}

/* ---------- Web Serial (Chrome / Edge на компьютере) ---------- */

export const hasWebSerial = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export async function openWebSerial({ baudRate = 19200 } = {}) {
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  const io = {
    onData: null,
    onClose: null,
    write: data => writer.write(data),
    async close() {
      try { await reader.cancel(); } catch { /* уже закрыт */ }
      reader.releaseLock(); writer.releaseLock();
      await port.close().catch(() => {});
    },
  };
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && io.onData) io.onData(value);
      }
    } catch { /* кабель отключили */ }
    io.onClose?.();
  })();
  return io;
}
