'use strict';
// js/standalone-net.js runs inside a sandbox that looks like the app's WebView (origin https://localhost, no server,
// no service worker). The page's real fetch is replaced by a fake network so every request can be observed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const LD = require('../js/local-data.js');
const PC = require('../js/prayer-calc.js');
const { buildFixtureDataset, ROOT } = require('./helpers/quran-fixture.js');

const ds = buildFixtureDataset();
const SRC = fs.readFileSync(path.join(ROOT, 'js/standalone-net.js'), 'utf8');
const API = 'https://api.alquran.cloud/v1';
const SITE = 'https://quranbangla.vercel.app';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

function makeApp({ standalone, network, dataDir = ds.dir, withLocal = true, withCalc = true, onLine = true } = {}) {
  const ls = new Map();
  const cacheStore = new Map();
  const calls = [];
  const fakeCache = (name) => {
    const m = cacheStore.get(name) || new Map();
    cacheStore.set(name, m);
    const key = (k) => (typeof k === 'string' ? k : k.url);
    return {
      put: async (k, res) => { m.set(key(k), { status: res.status, body: await res.text(), headers: [...res.headers] }); },
      match: async (k) => { const v = m.get(key(k)); return v ? new Response(v.body, { status: v.status, headers: v.headers }) : undefined; },
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (k) => m.delete(key(k))
    };
  };
  const win = {
    location: new URL('https://localhost/index.html'),
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
    crypto: globalThis.crypto,
    navigator: { serviceWorker: {}, onLine },
    dispatchEvent() {},
    caches: { open: async (n) => fakeCache(n) },
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init && init.method) || (input && input.method) || 'GET';
      calls.push({ url, method });
      if (url.startsWith('data/quran/')) {            // the bundled files, read from the APK
        const f = path.join(dataDir, url.slice('data/quran/'.length));
        if (!fs.existsSync(f)) return new Response('', { status: 404 });
        return new Response(fs.readFileSync(f));
      }
      return network(url, method, input, init);
    }
  };
  win.window = win;
  if (standalone) win.QR_STANDALONE = standalone;
  if (withLocal) win.QR_LOCAL_DATA = LD;
  if (withCalc) win.QR_PRAYER_CALC = PC;
  const original = win.fetch;
  const ctx = vm.createContext({ window: win, Response, Request, URL, TextDecoder, console, setTimeout, clearTimeout, CustomEvent: class CustomEvent {} });
  vm.runInContext(SRC, ctx);
  const netCalls = () => calls.filter((c) => !c.url.startsWith('data/quran/'));
  return { win, calls, netCalls, original, ls, cacheStore };
}
const STANDALONE = { siteUrl: SITE, dataBase: 'data/quran/', bundleId: 'test' };
const offline = () => { throw new TypeError('Failed to fetch'); };

test('the website is never affected: without window.QR_STANDALONE nothing is wrapped', () => {
  const app = makeApp({ network: offline });
  assert.equal(app.win.fetch, app.original);
  assert.equal(app.win.QR_LOCAL, undefined);
  assert.equal(typeof app.win.navigator.serviceWorker.register, 'undefined');
});

test('relative /api calls go to the hosted backend, method, body and query preserved', async () => {
  const app = makeApp({ standalone: STANDALONE, network: () => json({ ok: true }) });
  await app.win.fetch('/api/ai-tafsir', { method: 'POST', body: '{}' });
  await app.win.fetch('/api/story-admin?x=1', { method: 'POST', headers: { Authorization: 'Bearer t' } });
  await app.win.fetch(new Request('https://localhost/api/story-submit', { method: 'POST', body: 'x' }));
  assert.deepEqual(app.netCalls().map((c) => c.url + ' ' + c.method), [
    SITE + '/api/ai-tafsir POST', SITE + '/api/story-admin?x=1 POST', SITE + '/api/story-submit POST'
  ]);
  const none = makeApp({ standalone: { ...STANDALONE, siteUrl: SITE + '/' }, network: () => json({}) });
  await none.win.fetch('/api/x');
  assert.equal(none.netCalls()[0].url, SITE + '/api/x', 'a trailing slash in siteUrl does not double up');
});

