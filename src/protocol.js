// Протокол NOMAD поверх Iridium SBD.
//
// Ограничения канала: модем 9602/9603 принимает до 340 байт MO (с устройства)
// и до 270 байт MT (на устройство). Чтобы RockBLOCK переслал сообщение другому
// модему, MO начинается с адреса "RB" + 7 цифр серийного номера (9 байт).
// Поэтому пакет целиком должен помещаться в 270 байт.
//
// Пакет:  [ver|type 1][flags 1][msgId 8][senderKid 8][ts 4] [iv 12] [ciphertext + tag 16]
//          \______________ заголовок, 22 байта, идёт в AAD ______________/
//
// Шифрование: статический ECDH P-256 → HKDF-SHA256 → AES-256-GCM.
// Отдельная подпись не нужна: ключ знают только двое, и успешная проверка
// GCM-тега доказывает, что пакет собрал собеседник и его не меняли по пути.
import { te, td, concat, hex, b64u, unb64u, randomBytes } from './util.js';

export const VERSION = 1;
export const TYPE = { TEXT: 1, ACK: 2, REQUEST: 3, ACCEPT: 4 };
export const FLAG = { DEFLATE: 1 };
export const ID_LEN = 8;
export const KID_LEN = 8;
export const HEADER_LEN = 2 + ID_LEN + KID_LEN + 4;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const MO_MAX = 340;
export const MT_MAX = 270;
export const RB_PREFIX_LEN = 9;
export const PACKET_MAX = Math.min(MT_MAX, MO_MAX - RB_PREFIX_LEN);
export const OVERHEAD = HEADER_LEN + IV_LEN + TAG_LEN;
export const BODY_MAX = PACKET_MAX - OVERHEAD;
export const INFLATE_LIMIT = 4096;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const HKDF_SALT = te.encode('nomad-sbd-v1');

export class ProtocolError extends Error {}

/* ---------- ключи ---------- */

export async function keyId(pub) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', pub)).slice(0, KID_LEN);
}

export async function importPublicKey(raw) {
  if (raw.length !== 65 || raw[0] !== 4) throw new ProtocolError('Неверный публичный ключ');
  try {
    return await crypto.subtle.importKey('raw', raw, ECDH, true, []);
  } catch {
    throw new ProtocolError('Неверный публичный ключ');
  }
}

export async function createIdentity() {
  const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, pub, kid: await keyId(pub) };
}

export async function exportIdentity(id) {
  return { jwk: await crypto.subtle.exportKey('jwk', id.privateKey), pub: b64u(id.pub) };
}

export async function importIdentity(o) {
  const privateKey = await crypto.subtle.importKey('jwk', o.jwk, ECDH, true, ['deriveBits']);
  const pub = unb64u(o.pub);
  return { privateKey, pub, kid: await keyId(pub) };
}

const cmpBytes = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

export async function deriveSessionKey(identity, peerPub) {
  const peer = await importPublicKey(peerPub);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, identity.privateKey, 256);
  const ikm = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  // info связывает ключ с обоими участниками; порядок канонический, чтобы обе стороны получили одно и то же
  const [a, b] = [identity.kid, await keyId(peerPub)].sort(cmpBytes);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: concat(a, b) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/* ---------- пакеты ---------- */

export const newMsgId = () => randomBytes(ID_LEN);

export function buildHeader({ type, flags = 0, msgId, senderKid, ts }) {
  const h = new Uint8Array(HEADER_LEN);
  h[0] = (VERSION << 4) | type;
  h[1] = flags;
  h.set(msgId, 2);
  h.set(senderKid, 2 + ID_LEN);
  new DataView(h.buffer).setUint32(2 + ID_LEN + KID_LEN, ts >>> 0);
  return h;
}

export async function seal({ key, type, flags = 0, msgId, senderKid, ts, body }) {
  if (body.length > BODY_MAX) throw new ProtocolError(`Слишком длинно: ${body.length} из ${BODY_MAX} байт`);
  const header = buildHeader({ type, flags, msgId, senderKid, ts });
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, body));
  return concat(header, iv, ct);
}

