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
export const TYPE = { TEXT: 1, ACK: 2 };
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
