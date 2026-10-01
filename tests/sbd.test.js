import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SbdModem, checksum, moOk } from '../src/sbd.js';
import { te, concat } from '../src/util.js';
import { parseRbAddress, rbAddress } from '../src/protocol.js';
import { fastNet, waitFor } from './helpers.js';

// Последовательный порт, который отвечает по сценарию: handler(cmd) → строка/байты ответа.
function scriptedIo(handler) {
  const io = {
    onData: null,
    sent: [],
    async write(u8) {
      const s = String.fromCharCode(...u8);
      io.sent.push(s);
      const out = handler(s.replace(/\r$/, ''), u8);
      if (out != null) setTimeout(() => io.onData(typeof out === 'string' ? te.encode(out) : out), 1);
    },
    push(data) { io.onData(typeof data === 'string' ? te.encode(data) : data); },
  };
  return io;
}

test('checksum SBD: сумма байтов, 16 бит, big-endian', () => {
  assert.deepEqual(checksum(te.encode('hello')), new Uint8Array([0x02, 0x14]));
  assert.deepEqual(checksum(new Uint8Array(300).fill(255)), new Uint8Array([0x2a, 0xd4]));
  assert.deepEqual(checksum(new Uint8Array(0)), new Uint8Array([0, 0]));
});

test('коды MO 0–4 — успех, остальные — ошибка', () => {
  for (const c of [0, 1, 2, 3, 4]) assert.ok(moOk(c));
  for (const c of [5, 13, 18, 32, 35]) assert.ok(!moOk(c));
});

test('init: модем с включённым эхом → выключаем эхо, читаем IMEI', async () => {
  const net = fastNet();
  const fake = net.createModem({ serial: '0000001' });
  assert.equal(fake.echo, true);
  const modem = new SbdModem(fake, { timeoutMs: 500 });
  const info = await modem.init();
  assert.equal(info.imei, '300434060000001');
  assert.equal(fake.echo, false);
  assert.equal(fake.ringAlerts, true, 'включены уведомления SBDRING');
  net.dispose();
});

test('writeMO + SBDIX: сообщение уходит на шлюз и доходит до адресата', async () => {
  const net = fastNet();
  const a = new SbdModem(net.createModem({ serial: '0000001' }), { timeoutMs: 500 });
  const b = new SbdModem(net.createModem({ serial: '0000002' }), { timeoutMs: 500 });
  await a.init(); await b.init();
  const payload = te.encode('проверка связи');
  await a.writeMO(rbAddress('2', payload));
  const r = await a.session();
  assert.equal(r.mo, 0);
  assert.equal(r.momsn, 1);
  await a.clearMO();
  assert.equal(net.devices.get('0000001').mo, null, 'MO-буфер очищен');
  await waitFor(() => net.queued('0000002') === 1, 1000, 'сообщение на шлюзе');
  const rb = await b.session();
  assert.equal(rb.mt, 1);
  assert.equal(rb.mtLength, payload.length);
  assert.deepEqual(await b.readMT(), payload);
  net.dispose();
});

test('SBDRING: незапрошенное уведомление о входящем', async () => {
  const net = fastNet();
  const a = new SbdModem(net.createModem({ serial: '0000001' }), { timeoutMs: 500 });
  const b = new SbdModem(net.createModem({ serial: '0000002' }), { timeoutMs: 500 });
  await a.init(); await b.init();
  let rings = 0;
  b.on('ring', () => rings++);
  await a.writeMO(rbAddress('2', te.encode('x')));
  await a.session();
  await waitFor(() => rings === 1, 1000, 'SBDRING');
  net.dispose();
});

test('без неба: SBDIX возвращает 32 «нет сети», MT-статус 2', async () => {
  const net = fastNet();
  const m = new SbdModem(net.createModem({ serial: '0000001', sky: 'blocked' }), { timeoutMs: 500 });
  await m.init();
  assert.equal(await m.signal(), 0);
  const r = await m.session();
  assert.equal(r.mo, 32);
  assert.equal(r.mt, 2);
  assert.equal(r.moOk, false);
  assert.match(r.text, /Нет сети/);
  net.dispose();
});

