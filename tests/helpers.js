import { SimIridium } from '../src/sim.js';
import { SbdModem } from '../src/sbd.js';
import { Messenger, MemoryStorage } from '../src/messenger.js';

export async function waitFor(fn, ms = 3000, label = 'условие') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Не дождались: ${label}`);
}

// Детерминированный ГСЧ, чтобы тесты не зависели от случая.
export function seededRng(seed = 42) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fastNet(opts = {}) {
  return new SimIridium({ sessionMs: [5, 15], gatewayMs: [2, 6], ringDelayMs: [1, 4], failRate: 0, rng: seededRng(), ...opts });
}

export async function device(net, { name, serial, sky = 'open', storage = new MemoryStorage(), receipts = true }) {
  const fake = net.createModem({ serial, sky });
  const modem = new SbdModem(fake, { timeoutMs: 1000, sessionTimeoutMs: 2000 });
  await modem.init();
  const m = new Messenger({ modem, storage, receipts, retryBaseMs: 50, retryMaxMs: 200 });
  await m.init({ name, serial });
  return { fake, modem, m, storage };
}

export async function pair(net, a = {}, b = {}) {
  const A = await device(net, { name: 'Алия', serial: '0204511', ...a });
  const B = await device(net, { name: 'Ерлан', serial: '0204512', ...b });
  await A.m.addContact(B.m.contactCode);
  await B.m.addContact(A.m.contactCode);
  return [A, B];
}
