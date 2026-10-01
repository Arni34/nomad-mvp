// Общие утилиты. Работают одинаково в браузере и в Node (тесты).
export const te = new TextEncoder();
export const td = new TextDecoder('utf-8', { fatal: true });

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
export const unhex = s => Uint8Array.from(String(s).match(/../g) || [], h => parseInt(h, 16));

export function b64u(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));

export const bytesEqual = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Emitter {
  constructor() { this._ls = new Map(); }
  on(type, fn) {
    if (!this._ls.has(type)) this._ls.set(type, new Set());
    this._ls.get(type).add(fn);
    return () => this._ls.get(type).delete(fn);
  }
  emit(type, data) {
    for (const fn of this._ls.get(type) || []) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }
}