test('other same-origin and cross-origin POST/PUT requests pass through untouched', async () => {
  const app = makeApp({ standalone: STANDALONE, network: () => json({ ok: 1 }) });
  await app.win.fetch('https://firestore.googleapis.com/x', { method: 'POST', body: '1' });
  await app.win.fetch('js/app.js');
  assert.deepEqual(app.netCalls().map((c) => c.url), ['https://firestore.googleapis.com/x', 'js/app.js']);
});

test('bundled Quran requests are answered locally - the network is never asked', async () => {
  const app = makeApp({ standalone: STANDALONE, network: offline });
  const r = await app.win.fetch(API + '/surah/2/bn.bengali');
  const body = await r.json();
  assert.equal(body.data.ayahs.length, 286);
  assert.equal(r.headers.get('x-qr-source'), 'bundled');
  assert.equal((await (await app.win.fetch(API + '/surah')).json()).data.length, 114);
  assert.equal((await (await app.win.fetch(API + '/search/fixture/1/en.sahih')).json()).data.count, 7);
  assert.deepEqual(app.netCalls(), [], 'no request left the app');
  assert.equal(app.win.QR_LOCAL.describe().status, 'ready');
});

test('a translation that is not bundled: network first, remembered, served from memory when offline', async () => {
  let online = true;
  const app = makeApp({ standalone: STANDALONE, network: (url) => { if (!online) throw new TypeError('Failed to fetch'); return json({ code: 200, data: { from: 'network', url } }); } });
  const url = API + '/surah/1/ur.jalandhry';
  assert.equal((await (await app.win.fetch(url)).json()).data.from, 'network');
  await new Promise((r) => setTimeout(r, 20));
  online = false;
  assert.equal((await (await app.win.fetch(url)).json()).data.from, 'network', 'second answer comes from the remembered copy');
  await assert.rejects(app.win.fetch(API + '/surah/2/ur.jalandhry'), /Failed to fetch/, 'never seen + offline = the original error (the app shows its offline message)');
});

test('prayer-time and hadith APIs are cached the same way (network first)', async () => {
  let n = 0, online = true;
  const app = makeApp({ standalone: STANDALONE, network: () => { if (!online) throw new TypeError('Failed to fetch'); return json({ call: ++n }); } });
  // timingsByCity cannot be calculated on the device (it needs a city database), so it keeps the plain cache behaviour;
  // the calculable timings/gToH requests have their own tests below
  const prayer = 'https://api.aladhan.com/v1/timingsByCity?city=Dhaka&country=Bangladesh&method=1';
  const hadith = 'https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/info.json';
  assert.equal((await (await app.win.fetch(prayer)).json()).call, 1);
  assert.equal((await (await app.win.fetch(prayer)).json()).call, 2, 'online: always fresh');
  await app.win.fetch(hadith);
  await new Promise((r) => setTimeout(r, 20));
  online = false;
  assert.equal((await (await app.win.fetch(prayer)).json()).call, 2, 'offline: the last good answer');
  assert.ok((await (await app.win.fetch(hadith)).ok));
});

test('error responses are not remembered', async () => {
  let ok = false;
  const app = makeApp({ standalone: STANDALONE, network: () => (ok ? json({ fine: 1 }) : json({ err: 1 }, 500)) });
  const u = 'https://api.aladhan.com/v1/timings?x=1';
  assert.equal((await app.win.fetch(u)).status, 500);
  await new Promise((r) => setTimeout(r, 20));
  const fail = makeApp({ standalone: STANDALONE, network: offline });
  await assert.rejects(fail.win.fetch(u));
  assert.equal([...(app.cacheStore.get('qr-api-standalone-v1') || new Map()).keys()].length, 0);
});

test('translation list: real list online, remembered list offline, bundled editions on a first offline start', async () => {
  const real = { code: 200, status: 'OK', data: [{ identifier: 'bn.bengali' }, { identifier: 'ur.jalandhry' }, { identifier: 'hi.hindi' }] };
  let online = true;
  const app = makeApp({ standalone: STANDALONE, network: () => { if (!online) throw new TypeError('Failed to fetch'); return json(real); } });
  const url = API + '/edition?format=text&type=translation';
  assert.equal((await (await app.win.fetch(url)).json()).data.length, 3);
  await new Promise((r) => setTimeout(r, 20));
  online = false;
  const again = await (await app.win.fetch(url)).json();
  assert.equal(again.data.length, 3, 'the remembered REAL list - not the shorter bundled one');
  const fresh = makeApp({ standalone: STANDALONE, network: offline });
  const bundled = await (await fresh.win.fetch(url)).json();
  assert.deepEqual(bundled.data.map((x) => x.identifier).sort(), ['bn.bengali', 'en.sahih'], 'first start, offline: the picker still has the bundled translations');
});