export function parsePacket(bytes) {
  bytes = Uint8Array.from(bytes);
  if (bytes.length < OVERHEAD) throw new ProtocolError('Пакет слишком короткий');
  if (bytes.length > PACKET_MAX) throw new ProtocolError('Пакет слишком длинный');
  const version = bytes[0] >> 4;
  const type = bytes[0] & 15;
  if (version !== VERSION) throw new ProtocolError('Неизвестная версия протокола');
  if (type !== TYPE.TEXT && type !== TYPE.ACK) throw new ProtocolError('Неизвестный тип пакета');
  return {
    version, type,
    flags: bytes[1],
    msgId: bytes.slice(2, 2 + ID_LEN),
    senderKid: bytes.slice(2 + ID_LEN, 2 + ID_LEN + KID_LEN),
    ts: new DataView(bytes.buffer).getUint32(2 + ID_LEN + KID_LEN),
    header: bytes.slice(0, HEADER_LEN),
    iv: bytes.slice(HEADER_LEN, HEADER_LEN + IV_LEN),
    ct: bytes.slice(HEADER_LEN + IV_LEN),
  };
}

export async function open(key, p) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.iv, additionalData: p.header }, key, p.ct));
  } catch {
    throw new ProtocolError('Не удалось расшифровать');
  }
}

/* ---------- текст и сжатие ---------- */

async function deflate(u8) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(u8); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflate(u8, limit) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(u8).catch(() => {});
  w.close().catch(() => {});
  const r = ds.readable.getReader();
  const chunks = [];
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      n += value.length;
      if (n > limit) { r.cancel().catch(() => {}); throw new ProtocolError('Распакованный текст слишком большой'); }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError('Не удалось распаковать текст');
  }
  return concat(...chunks);
}

const hasCompression = () => typeof CompressionStream !== 'undefined';

// Сжимаем, только если это реально экономит байты (а каждый байт через спутник стоит денег).
export async function encodeText(text) {
  const raw = te.encode(text);
  if (raw.length > 24 && hasCompression()) {
    try {
      const z = await deflate(raw);
      if (z.length < raw.length) return { flags: FLAG.DEFLATE, body: z };
    } catch { /* без сжатия */ }
  }
  return { flags: 0, body: raw };
}

export async function decodeText(flags, body) {
  const raw = flags & FLAG.DEFLATE ? await inflate(body, INFLATE_LIMIT) : body;
  try {
    return td.decode(raw);
  } catch {
    throw new ProtocolError('Текст не в UTF-8');
  }
}

/* ---------- код контакта ---------- */
// nomad1.<серийный номер RockBLOCK>.<публичный ключ>.<имя>  — всё base64url, можно переслать любым способом

export function makeContactCode({ serial, pub, name }) {
  return ['nomad1', serial, b64u(pub), b64u(te.encode(name))].join('.');
}

export function parseContactCode(code) {
  const parts = String(code).trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'nomad1') throw new ProtocolError('Это не код контакта NOMAD');
  const [, serial, pubS, nameS] = parts;
  if (!/^\d{1,7}$/.test(serial)) throw new ProtocolError('В коде неверный серийный номер модема');
  let pub, name;
  try {
    pub = unb64u(pubS);
    name = td.decode(unb64u(nameS)).trim().slice(0, 40);
  } catch {
    throw new ProtocolError('Код контакта повреждён');
  }
  if (pub.length !== 65 || pub[0] !== 4) throw new ProtocolError('Код контакта повреждён');
  return { serial: serial.padStart(7, '0'), pub, name };
}

/* ---------- запрос в контакты по спутнику ---------- */
//
// Чтобы добавить друг друга, не обмениваясь кодами заранее, достаточно знать номер модема.
//
// REQUEST: [заголовок 22][pub 65][серийный u32][длина имени 1][имя ≤60]
//   Открытый текст: общего ключа ещё нет. Получатель проверяет, что senderKid = hash(pub).
// ACCEPT:  [заголовок 22][pub 65][серийный u32][длина имени 1][имя ≤60][iv 12][AES-GCM(id запроса) 8+16]
//   Шифруется общим ключом, AAD — всё до iv. Расшифровать может только автор запроса,
//   а успешная проверка тега доказывает, что отвечает владелец pub и именно на этот запрос.

export const NAME_MAX_BYTES = 60;
const INTRO_FIXED = HEADER_LEN + 65 + 4 + 1;

export function clipName(name) {
  let s = String(name).trim();
  while (te.encode(s).length > NAME_MAX_BYTES) s = [...s].slice(0, -1).join('');
  return s;
}

function introHead({ type, msgId, identity, serial, name, ts }) {
  const nameBytes = te.encode(clipName(name));
  const tail = new Uint8Array(5);
  new DataView(tail.buffer).setUint32(0, +normSerial(serial));
  tail[4] = nameBytes.length;
  return concat(buildHeader({ type, msgId, senderKid: identity.kid, ts }), identity.pub, tail, nameBytes);
}

