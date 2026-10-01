import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/protocol.js';
import { Messenger, MemoryStorage, STATUS } from '../src/messenger.js';
import { unb64u, te } from '../src/util.js';
import { fastNet, device, waitFor } from './helpers.js';

// Двое незнакомых людей: знают только номера модемов друг друга.
async function strangers(net, a = {}, b = {}) {
  const A = await device(net, { name: 'Алия', serial: '0204511', ...a });
  const B = await device(net, { name: 'Дана', serial: '0204513', ...b });
  return [A, B];
}

const NAME_OFFSET = P.HEADER_LEN + 70;

/* ---------- протокол ---------- */

test('запрос в контакты: туда и обратно, умещается в SBD', async () => {
  const id = await P.createIdentity();
  const longName = 'Александра-Магдалена Константинопольская';
  const pkt = await P.buildRequest({ msgId: P.newMsgId(), identity: id, serial: '204511', name: longName, ts: 1 });
  assert.ok(pkt.length + P.RB_PREFIX_LEN <= P.MO_MAX && pkt.length <= P.MT_MAX);
  const p = await P.parseIntro(pkt);
  assert.equal(p.type, P.TYPE.REQUEST);
  assert.equal(p.serial, '0204511');
  assert.deepEqual(p.pub, id.pub);
  assert.ok(te.encode(p.name).length <= P.NAME_MAX_BYTES);
  assert.ok(longName.startsWith(p.name), 'имя обрезано по границе символа');
});

test('запрос с чужим ключом (senderKid ≠ hash(pub)) отклоняется', async () => {
  const a = await P.createIdentity(), b = await P.createIdentity();
  const pkt = await P.buildRequest({ msgId: P.newMsgId(), identity: a, serial: '1', name: 'A', ts: 1 });
  pkt.set(b.kid, 10);
  await assert.rejects(P.parseIntro(pkt), /Ключ не совпадает/);
});

test('ответ на запрос читает только автор запроса и только без подмены', async () => {
  const a = await P.createIdentity(), b = await P.createIdentity(), eve = await P.createIdentity();
  const requestId = P.newMsgId();
  const pkt = await P.buildAccept({ msgId: P.newMsgId(), identity: b, serial: '2', name: 'B', ts: 1, requestId, key: await P.deriveSessionKey(b, a.pub) });
  assert.ok(pkt.length <= P.PACKET_MAX);
  const p = await P.parseIntro(pkt);
  assert.deepEqual(await P.openAccept(await P.deriveSessionKey(a, p.pub), p), requestId);
  await assert.rejects(P.openAccept(await P.deriveSessionKey(eve, p.pub), p), /проверку/);
  const bad = pkt.slice(); bad[NAME_OFFSET] ^= 1; // подменили имя
  await assert.rejects(P.openAccept(await P.deriveSessionKey(a, b.pub), await P.parseIntro(bad)), /проверку/);
});

test('номер безопасности одинаковый у обоих и разный у разных пар', async () => {
  const a = await P.createIdentity(), b = await P.createIdentity(), c = await P.createIdentity();
  const ab = await P.safetyNumber(a.pub, b.pub);
  assert.match(ab, /^\d{5} \d{5} \d{5} \d{5}$/);
  assert.equal(ab, await P.safetyNumber(b.pub, a.pub));
  assert.notEqual(ab, await P.safetyNumber(a.pub, c.pub));
});

/* ---------- мессенджер через симулятор ---------- */

test('добавление по номеру через спутник: запрос → принять → оба в контактах → переписка ✓✓', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net);
  const requests = [];
  B.m.on('request', r => requests.push(r));

  const invite = await A.m.requestContact('204513');
  assert.equal(invite.status, STATUS.QUEUED);
  await A.m.sync();
  assert.equal(A.m.invites[0].status, STATUS.SENT);

  await waitFor(() => B.m.requests.length === 1, 2000, 'запрос дошёл');
  assert.equal(requests.length, 1);
  const r = B.m.requests[0];
  assert.equal(r.name, 'Алия');
  assert.equal(r.serial, '0204511');
  assert.equal(B.m.contacts.length, 0, 'без согласия контакт не добавляется');

  const contact = await B.m.acceptRequest(r.id);
  assert.equal(contact.name, 'Алия');
  assert.equal(B.m.requests.length, 0);
  await B.m.sync();

  await waitFor(() => A.m.contacts.length === 1, 2000, 'A получил ответ');
  assert.equal(A.m.contacts[0].name, 'Дана');
  assert.equal(A.m.contacts[0].serial, '0204513');
  assert.equal(A.m.invites.length, 0);
  assert.equal(A.m.contacts[0].safety, B.m.contacts[0].safety, 'номера безопасности совпадают');

  const msg = await A.m.send(B.m.kid, 'Привет, Дана!');
  await A.m.sync();
  await waitFor(() => msg.status === STATUS.DELIVERED, 2000, '✓✓');
  assert.equal(B.m.messages.find(m => m.dir === 'in').text, 'Привет, Дана!');
  net.dispose();
});