test('a damaged bundled file falls back to the network for that edition only', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-net-'));
  fs.cpSync(ds.dir, tmp, { recursive: true });
  const f = path.join(tmp, 'text', 'en.sahih.json');
  const arr = JSON.parse(fs.readFileSync(f, 'utf8')); arr[3] = 'tampered'; fs.writeFileSync(f, JSON.stringify(arr));
  const app = makeApp({ standalone: STANDALONE, dataDir: tmp, network: () => json({ code: 200, data: { from: 'network' } }) });
  assert.equal((await (await app.win.fetch(API + '/surah/1/en.sahih')).json()).data.from, 'network');
  assert.equal((await (await app.win.fetch(API + '/surah/1/bn.bengali')).json()).data.ayahs.length, 7);
});

test('no bundled data at all (damaged install): everything still works through the network', async () => {
  const app = makeApp({ standalone: STANDALONE, dataDir: path.join(os.tmpdir(), 'qr-nothing-' + Date.now()), network: () => json({ code: 200, data: { from: 'network' } }) });
  assert.equal((await (await app.win.fetch(API + '/surah/1/bn.bengali')).json()).data.from, 'network');
  assert.equal(app.win.QR_LOCAL.describe().status, 'unavailable');
});

test('the service worker is not used inside the app (its files come from the APK)', async () => {
  const app = makeApp({ standalone: STANDALONE, network: offline });
  await assert.rejects(app.win.navigator.serviceWorker.register('sw.js'), /not used in the standalone app/);
});

// ---------------------------------------------------------------------------------------------- prayer times / Hijri date
const TIMINGS = 'https://api.aladhan.com/v1/timings?latitude=23.8103&longitude=90.4125&method=1';
const aladhan = (tag) => json({ code: 200, status: 'OK', data: { timings: { Fajr: '04:00', Sunrise: '05:00', Dhuhr: '12:00', Asr: '15:00', Maghrib: '18:00', Isha: '19:00' }, from: tag } });
const todayParts = () => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() + 1, day: n.getDate() }; };
const expectedToday = (extra = {}) => {
  const d = todayParts();
  const tz = -new Date(d.year, d.month - 1, d.day, 12).getTimezoneOffset() / 60;
  return PC.toAladhanResponse({ ...d, latitude: 23.8103, longitude: 90.4125, timezone: tz, method: 1, ...extra }).data.timings;
};

test('prayer times: Al-Adhan answers first, exactly as on the website', async () => {
  const app = makeApp({ standalone: STANDALONE, network: () => aladhan('network') });
  const body = await (await app.win.fetch(TIMINGS)).json();
  assert.equal(body.data.from, 'network');
  assert.equal(app.netCalls().length, 1);
});