test('writeMO проверяет размер до отправки в модем', async () => {
  const io = scriptedIo(() => '\r\nOK\r\n');
  const m = new SbdModem(io);
  await assert.rejects(m.writeMO(new Uint8Array(341)), /340/);
  await assert.rejects(m.writeMO(new Uint8Array(0)), /340/);
  assert.equal(io.sent.length, 0);
});

test('writeMO: модем сообщил о неверной контрольной сумме', async () => {
  const io = scriptedIo(cmd => cmd.startsWith('AT+SBDWB') ? 'READY\r\n' : '\r\n2\r\n\r\nOK\r\n');
  const m = new SbdModem(io, { timeoutMs: 300 });
  await assert.rejects(m.writeMO(te.encode('abc')), /контрольная сумма/);
  const data = io.sent[1];
  assert.equal(data.length, 5, '3 байта данных + 2 байта checksum');
});

test('readMT: неверная контрольная сумма в ответе модема', async () => {
  const io = scriptedIo(() => concat(new Uint8Array([0, 3]), te.encode('abc'), new Uint8Array([9, 9]), te.encode('\r\nOK\r\n')));
  const m = new SbdModem(io, { timeoutMs: 300 });
  await assert.rejects(m.readMT(), /контрольная сумма/);
});

test('readMT: SBDRING и эхо перед бинарным ответом не ломают разбор', async () => {
  const msg = te.encode('hi');
  const io = scriptedIo(() => concat(te.encode('AT+SBDRB\rSBDRING\r\n'), new Uint8Array([0, 2]), msg, checksum(msg), te.encode('\r\nOK\r\n')));
  const m = new SbdModem(io, { timeoutMs: 300 });
  let rings = 0;
  m.on('ring', () => rings++);
  assert.deepEqual(await m.readMT(), msg);
  assert.equal(rings, 1);
});

test('readMT: ответ приходит по одному байту', async () => {
  const msg = te.encode('по кусочкам');
  const full = concat(new Uint8Array([0, msg.length]), msg, checksum(msg), te.encode('\r\nOK\r\n'));
  const io = scriptedIo(() => null);
  const m = new SbdModem(io, { timeoutMs: 1000 });
  const p = m.readMT();
  for (const b of full) { await new Promise(r => setTimeout(r, 0)); io.push(new Uint8Array([b])); }
  assert.deepEqual(await p, msg);
});

test('ERROR от модема превращается в исключение', async () => {
  const io = scriptedIo(() => '\r\nERROR\r\n');
  const m = new SbdModem(io, { timeoutMs: 300 });
  await assert.rejects(m.command('AT+FOO'), /ERROR/);
});

test('молчащий модем: понятная ошибка вместо зависания', async () => {
  const io = scriptedIo(() => null);
  const m = new SbdModem(io, { timeoutMs: 50 });
  await assert.rejects(m.command('AT'), /не ответил/);
});

test('команды выполняются строго по очереди', async () => {
  const net = fastNet();
  const fake = net.createModem({ serial: '0000001' });
  const m = new SbdModem(fake, { timeoutMs: 500 });
  await m.init();
  const [s1, imei, s2] = await Promise.all([m.signal(), m.command('AT+CGSN'), m.signal()]);
  assert.ok(s1 >= 3 && s2 >= 3);
  assert.deepEqual(imei, ['300434060000001']);
  net.dispose();
});

test('шлюз RockBLOCK: сообщение без адреса RB не пересылается', async () => {
  const net = fastNet();
  const m = new SbdModem(net.createModem({ serial: '0000001' }), { timeoutMs: 500 });
  await m.init();
  const drops = [];
  net.on('drop', d => drops.push(d));
  await m.writeMO(te.encode('no address'));
  await m.session();
  assert.equal(drops.length, 1);
  assert.equal(parseRbAddress(te.encode('no address')), null);
  net.dispose();
});
