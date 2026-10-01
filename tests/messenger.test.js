import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Messenger, MemoryStorage, STATUS } from '../src/messenger.js';
import * as P from '../src/protocol.js';
import { unb64u } from '../src/util.js';
import { fastNet, pair, device, waitFor } from './helpers.js';

const outMsg = (m, text) => m.messages.find(x => x.dir === 'out' && x.text === text);
const inMsgs = (m, text) => m.messages.filter(x => x.dir === 'in' && x.text === text);

test('A → B через спутник: доставлено и подтверждено (✓✓)', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  const msg = await A.m.send(B.m.kid, 'Дошли до лагеря, всё ок');
  assert.equal(msg.status, STATUS.QUEUED);
  await A.m.sync();
  assert.equal(msg.status, STATUS.SENT, 'после сеанса сообщение в сети Iridium');
  // B получает SBDRING, сам проводит сеанс, расшифровывает и отправляет ACK
  await waitFor(() => inMsgs(B.m, 'Дошли до лагеря, всё ок').length === 1, 2000, 'B получил текст');
  assert.equal(B.m.unread[A.m.kid], 1);
  // ACK приходит к A тем же путём
  await waitFor(() => outMsg(A.m, 'Дошли до лагеря, всё ок').status === STATUS.DELIVERED, 2000, 'A получил ACK');
  assert.equal(A.m.outbox.length, 0);
  assert.equal(B.m.outbox.length, 0);
  net.dispose();
});

test('ответ B → A работает так же', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  await B.m.send(A.m.kid, 'Принято, ждём');
  await B.m.sync();
  await waitFor(() => inMsgs(A.m, 'Принято, ждём').length === 1, 2000);
  await waitFor(() => outMsg(B.m, 'Принято, ждём').status === STATUS.DELIVERED, 2000);
  net.dispose();
});

test('нет неба: сообщение остаётся в очереди и уходит, когда небо открылось', async () => {
  const net = fastNet();
  const [A, B] = await pair(net, { sky: 'blocked' });
  const msg = await A.m.send(B.m.kid, 'вышли из пещеры?');
  await A.m.sync();
  assert.equal(msg.status, STATUS.QUEUED);
  assert.match(msg.error, /Нет сети/);
  assert.equal(A.m.outbox[0].attempts, 1);
  assert.ok(A.m.outbox[0].nextTry > Date.now(), 'повтор с задержкой');
  assert.equal(A.fake.mo, null, 'неотправленное не оставлено в MO-буфере модема');
  assert.equal(net.stats.mo, 0);

  A.fake.sky = 'open';
  A.m.retryNow();
  await A.m.sync();
  assert.equal(msg.status, STATUS.SENT);
  await waitFor(() => msg.status === STATUS.DELIVERED, 2000);
  assert.equal(inMsgs(B.m, 'вышли из пещеры?').length, 1);
  net.dispose();
});

test('получатель без неба: сообщение ждёт на шлюзе (store-and-forward)', async () => {
  const net = fastNet();
  const [A, B] = await pair(net, {}, { sky: 'blocked' });
  await A.m.send(B.m.kid, 'жду на шлюзе');
  await A.m.sync();
  await waitFor(() => net.queued(B.m.serial) === 1, 1000, 'сообщение на шлюзе');
  await B.m.sync();
  assert.equal(inMsgs(B.m, 'жду на шлюзе').length, 0, 'без неба забрать нельзя');
  assert.equal(net.queued(B.m.serial), 1, 'но оно не потерялось');

  B.fake.sky = 'open';
  await B.m.sync();
  assert.equal(inMsgs(B.m, 'жду на шлюзе').length, 1);
  net.dispose();
});

test('несколько сообщений на шлюзе забираются за один вызов sync', async () => {
  const net = fastNet();
  const [A, B] = await pair(net, {}, { sky: 'blocked' });
  for (const t of ['раз', 'два', 'три']) await A.m.send(B.m.kid, t);
  await A.m.sync();
  assert.equal(A.m.outbox.length, 0, 'вся очередь ушла подряд');
  await waitFor(() => net.queued(B.m.serial) === 3, 1000);
  B.fake.sky = 'open';
  await B.m.sync();
  assert.deepEqual(B.m.messages.filter(m => m.dir === 'in').map(m => m.text), ['раз', 'два', 'три']);
  net.dispose();
});

test('после успешной отправки MO-буфер очищается — повторной отправки нет', async () => {
  const net = fastNet();
  const [A, B] = await pair(net, {}, { receipts: false });
  await A.m.send(B.m.kid, 'один раз');
  await A.m.sync();
  assert.equal(A.fake.mo, null);
  await A.m.sync(); // проверка почты
  await A.m.sync();
  assert.equal(net.stats.mo, 1, 'на шлюз ушло ровно одно MO');
  net.dispose();
});

test('дубликат пакета показывается один раз', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  await A.m.send(B.m.kid, 'дубль');
  const packet = unb64u(A.m.outbox[0].packet);
  assert.ok((await B.m.receive(packet)).message);
  assert.ok((await B.m.receive(packet)).duplicate);
  assert.equal(inMsgs(B.m, 'дубль').length, 1);
  net.dispose();
});