test('prayer times offline: calculated on the device, in the shape the app reads', async () => {
  const app = makeApp({ standalone: STANDALONE, network: offline });
  const r = await app.win.fetch(TIMINGS);
  assert.equal(r.headers.get('x-qr-source'), 'calculated');
  const body = await r.json();
  for (const k of ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']) assert.match(body.data.timings[k], /^\d\d:\d\d$/, k);
  assert.deepEqual(body.data.timings, expectedToday());
  assert.equal(body.data.meta.offline, true);
});

test('navigator.onLine === false: the network is not even tried', async () => {
  const app = makeApp({ standalone: STANDALONE, onLine: false, network: () => { throw new Error('must not be called'); } });
  assert.equal((await (await app.win.fetch(TIMINGS)).json()).data.meta.method.id, 1);
  assert.deepEqual(app.netCalls(), []);
});

test('a slow Al-Adhan (no answer in time) does not keep the screen waiting: calculated instead', async () => {
  const app = makeApp({ standalone: { ...STANDALONE, calcTimeoutMs: 30 }, network: () => new Promise(() => {}) });
  const t0 = Date.now();
  const body = await (await app.win.fetch(TIMINGS)).json();
  assert.ok(Date.now() - t0 < 1500, 'answered quickly');
  assert.equal(body.data.meta.offline, true);
});

test('"today" is calculated, not taken from a remembered answer that may be yesterday\'s', async () => {
  let online = true;
  const app = makeApp({ standalone: STANDALONE, network: () => { if (!online) throw new TypeError('Failed to fetch'); return aladhan('network'); } });
  await app.win.fetch(TIMINGS);                       // remembered
  await new Promise((r) => setTimeout(r, 20));
  online = false;
  const body = await (await app.win.fetch(TIMINGS)).json();
  assert.equal(body.data.from, undefined, 'not the remembered copy');
  assert.deepEqual(body.data.timings, expectedToday());
});

test('a given date is calculated for that date; the Hanafi school (school=1) is passed on', async () => {
  const app = makeApp({ standalone: STANDALONE, network: offline });
  const feb = await (await app.win.fetch('https://api.aladhan.com/v1/timings/20-02-2026?latitude=21.4225&longitude=39.8262&method=4')).json();
  assert.equal(feb.data.date.gregorian.date, '20-02-2026');
  assert.equal(feb.data.date.hijri.month.number, 9, 'Ramadan 1447');
  assert.equal(feb.data.meta.method.params.Isha, '120 min');
  const std = await (await app.win.fetch(TIMINGS)).json();
  const han = await (await app.win.fetch(TIMINGS + '&school=1')).json();
  const mins = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  assert.ok(mins(han.data.timings.Asr) - mins(std.data.timings.Asr) >= 30, 'Hanafi Asr is later');
  assert.equal(han.data.meta.school, 'HANAFI');
});

test('a method the calculator does not know is never guessed: remembered answer if there is one, else the original error', async () => {
  const url = TIMINGS.replace('method=1', 'method=15');
  const fresh = makeApp({ standalone: STANDALONE, network: offline });
  await assert.rejects(fresh.win.fetch(url), /Failed to fetch/);
  let online = true;
  const app = makeApp({ standalone: STANDALONE, network: () => { if (!online) throw new TypeError('Failed to fetch'); return aladhan('network'); } });
  await app.win.fetch(url);
  await new Promise((r) => setTimeout(r, 20));
  online = false;
  assert.equal((await (await app.win.fetch(url)).json()).data.from, 'network');
});

test('Hijri date (js/ramadan.js): Al-Adhan, then the remembered answer, then calculated', async () => {
  const url = 'https://api.aladhan.com/v1/gToH/16-11-2026';
  const fresh = makeApp({ standalone: STANDALONE, network: offline });
  const calc = await (await fresh.win.fetch(url)).json();
  assert.equal(calc.data.hijri.month.number, 6); assert.equal(calc.data.hijri.year, '1448');
  let online = true;
  const app = makeApp({ standalone: STANDALONE, network: () => { if (!online) throw new TypeError('Failed to fetch'); return json({ code: 200, data: { hijri: { month: { number: 99 } } } }); } });
  await app.win.fetch(url);
  await new Promise((r) => setTimeout(r, 20));
  online = false;
  assert.equal((await (await app.win.fetch(url)).json()).data.hijri.month.number, 99, 'the remembered answer of that exact date wins over the calculation');
});

test('what cannot be calculated stays a network matter: timingsByCity offline without a remembered answer fails as before', async () => {
  const app = makeApp({ standalone: STANDALONE, network: offline });
  await assert.rejects(app.win.fetch('https://api.aladhan.com/v1/timingsByCity?city=Dhaka&country=Bangladesh&method=1'), /Failed to fetch/);
  await assert.rejects(app.win.fetch('https://api.aladhan.com/v1/timings?latitude=abc&longitude=90&method=1'), /Failed to fetch/);
  await assert.rejects(app.win.fetch('https://api.aladhan.com/v1/gToH/32-13-2026x'), /Failed to fetch/);
});

test('without the calculator file the behaviour is the plain cache one (nothing breaks)', async () => {
  const app = makeApp({ standalone: STANDALONE, withCalc: false, network: offline });
  await assert.rejects(app.win.fetch(TIMINGS), /Failed to fetch/);
});