export async function buildRequest({ msgId, identity, serial, name, ts }) {
  return introHead({ type: TYPE.REQUEST, msgId, identity, serial, name, ts });
}

export async function buildAccept({ msgId, identity, serial, name, ts, requestId, key }) {
  const head = introHead({ type: TYPE.ACCEPT, msgId, identity, serial, name, ts });
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: head }, key, requestId));
  return concat(head, iv, ct);
}

export const packetType = bytes => (bytes.length ? bytes[0] & 15 : -1);

export async function parseIntro(bytes) {
  bytes = Uint8Array.from(bytes);
  if (bytes.length < INTRO_FIXED || bytes.length > PACKET_MAX) throw new ProtocolError('Неверный размер запроса');
  if (bytes[0] >> 4 !== VERSION) throw new ProtocolError('Неизвестная версия протокола');
  const type = bytes[0] & 15;
  if (type !== TYPE.REQUEST && type !== TYPE.ACCEPT) throw new ProtocolError('Это не запрос в контакты');
  const dv = new DataView(bytes.buffer);
  const pub = bytes.slice(HEADER_LEN, HEADER_LEN + 65);
  const nameLen = bytes[HEADER_LEN + 69];
  const end = INTRO_FIXED + nameLen;
  if (nameLen > NAME_MAX_BYTES || bytes.length < end) throw new ProtocolError('Неверное имя в запросе');
  const senderKid = bytes.slice(2 + ID_LEN, 2 + ID_LEN + KID_LEN);
  await importPublicKey(pub);
  if (hex(await keyId(pub)) !== hex(senderKid)) throw new ProtocolError('Ключ не совпадает с отправителем');
  let name;
  try { name = td.decode(bytes.slice(INTRO_FIXED, end)).trim(); } catch { throw new ProtocolError('Имя не в UTF-8'); }
  const p = {
    type,
    msgId: bytes.slice(2, 2 + ID_LEN),
    senderKid,
    ts: dv.getUint32(2 + ID_LEN + KID_LEN),
    pub,
    serial: String(dv.getUint32(HEADER_LEN + 65)).padStart(7, '0'),
    name: name || 'Без имени',
  };
  if (type === TYPE.REQUEST) {
    if (bytes.length !== end) throw new ProtocolError('Лишние байты в запросе');
  } else {
    if (bytes.length !== end + IV_LEN + ID_LEN + TAG_LEN) throw new ProtocolError('Неверный размер ответа на запрос');
    p.aad = bytes.slice(0, end);
    p.iv = bytes.slice(end, end + IV_LEN);
    p.ct = bytes.slice(end + IV_LEN);
  }
  return p;
}

// Возвращает id запроса, на который отвечает ACCEPT, или бросает, если ответ подделан.
export async function openAccept(key, p) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: p.iv, additionalData: p.aad }, key, p.ct));
  } catch {
    throw new ProtocolError('Ответ на запрос не прошёл проверку');
  }
}

// «Номер безопасности» пары: одинаковый у обоих собеседников. Сверьте его при встрече или голосом —
// так видно, что ключи по дороге не подменили.
export async function safetyNumber(pubA, pubB) {
  const [a, b] = [pubA, pubB].sort(cmpBytes);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(te.encode('nomad-safety-v1'), a, b)));
  const groups = [];
  for (let i = 0; i < 4; i++) groups.push(String(((h[i * 3] << 16) | (h[i * 3 + 1] << 8) | h[i * 3 + 2]) % 100000).padStart(5, '0'));
  return groups.join(' ');
}

/* ---------- адресация RockBLOCK → RockBLOCK ---------- */

export function normSerial(serial) {
  const s = String(serial).trim().padStart(7, '0');
  if (!/^\d{7}$/.test(s)) throw new ProtocolError('Серийный номер RockBLOCK — до 7 цифр');
  return s;
}

export const rbAddress = (serial, packet) => concat(te.encode('RB' + normSerial(serial)), packet);

export function parseRbAddress(bytes) {
  if (bytes.length < RB_PREFIX_LEN || bytes[0] !== 0x52 || bytes[1] !== 0x42) return null;
  const serial = String.fromCharCode(...bytes.slice(2, RB_PREFIX_LEN));
  if (!/^\d{7}$/.test(serial)) return null;
  return { serial, payload: bytes.slice(RB_PREFIX_LEN) };
}

export const kidHex = kid => hex(kid);