test('пакет от незнакомца отклоняется', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  const C = await device(net, { name: 'Чужой', serial: '0204599' });
  await C.m.addContact(B.m.contactCode); // C знает B, но B не добавлял C
  await C.m.send(B.m.kid, 'я свой, открой');
  const r = await B.m.receive(unb64u(C.m.outbox[0].packet));
  assert.match(r.rejected, /не в контактах/);
  assert.equal(B.m.messages.length, 0);
  assert.equal(B.m.stats.rejected, 1);
  net.dispose();
});

test('подделанный по дороге пакет отклоняется', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  await A.m.send(B.m.kid, 'оригинал');
  const packet = unb64u(A.m.outbox[0].packet);
  packet[packet.length - 5] ^= 0xff;
  const r = await B.m.receive(packet);
  assert.match(r.rejected, /расшифровать/);
  assert.equal(B.m.messages.length, 0);
  net.dispose();
});

test('чужое подтверждение не помечает сообщение доставленным', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  const C = await device(net, { name: 'Третий', serial: '0204513' });
  await A.m.addContact(C.m.contactCode);
  await C.m.addContact(A.m.contactCode);
  const msg = await A.m.send(B.m.kid, 'только для B');
  // C пытается подтвердить сообщение, которое ему не адресовано
  const key = await C.m._key(C.m.contact(A.m.kid));
  const fakeAck = await P.seal({ key, type: P.TYPE.ACK, msgId: P.newMsgId(), senderKid: C.m.identity.kid, ts: 1, body: Uint8Array.from(Buffer.from(msg.id, 'hex')) });
  await A.m.receive(fakeAck);
  assert.equal(msg.status, STATUS.QUEUED);
  net.dispose();
});

test('слишком длинное сообщение не принимается, короткое считается в байтах', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  // случайные буквы почти не сжимаются: 400 символов ≈ 300+ байт даже после deflate
  const random = Array.from(crypto.getRandomValues(new Uint8Array(400)), b => String.fromCharCode(0x410 + (b % 64))).join('');
  await assert.rejects(A.m.send(B.m.kid, random), /Слишком длинно/);
  assert.equal(A.m.outbox.length, 0);
  assert.equal(await A.m.measure('ок'), 4);
  net.dispose();
});

test('контакты: свой код добавить нельзя, повторное добавление обновляет', async () => {
  const net = fastNet();
  const [A, B] = await pair(net);
  await assert.rejects(A.m.addContact(A.m.contactCode), /собственный/);
  await A.m.addContact(B.m.contactCode, 'Ерлан (брат)');
  assert.equal(A.m.contacts.length, 1);
  assert.equal(A.m.contact(B.m.kid).name, 'Ерлан (брат)');
  net.dispose();
});

test('отмена сообщения из очереди', async () => {
  const net = fastNet();
  const [A, B] = await pair(net, { sky: 'blocked' });
  const msg = await A.m.send(B.m.kid, 'передумал');
  assert.ok(A.m.cancel(msg.id));
  assert.equal(msg.status, STATUS.CANCELED);
  assert.equal(A.m.outbox.length, 0);
  net.dispose();
});

test('всё сохраняется: после перезапуска тот же ключ, контакты и очередь', async () => {
  const net = fastNet();
  const storage = new MemoryStorage();
  const [A, B] = await pair(net, { storage, sky: 'blocked' });
  await A.m.send(B.m.kid, 'переживёт перезапуск');
  const restarted = await new Messenger({ modem: A.modem, storage }).init();
  assert.equal(restarted.kid, A.m.kid);
  assert.equal(restarted.serial, '0204511');
  assert.equal(restarted.contacts.length, 1);
  assert.equal(restarted.outbox.length, 1);
  assert.equal(restarted.conversation(B.m.kid)[0].text, 'переживёт перезапуск');
  net.dispose();
});

test('без подтверждений: статус остаётся «отправлено», ACK не тратит трафик', async () => {
  const net = fastNet();
  const [A, B] = await pair(net, {}, { receipts: false });
  const msg = await A.m.send(B.m.kid, 'без ответа');
  await A.m.sync();
  await waitFor(() => inMsgs(B.m, 'без ответа').length === 1, 2000);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(msg.status, STATUS.SENT);
  assert.equal(B.m.outbox.length, 0);
  net.dispose();
});

test('Messenger без профиля требует имя и серийный номер', async () => {
  await assert.rejects(new Messenger().init({}), /имя/);
  await assert.rejects(new Messenger().init({ name: 'X', serial: 'abc' }), /7 цифр/);
  assert.equal(Messenger.hasProfile(new MemoryStorage()), false);
});

test('ни одного сетевого запроса: всё идёт только через модем', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...a) => { calls++; return realFetch(...a); };
  try {
    const net = fastNet();
    const [A, B] = await pair(net);
    const msg = await A.m.send(B.m.kid, 'без интернета');
    await A.m.sync();
    await waitFor(() => msg.status === STATUS.DELIVERED, 2000);
    net.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
});
