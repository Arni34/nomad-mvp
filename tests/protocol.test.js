import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/protocol.js';
import { te } from '../src/util.js';

async function keys() {
  const a = await P.createIdentity();
  const b = await P.createIdentity();
  return { a, b, ab: await P.deriveSessionKey(a, b.pub), ba: await P.deriveSessionKey(b, a.pub) };
}

async function textPacket(key, sender, text = 'Привет со спутника') {
  const { flags, body } = await P.encodeText(text);
  return P.seal({ key, type: P.TYPE.TEXT, flags, msgId: P.newMsgId(), senderKid: sender.kid, ts: 1790000000, body });
}

test('пакет укладывается в лимиты Iridium SBD', () => {
  assert.equal(P.PACKET_MAX, 270, 'MT-буфер 9603 — 270 байт');
  assert.ok(P.PACKET_MAX + P.RB_PREFIX_LEN <= P.MO_MAX, 'с адресом RB пакет влезает в 340 байт MO');
  assert.equal(P.BODY_MAX, 270 - 22 - 12 - 16);
});

test('обе стороны выводят один и тот же ключ, получатель расшифровывает', async () => {
  const { a, ab, ba } = await keys();
  const pkt = await textPacket(ab, a);
  const p = P.parsePacket(pkt);
  assert.equal(p.type, P.TYPE.TEXT);
  assert.deepEqual(p.senderKid, a.kid);
  assert.equal(p.ts, 1790000000);
  const body = await P.open(ba, p);
  assert.equal(await P.decodeText(p.flags, body), 'Привет со спутника');
});

test('третья сторона не может прочитать сообщение', async () => {
  const { a, ab } = await keys();
  const eve = await P.createIdentity();
  const eveKey = await P.deriveSessionKey(eve, a.pub);
  const p = P.parsePacket(await textPacket(ab, a));
  await assert.rejects(P.open(eveKey, p), /расшифровать/);
});

test('в эфире нет открытого текста', async () => {
  const { a, ab } = await keys();
  const secret = 'координаты лагеря 43.2389 76.8897';
  const pkt = await textPacket(ab, a, secret);
  const asText = Buffer.from(pkt).toString('latin1');
  assert.ok(!asText.includes('43.2389'));
});

test('подмена заголовка или шифротекста ловится GCM-тегом', async () => {
  const { a, ab, ba } = await keys();
  const pkt = await textPacket(ab, a);
  for (const i of [5, 20, P.HEADER_LEN + P.IV_LEN + 1, pkt.length - 1]) {
    const bad = pkt.slice();
    bad[i] ^= 0x01;
    await assert.rejects(P.open(ba, P.parsePacket(bad)), /расшифровать/, `байт ${i}`);
  }
});

test('мусор и чужие версии отклоняются парсером', () => {
  assert.throws(() => P.parsePacket(new Uint8Array(10)), /короткий/);
  assert.throws(() => P.parsePacket(new Uint8Array(271)), /длинный/);
  const wrongVersion = new Uint8Array(60); wrongVersion[0] = 0x21;
  assert.throws(() => P.parsePacket(wrongVersion), /версия/);
  const wrongType = new Uint8Array(60); wrongType[0] = 0x19;
  assert.throws(() => P.parsePacket(wrongType), /тип/);
});

test('длинное сообщение не помещается и отклоняется до отправки', async () => {
  const { a, ab } = await keys();
  const body = new Uint8Array(P.BODY_MAX + 1);
  await assert.rejects(P.seal({ key: ab, type: P.TYPE.TEXT, msgId: P.newMsgId(), senderKid: a.kid, ts: 0, body }), /Слишком длинно/);
  const max = await P.seal({ key: ab, type: P.TYPE.TEXT, msgId: P.newMsgId(), senderKid: a.kid, ts: 0, body: new Uint8Array(P.BODY_MAX) });
  assert.equal(max.length, P.PACKET_MAX);
});

test('сжатие включается только когда экономит байты', async () => {
  const short = await P.encodeText('ок');
  assert.equal(short.flags, 0);
  const long = 'Всё хорошо, всё хорошо, всё хорошо, всё хорошо, идём к перевалу. '.repeat(3);
  const enc = await P.encodeText(long);
  assert.equal(enc.flags, P.FLAG.DEFLATE);
  assert.ok(enc.body.length < te.encode(long).length / 2);
  assert.equal(await P.decodeText(enc.flags, enc.body), long);
});

test('защита от zip-бомбы: распаковка ограничена', async () => {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(new Uint8Array(200000)); w.close();
  const bomb = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  assert.ok(bomb.length < P.BODY_MAX, 'бомба помещается в пакет');
  await assert.rejects(P.decodeText(P.FLAG.DEFLATE, bomb), /слишком большой/);
});

test('битый UTF-8 и битый deflate отклоняются', async () => {
  await assert.rejects(P.decodeText(0, new Uint8Array([0xff, 0xfe])), /UTF-8/);
  await assert.rejects(P.decodeText(P.FLAG.DEFLATE, new Uint8Array([0xff, 0xff, 0xff])), /распаковать/);
});

test('подтверждение доставки (ACK) шифруется и читается', async () => {
  const { a, ab, ba } = await keys();
  const ref = P.newMsgId();
  const pkt = await P.seal({ key: ab, type: P.TYPE.ACK, msgId: P.newMsgId(), senderKid: a.kid, ts: 1, body: ref });
  assert.ok(pkt.length <= 60, `ACK должен быть маленьким, а он ${pkt.length} байт`);
  const p = P.parsePacket(pkt);
  assert.equal(p.type, P.TYPE.ACK);
  assert.deepEqual(await P.open(ba, p), ref);
});

test('код контакта: туда и обратно, с кириллицей', async () => {
  const id = await P.createIdentity();
  const code = P.makeContactCode({ serial: '0204511', pub: id.pub, name: 'Алия' });
  const c = P.parseContactCode(code);
  assert.equal(c.serial, '0204511');
  assert.equal(c.name, 'Алия');
  assert.deepEqual(c.pub, id.pub);
  assert.equal(P.parseContactCode(code.replace('0204511', '12345')).serial, '0012345');
});

test('испорченный код контакта отклоняется', () => {
  assert.throws(() => P.parseContactCode('hello'), /не код/);
  assert.throws(() => P.parseContactCode('nomad1.abc.AAAA.AAAA'), /серийный/);
  assert.throws(() => P.parseContactCode('nomad1.1234567.AAAA.AAAA'), /повреждён/);
});

test('адрес RockBLOCK: RB + 7 цифр', () => {
  const pkt = new Uint8Array([1, 2, 3]);
  const mo = P.rbAddress('12345', pkt);
  assert.equal(String.fromCharCode(...mo.slice(0, 9)), 'RB0012345');
  assert.deepEqual(P.parseRbAddress(mo), { serial: '0012345', payload: pkt });
  assert.equal(P.parseRbAddress(new Uint8Array([0x52, 0x42, 0x41])), null);
  assert.throws(() => P.rbAddress('12345678', pkt), /7 цифр/);
});

test('личность сохраняется и восстанавливается с тем же ключом', async () => {
  const { a, b, ab } = await keys();
  const restored = await P.importIdentity(JSON.parse(JSON.stringify(await P.exportIdentity(b))));
  assert.deepEqual(restored.kid, b.kid);
  const p = P.parsePacket(await textPacket(ab, a, 'после перезапуска'));
  const key = await P.deriveSessionKey(restored, a.pub);
  assert.equal(await P.decodeText(p.flags, await P.open(key, p)), 'после перезапуска');
});