test('отклонённый запрос: контакт не появляется и ничего не уходит в эфир', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net);
  await A.m.requestContact('0204513');
  await A.m.sync();
  await waitFor(() => B.m.requests.length === 1, 2000);
  const moBefore = net.stats.mo;
  B.m.declineRequest(B.m.requests[0].id);
  await B.m.sync();
  assert.equal(B.m.contacts.length, 0);
  assert.equal(B.m.outbox.length, 0);
  assert.equal(net.stats.mo, moBefore, 'отказ не тратит кредиты');
  assert.equal(A.m.contacts.length, 0);
  net.dispose();
});

test('встречные запросы: оба добавили друг друга — контакт появляется сразу', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net, {}, { sky: 'blocked' });
  await A.m.requestContact('0204513');
  await A.m.sync();
  await waitFor(() => net.queued('0204513') === 1, 1000);
  await B.m.requestContact('0204511'); // B ещё не видел запрос A
  B.fake.sky = 'open';
  await B.m.sync();
  await waitFor(() => A.m.contacts.length === 1 && B.m.contacts.length === 1, 3000, 'оба в контактах');
  assert.equal(A.m.requests.length + B.m.requests.length, 0);
  assert.equal(A.m.invites.length + B.m.invites.length, 0);
  net.dispose();
});

test('если у нас уже есть входящий запрос с этого номера, «добавить» = принять', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net);
  await A.m.requestContact('0204513');
  await A.m.sync();
  await waitFor(() => B.m.requests.length === 1, 2000);
  const c = await B.m.requestContact('0204511');
  assert.equal(c.name, 'Алия');
  assert.equal(B.m.invites.length, 0);
  net.dispose();
});

test('ответ без нашего запроса не добавляет контакт (никто не влезет в контакты сам)', async () => {
  const net = fastNet();
  const [A] = await strangers(net);
  const eve = await P.createIdentity();
  const pkt = await P.buildAccept({
    msgId: P.newMsgId(), identity: eve, serial: '6666666', name: 'Ева', ts: 1,
    requestId: P.newMsgId(), key: await P.deriveSessionKey(eve, A.m.identity.pub),
  });
  const r = await A.m.receive(pkt);
  assert.match(r.rejected, /не отправляли/);
  assert.equal(A.m.contacts.length, 0);
  net.dispose();
});

test('подделанный ответ на настоящий запрос отклоняется', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net, {}, { sky: 'blocked' });
  await A.m.requestContact('0204513');
  const ref = unb64u(A.m.outbox[0].packet).slice(2, 10);
  const real = await P.buildAccept({ msgId: P.newMsgId(), identity: B.m.identity, serial: '0204513', name: 'Дана', ts: 1, requestId: ref, key: await P.deriveSessionKey(B.m.identity, A.m.identity.pub) });
  const forged = real.slice();
  forged[forged.length - 1] ^= 1;
  assert.match((await A.m.receive(forged)).rejected, /проверку/);
  assert.equal(A.m.contacts.length, 0);
  assert.ok((await A.m.receive(real)).contact, 'настоящий ответ проходит');
  net.dispose();
});

test('повторный запрос показывается один раз', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net);
  await A.m.requestContact('0204513');
  const pkt = unb64u(A.m.outbox[0].packet);
  await B.m.receive(pkt);
  assert.ok((await B.m.receive(pkt)).duplicate);
  assert.equal(B.m.requests.length, 1);
  net.dispose();
});

test('запрос от того, кто уже в контактах, принимается автоматически', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net);
  await A.m.addContact(B.m.contactCode);
  await B.m.addContact(A.m.contactCode);
  A.m.contacts = []; // A потерял контакты и снова просит добавить
  await A.m.requestContact('0204513');
  await A.m.sync();
  await waitFor(() => A.m.contacts.length === 1, 2000);
  assert.equal(B.m.requests.length, 0, 'B не пришлось ничего нажимать');
  net.dispose();
});

test('ошибки ввода: свой номер, уже в контактах, повторный запрос, неверный номер', async () => {
  const net = fastNet();
  const [A, B] = await strangers(net);
  await assert.rejects(A.m.requestContact('0204511'), /вашего модема/);
  await assert.rejects(A.m.requestContact('12345678'), /7 цифр/);
  await A.m.requestContact('0204513');
  await assert.rejects(A.m.requestContact('204513'), /уже отправлен/);
  A.m.cancelInvite(A.m.invites[0].id);
  assert.equal(A.m.outbox.length, 0, 'отменённый запрос не уйдёт');
  await A.m.addContact(B.m.contactCode);
  await assert.rejects(A.m.requestContact('0204513'), /уже в контактах/);
  net.dispose();
});

test('запросы и приглашения переживают перезапуск', async () => {
  const net = fastNet();
  const sa = new MemoryStorage(), sb = new MemoryStorage();
  const [A, B] = await strangers(net, { storage: sa, sky: 'blocked' }, { storage: sb });
  await A.m.requestContact('0204513');
  await B.m.receive(unb64u(A.m.outbox[0].packet));
  const A2 = await new Messenger({ modem: A.modem, storage: sa }).init();
  const B2 = await new Messenger({ modem: B.modem, storage: sb }).init();
  assert.equal(A2.invites.length, 1);
  assert.equal(A2.outbox[0].kind, 'request');
  assert.equal(B2.requests.length, 1);
  assert.equal(B2.requests[0].name, 'Алия');
  net.dispose();
});
