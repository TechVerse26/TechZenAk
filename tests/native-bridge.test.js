'use strict';
// The typed bridge: src/native/quran-native.ts -> js/quran-native.js, its contract with the Kotlin plugin, the client behaviour
// (a fake plugin), the snapshot builder, and js/native-sync.js (the glue that pushes the app state).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const API = require('../js/quran-native.js');
const KT = 'android-build/native/kotlin/com/techverse/quranbangla';

// ------------------------------------------------------------------------------------------------ build + contract
test('js/quran-native.js is exactly what `tsc` makes from src/native/quran-native.ts (strict mode)', (t) => {
  const probe = spawnSync('tsc', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('tsc is not installed here'); return; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-tsc-'));
  const r = spawnSync('tsc', ['-p', path.join(ROOT, 'tsconfig.json'), '--outDir', out], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, 'tsc reported errors:\n' + r.stdout + r.stderr);
  assert.equal(fs.readFileSync(path.join(out, 'quran-native.js'), 'utf8'), read('js/quran-native.js'), 'js/quran-native.js is stale - run: npm run build:ts');
});

test('contract: every method of the TypeScript plugin interface is a @PluginMethod of the Kotlin plugin (and nothing else is)', () => {
  const ts = read('src/native/quran-native.ts');
  const block = /interface QuranNativePlugin \{([\s\S]*?)\n\}/.exec(ts)[1];
  const tsMethods = [...block.matchAll(/^\s*(\w+)\(/gm)].map((m) => m[1]).sort();
  const kotlin = read(KT + '/bridge/QuranNativePlugin.kt');
  const ktMethods = [...kotlin.matchAll(/@PluginMethod[^\n]*\n(?:\s*\/\*\*[\s\S]*?\*\/\s*)?\s*fun\s+(\w+)\(call: PluginCall\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(tsMethods, ktMethods);
  assert.ok(tsMethods.length >= 10, tsMethods.join(','));
  assert.match(kotlin, /@CapacitorPlugin\(name = "QuranNative"\)/);
  assert.ok(read('js/quran-native.js').includes("c.Plugins['QuranNative']") && read('js/quran-native.js').includes("isPluginAvailable('QuranNative')"), 'the client asks for the plugin by the name Kotlin registers');
});

test('contract: the constants of the TypeScript side equal the Kotlin side', () => {
  const rem = read(KT + '/reminders/Reminder.kt');
  const set = (name) => [...rem.match(new RegExp(name + ' = setOf\\(([\\s\\S]*?)\\)'))[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...API.KINDS], set('KINDS'));
  assert.deepEqual([...API.MODES], set('MODES'));
  assert.deepEqual([...API.PRIORITIES], set('PRIORITIES'));
  assert.deepEqual([...API.PRAYER_KEYS], set('PRAYER_KEYS'));
  assert.equal(API.MAX_REMINDERS, +/MAX_REMINDERS = (\d+)/.exec(rem)[1]);
  assert.equal(API.ALL_DAYS, +/ALL_DAYS = (\d+)/.exec(rem)[1]);
  assert.equal(`/${/ID = Regex\("(.*)"\)/.exec(rem)[1]}/`.replace(/\\\\/g, '\\'), String(/^[a-z0-9_.-]{1,48}$/));
  const plugin = read(KT + '/bridge/QuranNativePlugin.kt');
  assert.equal(API.MAX_STATE_CHARS, +/MAX_STATE_CHARS = ([\d_]+)/.exec(plugin)[1].replace(/_/g, ''));
  assert.equal(API.BRIDGE_VERSION, +/BRIDGE_VERSION = (\d+)/.exec(plugin)[1]);
  const widgets = read(KT + '/widgets/WidgetUpdater.kt');
  assert.deepEqual([...API.WIDGET_KEYS], [...widgets.matchAll(/Entry\("(\w+)"/g)].map((m) => m[1]));
  const kotlinMethods = [...read(KT + '/prayer/PrayerCalculator.kt').matchAll(/CalcMethod\((\d+),/g)].map((m) => +m[1]).sort((a, b) => a - b);
  assert.deepEqual([...API.PRAYER_METHODS], kotlinMethods);
  assert.equal(require('../js/prayer-calc.js').METHODS && Object.keys(require('../js/prayer-calc.js').METHODS).map(Number).sort((a, b) => a - b).join(), kotlinMethods.join());
  assert.match(rem, /Deeplinks\.isOurs\(link\)/);
  assert.equal(read(KT + '/core/Deeplinks.kt').match(/SCHEME = "(\w+)"/)[1] + '://', 'quranbangla://');
});

test('contract: the snapshot fields the Kotlin side reads are exactly the ones the TypeScript side writes', () => {
  const snap = API.buildSnapshot({ language: 'bn', lastRead: { surah: 2, ayah: 1 }, prayerLocation: { lat: 1, lon: 2, label: 'x' }, planners: [{ title: 't', days: 5, completedDays: 1 }] });
  const read = (f) => fs.readFileSync(path.join(ROOT, KT, f), 'utf8');
  const kotlinKeys = new Set();
  for (const f of ['widgets/NextPrayerWidget.kt', 'widgets/DailyAyahWidget.kt', 'widgets/ContinueReadingWidget.kt', 'widgets/ReminderStatusWidget.kt', 'prayer/PrayerSchedule.kt', 'widgets/Labels.kt']) {
    for (const m of read(f).matchAll(/(?:stringOrNull|intOrDefault|boolOrDefault|doubleOrNull|objectOrNull|optString)\("(\w+)"/g)) kotlinKeys.add(m[1]);
  }
  const tsKeys = new Set(['language', 'translationEdition', 'lastRead', 'prayer', 'goals', 'v']);
  const collect = (o) => { for (const [k, v] of Object.entries(o)) { tsKeys.add(k); if (v && typeof v === 'object') collect(v); } };
  collect(snap);
  for (const k of ['label', 'method', 'school']) tsKeys.add(k);
  tsKeys.add('lat'); tsKeys.add('lon');
  for (const k of kotlinKeys) assert.ok(tsKeys.has(k), `Kotlin reads "${k}" but the snapshot does not carry it`);
});

// ------------------------------------------------------------------------------------------------ the client
function fakePlugin(overrides = {}) {
  const calls = [];
  const rec = (name, result) => (opts) => { calls.push({ name, opts }); return typeof result === 'function' ? result(opts) : Promise.resolve(result); };
  const plugin = {
    getCapabilities: rec('getCapabilities', { version: 1, sdk: 34, modules: { widgets: true, reminders: true, prayer: true, database: true, downloads: false, audio: false }, exactAlarms: false, notificationsEnabled: true, ignoringBatteryOptimizations: false, quranDataBundled: true, pinWidgetSupported: true, widgetsInstalled: {} }),
    syncState: rec('syncState', { ok: true, widgetsUpdated: 1 }),
    getReminders: rec('getReminders', { reminders: [] }),
    setReminders: rec('setReminders', (o) => Promise.resolve({ scheduled: o.reminders.length, next: [], refused: [], exactAlarms: false })),
    describeSchedule: rec('describeSchedule', { scheduled: 0, next: [], refused: [], exactAlarms: true }),
    refreshWidgets: rec('refreshWidgets', { updated: 3 }),
    requestPinWidget: rec('requestPinWidget', { supported: true, requested: true }),
    openSettings: rec('openSettings', { opened: true }),
    getStorageInfo: rec('getStorageInfo', { appBytes: 1, freeBytes: 2, totalBytes: 3 }),
    getDatabaseInfo: rec('getDatabaseInfo', { version: 1, counts: {} }),
    ...overrides
  };
  return { plugin, calls };
}
function fakeScheduler() {
  const tasks = [];
  return { set: (fn, ms) => { const h = { fn, ms, live: true }; tasks.push(h); return h; }, clear: (h) => { if (h) h.live = false; }, fire: () => { const live = tasks.filter((x) => x.live); live.forEach((x) => { x.live = false; x.fn(); }); return live.length; }, tasks };
}
const SNAP = (n = 1) => API.buildSnapshot({ language: 'bn', lastRead: { surah: 2, ayah: n } });

test('without a native layer (website, safe build) every call answers harmlessly and never throws', async () => {
  const c = new API.QuranNativeClient(() => null);
  assert.equal(c.isAvailable(), false);
  assert.equal(await c.capabilities(), null);
  assert.deepEqual(await c.getReminders(), []);
  assert.equal(await c.describeSchedule(), null);
  assert.equal(await c.refreshWidgets(), 0);
  assert.equal(await c.getStorageInfo(), null);
  assert.equal(await c.getDatabaseInfo(), null);
  assert.deepEqual(await c.requestPinWidget('next_prayer'), { supported: false, requested: false });
  assert.equal(await c.openSettings('battery'), false);
  assert.equal(await c.flush(), false);
  c.syncState(SNAP());
  const r = await c.setReminders(API.defaultCatalog('bn'));
  assert.equal(r.ok, false); assert.equal(r.report, null); assert.equal(r.errors.length, 0);
});

test('capabilities are asked once and remembered; a failing plugin means "no native layer"; refresh asks again', async () => {
  const { plugin, calls } = fakePlugin();
  const c = new API.QuranNativeClient(() => plugin);
  const a = await c.capabilities(); const b = await c.capabilities();
  assert.equal(a, b); assert.equal(calls.filter((x) => x.name === 'getCapabilities').length, 1);
  assert.equal(a.modules.widgets, true);
  await c.refreshCapabilities();
  assert.equal(calls.filter((x) => x.name === 'getCapabilities').length, 2);
  const broken = new API.QuranNativeClient(() => fakePlugin({ getCapabilities: () => Promise.reject(new Error('x')) }).plugin);
  assert.equal(await broken.capabilities(), null);
});

test('syncState: debounced, last snapshot wins, identical snapshots are not sent again, flush is immediate', async () => {
  const { plugin, calls } = fakePlugin();
  const sch = fakeScheduler();
  const c = new API.QuranNativeClient(() => plugin, sch, 800);
  const sent = () => calls.filter((x) => x.name === 'syncState');
  c.syncState(SNAP(1)); c.syncState(SNAP(2)); c.syncState(SNAP(3));
  assert.equal(sent().length, 0, 'nothing is sent inside the debounce window');
  assert.equal(sch.tasks.filter((t) => t.live).length, 1, 'one timer, re-armed on every change');
  assert.equal(sch.tasks[0].ms, 800);
  sch.fire(); await new Promise((r) => setImmediate(r));
  assert.equal(sent().length, 1); assert.equal(sent()[0].opts.state.lastRead.ayah, 3, 'the LAST snapshot');
  c.syncState(SNAP(3)); sch.fire(); await new Promise((r) => setImmediate(r));
  assert.equal(sent().length, 1, 'an unchanged state is not sent again');
  c.syncState(SNAP(4));
  assert.equal(await c.flush(), true, 'flush sends immediately');
  assert.equal(sent().length, 2);
  assert.equal(sch.tasks.filter((t) => t.live).length, 0, 'flush cancels the pending timer');
});

test('syncState: a failed send is retried with the same snapshot next time; an oversized one is never sent', async () => {
  let fail = true;
  const { plugin, calls } = fakePlugin({ syncState: (o) => { calls.push({ name: 'syncState', opts: o }); return fail ? Promise.reject(new Error('busy')) : Promise.resolve({ ok: true, widgetsUpdated: 0 }); } });
  const c = new API.QuranNativeClient(() => plugin, fakeScheduler(), 0);
  c.syncState(SNAP(1));
  assert.equal(await c.flush(), false);
  fail = false;
  c.syncState(SNAP(1));
  assert.equal(await c.flush(), true, 'the same snapshot goes out again because the first send failed');
  assert.equal(calls.filter((x) => x.name === 'syncState').length, 2);
  const big = SNAP(1); big.prayer = { lat: 1, lon: 1, method: 1, school: 0, label: 'x' }; big.language = 'x'.repeat(API.MAX_STATE_CHARS + 1);
  c.syncState(big);
  assert.equal(await c.flush(), false);
  assert.equal(calls.filter((x) => x.name === 'syncState').length, 2, 'too large: not sent');
});

test('setReminders: validated like Kotlin; invalid, duplicate and surplus ones are reported, only valid ones cross the bridge', async () => {
  const { plugin, calls } = fakePlugin();
  const c = new API.QuranNativeClient(() => plugin);
  const cat = API.defaultCatalog('bn');
  const list = [cat[0], { ...cat[1], id: 'Bad Id!' }, { ...cat[2], mode: 'loud' }, cat[0], { ...cat[3], link: 'https://evil.example' }, cat[4]];
  const r = await c.setReminders(list);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.index), [1, 2, 3, 4]);
  assert.match(r.errors[0].message, /id must be/); assert.match(r.errors[1].message, /unknown mode/); assert.equal(r.errors[2].message, 'duplicate id'); assert.match(r.errors[3].message, /quranbangla:\/\//);
  assert.deepEqual(calls.find((x) => x.name === 'setReminders').opts.reminders.map((x) => x.id), [cat[0].id, cat[4].id]);
  assert.equal(r.report.scheduled, 2);
  const many = Array.from({ length: 70 }, (_, i) => ({ ...cat[0], id: 'r' + i }));
  const m = await c.setReminders(many);
  assert.equal(m.errors.length, 6); assert.equal(calls.filter((x) => x.name === 'setReminders').pop().opts.reminders.length, 64);
  const good = await c.setReminders(cat);
  assert.equal(good.ok, true); assert.equal(good.errors.length, 0);
  const down = await new API.QuranNativeClient(() => fakePlugin({ setReminders: () => Promise.reject(new Error('x')) }).plugin).setReminders(cat);
  assert.equal(down.ok, false); assert.equal(down.report, null);
});

test('validateReminder: the accepted and refused shapes', () => {
  const ok = { id: 'a_1', title: 'T' };
  assert.equal(API.validateReminder(ok), null, 'only id and title are required');
  for (const [bad, re] of [[null, /not an object/], [[], /not an object/], [{ title: 'T' }, /id must/], [{ ...ok, id: 'UPPER' }, /id must/], [{ ...ok, id: 'a'.repeat(49) }, /id must/], [{ ...ok, title: '' }, /title/], [{ ...ok, title: 'x'.repeat(121) }, /title/],
    [{ ...ok, body: 'x'.repeat(301) }, /body/], [{ ...ok, kind: 'nope' }, /kind/], [{ ...ok, prayer: 'zuhr' }, /prayer/], [{ ...ok, timeMinutes: 1440 }, /timeMinutes/], [{ ...ok, timeMinutes: 1.5 }, /timeMinutes/],
    [{ ...ok, offsetMinutes: 721 }, /offsetMinutes/], [{ ...ok, days: 0 }, /days/], [{ ...ok, days: 128 }, /days/], [{ ...ok, mode: 'LOUD' }, /mode/], [{ ...ok, priority: 'max' }, /priority/],
    [{ ...ok, link: 'javascript:alert(1)' }, /link/], [{ ...ok, link: 'quranbangla://' + 'x'.repeat(200) }, /link/]]) {
    assert.match(API.validateReminder(bad) || 'accepted', re, JSON.stringify(bad));
  }
  for (const good of [{ ...ok, prayer: null }, { ...ok, prayer: 'lastthird', offsetMinutes: -720 }, { ...ok, timeMinutes: 1439, days: 127 }, { ...ok, link: 'quranbangla://ayah?surah=2&ayah=255' }]) assert.equal(API.validateReminder(good), null, JSON.stringify(good));
});

test('daysMask and the default catalog', () => {
  assert.equal(API.daysMask([0]), 1); assert.equal(API.daysMask([5]), 32); assert.equal(API.daysMask([0, 6]), 65);
  assert.equal(API.daysMask([]), 127, 'no day at all means every day'); assert.equal(API.daysMask([9, -1]), 127);
  for (const lang of ['bn', 'en']) {
    const cat = API.defaultCatalog(lang);
    assert.equal(cat.length, 15);
    assert.equal(new Set(cat.map((r) => r.id)).size, cat.length, 'unique ids');
    for (const r of cat) { assert.equal(API.validateReminder(r), null, r.id); assert.equal(r.enabled, false, r.id + ' is off by default'); assert.ok(r.title && r.body, r.id); }
    assert.deepEqual(cat.filter((r) => r.kind === 'prayer').map((r) => r.prayer), ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
    const jumuah = cat.find((r) => r.id === 'jumuah');
    assert.deepEqual([jumuah.prayer, jumuah.offsetMinutes, jumuah.days], ['dhuhr', -60, 32], 'Friday, an hour before Dhuhr');
    assert.ok(cat.filter((r) => r.ramadanOnly).map((r) => r.id).join() === 'ramadan_suhoor,ramadan_iftar,taraweeh');
    assert.equal(cat.find((r) => r.id === 'tahajjud').prayer, 'lastthird');
  }
  assert.match(API.defaultCatalog('bn')[0].title, /ফজর/); assert.equal(API.defaultCatalog('en')[0].title, 'Fajr');
});

// ------------------------------------------------------------------------------------------------ the snapshot
test('buildSnapshot: a clean app state', () => {
  const s = API.buildSnapshot({
    language: 'en', translationEdition: 'en.sahih', lastRead: { surah: 18, ayah: 10 }, prayerLocation: { lat: 23.8103, lon: 90.4125, label: 'Dhaka' }, prayerMethod: 4,
    ayahsRead: { '1:1': 1, '1:2': 1, '2:255': 1 }, streak: 12, today: '2026-11-18',
    planners: [{ title: 'Done', days: 10, completedDays: 10 }, { title: '৪ মাসে কুরআন', days: 120, completedDays: 30, lastMarkedDate: '2026-11-18' }]
  });
  assert.deepEqual(s, { v: 1, language: 'en', translationEdition: 'en.sahih', lastRead: { surah: 18, ayah: 10 }, prayer: { lat: 23.8103, lon: 90.4125, method: 4, school: 0, label: 'Dhaka' },
    goals: { ayahsRead: 3, streak: 12, plan: { title: '৪ মাসে কুরআন', days: 120, completedDays: 30, markedToday: true } } });
  assert.equal(API.buildSnapshot({ planners: [{ title: 'p', days: 10, completedDays: 10 }] }).goals.plan.title, 'p', 'only finished plans: the first one is shown');
  assert.equal(API.buildSnapshot({ planners: [{ title: 'p', days: 10, completedDays: 3, lastMarkedDate: '2026-11-17' }], today: '2026-11-18' }).goals.plan.markedToday, false);
});

test('buildSnapshot: nothing is guessed - garbage becomes "not set"', () => {
  const empty = API.buildSnapshot({});
  assert.deepEqual(empty, { v: 1, language: 'bn', translationEdition: 'bn.bengali', lastRead: null, prayer: null, goals: { ayahsRead: 0, streak: 0, plan: null } });
  for (const bad of [null, undefined, 5, 'x', [], { surah: 115, ayah: 1 }, { surah: 2, ayah: 0 }, { surah: '2', ayah: 1 }, { surah: 2.5, ayah: 1 }, { surah: 0, ayah: 1 }]) assert.equal(API.buildSnapshot({ lastRead: bad }).lastRead, null, JSON.stringify(bad));
  for (const bad of [null, {}, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: NaN, lon: 0 }, { lat: '23', lon: '90' }, { lat: Infinity, lon: 1 }]) assert.equal(API.buildSnapshot({ prayerLocation: bad }).prayer, null, JSON.stringify(bad));
  assert.equal(API.buildSnapshot({ prayerLocation: { lat: 1, lon: 1 }, prayerMethod: 15 }).prayer.method, 1, 'a method the native calculator does not know falls back to the default');
  assert.equal(API.buildSnapshot({ prayerLocation: { lat: 1, lon: 1 }, prayerMethod: 'x' }).prayer.method, 1);
  assert.equal(API.buildSnapshot({ prayerLocation: { lat: 1, lon: 1 }, prayerSchool: 1 }).prayer.school, 1);
  assert.equal(API.buildSnapshot({ prayerLocation: { lat: 1, lon: 1 }, prayerSchool: 2 }).prayer.school, 0);
  assert.equal(API.buildSnapshot({ prayerLocation: { lat: 1, lon: 1, label: 'x'.repeat(200) } }).prayer.label.length, 60);
  assert.equal(API.buildSnapshot({ translationEdition: '../../etc' }).translationEdition, 'bn.bengali');
  assert.equal(API.buildSnapshot({ translationEdition: 'quran-uthmani' }).translationEdition, 'bn.bengali', 'only translation editions');
  assert.equal(API.buildSnapshot({ ayahsRead: Object.fromEntries(Array.from({ length: 7000 }, (_, i) => [i, 1])) }).goals.ayahsRead, 6236, 'capped at the number of ayahs');
  assert.equal(API.buildSnapshot({ ayahsRead: [1, 2, 3] }).goals.ayahsRead, 0);
  for (const bad of [-1, 1.5, 'x', NaN, 1e9]) assert.equal(API.buildSnapshot({ streak: bad }).goals.streak, 0, String(bad));
  const plans = API.buildSnapshot({ planners: [null, 5, { days: 0, completedDays: 0 }, { days: 10, completedDays: -1 }, { days: 10, completedDays: 99999 }, { title: 'ok', days: 10, completedDays: 4 }] });
  assert.equal(plans.goals.plan.title, 'ok');
  assert.equal(API.buildSnapshot({ planners: 'nope' }).goals.plan, null);
  assert.equal(API.buildSnapshot({ planners: [{ title: 'p'.repeat(100), days: 5, completedDays: 7 }] }).goals.plan.completedDays, 5, 'completed days never exceed the days');
  JSON.stringify(API.buildSnapshot({ language: {}, lastRead: { surah: 2, ayah: 1 } })); // always serialisable
});

test('pluginFromCapacitor: only in the native app, only when the plugin is registered', () => {
  const p = { getCapabilities() {} };
  assert.equal(API.pluginFromCapacitor({}), null);
  assert.equal(API.pluginFromCapacitor({ Capacitor: { isNativePlatform: () => false, Plugins: { QuranNative: p } } }), null, 'a browser');
  assert.equal(API.pluginFromCapacitor({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => false, Plugins: { QuranNative: p } } }), null, 'the safe build: no Kotlin plugin registered');
  assert.equal(API.pluginFromCapacitor({ Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n) => n === 'QuranNative', Plugins: { QuranNative: p } } }), p);
  assert.equal(API.pluginFromCapacitor({ Capacitor: { isNativePlatform: () => true, Plugins: {} } }), null);
});

// ------------------------------------------------------------------------------------------------ js/native-sync.js
function loadSync({ standalone = true, available = true, globals = {} } = {}) {
  const calls = [];
  const timers = [];
  const listeners = {};
  const doc = { visibilityState: 'visible', addEventListener: (n, f) => { (listeners['doc:' + n] ||= []).push(f); } };
  const client = { isAvailable: () => available, syncState: (s) => calls.push(['sync', s]), flush: () => calls.push(['flush']) };
  const win = { document: doc, QR_NATIVE: client, QR_NATIVE_API: API, addEventListener: (n, f) => { (listeners['win:' + n] ||= []).push(f); }, ...globals };
  if (standalone) win.QR_STANDALONE = { siteUrl: 'x' };
  win.window = win;
  const sandbox = { window: win, document: doc, setTimeout: (f, ms) => timers.push({ f, ms, kind: 'timeout' }), setInterval: (f, ms) => timers.push({ f, ms, kind: 'interval' }), Date, Object, Array, JSON, typeof: undefined };
  const stateDecl = globals.__state === undefined ? '' : 'var state = ' + JSON.stringify(globals.__state) + ';';
  delete win.__state;
  vm.runInNewContext(stateDecl + read('js/native-sync.js'), sandbox);
  return { calls, timers, listeners, doc, win };
}
const FIRE = (ctx, key) => (ctx.listeners[key] || []).forEach((f) => f());

test('native-sync: inactive without the standalone bundle', () => {
  const c = loadSync({ standalone: false });
  assert.equal(c.timers.length, 0); assert.deepEqual(Object.keys(c.listeners), []); assert.equal(c.win.QR_NATIVE_SYNC, undefined);
});

test('native-sync: first push after start, a push every 30 s while visible, flush when the app goes to the background', () => {
  const c = loadSync({ globals: { __state: { language: 'bn', lastRead: { surah: 2, ayah: 255 }, prayerLocation: { lat: 23.8, lon: 90.4 }, prayerMethod: 1, ayahsRead: { a: 1 } } } });
  assert.deepEqual(c.timers.map((t) => [t.kind, t.ms]), [['timeout', 3000], ['interval', 30000]]);
  c.timers[0].f();
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0][0], 'sync');
  assert.deepEqual(c.calls[0][1].lastRead, { surah: 2, ayah: 255 }); assert.equal(c.calls[0][1].prayer.lat, 23.8); assert.equal(c.calls[0][1].goals.ayahsRead, 1);
  c.calls.length = 0;
  c.timers[1].f(); assert.deepEqual(c.calls.map((x) => x[0]), ['sync'], 'the 30 s tick does not flush');
  c.calls.length = 0;
  c.doc.visibilityState = 'hidden'; FIRE(c, 'doc:visibilitychange');
  assert.deepEqual(c.calls.map((x) => x[0]), ['sync', 'flush'], 'going to the background flushes at once');
  c.calls.length = 0; c.timers[1].f();
  assert.equal(c.calls.length, 0, 'no tick while hidden');
  c.doc.visibilityState = 'visible'; FIRE(c, 'doc:visibilitychange');
  assert.deepEqual(c.calls.map((x) => x[0]), ['sync'], 'coming back only syncs');
  c.calls.length = 0; FIRE(c, 'win:pagehide');
  assert.deepEqual(c.calls.map((x) => x[0]), ['sync', 'flush']);
});

test('native-sync: reads the streak and the plans from the app functions, and survives missing or throwing ones', () => {
  const c = loadSync({ globals: { __state: { language: 'en' }, computeStreak: () => 9, loadActivity: () => ({}), loadPlanners: () => [{ title: 'P', days: 4, completedDays: 1, lastMarkedDate: '2026-11-18' }], todayStr: () => '2026-11-18' } });
  c.timers[0].f();
  assert.equal(c.calls[0][1].goals.streak, 9); assert.deepEqual(c.calls[0][1].goals.plan, { title: 'P', days: 4, completedDays: 1, markedToday: true });
  const broken = loadSync({ globals: { __state: {}, computeStreak: () => { throw new Error('x'); }, loadActivity: () => ({}), loadPlanners: () => { throw new Error('y'); }, todayStr: () => { throw new Error('z'); } } });
  assert.doesNotThrow(() => broken.timers[0].f());
  assert.equal(broken.calls[0][1].goals.streak, 0); assert.equal(broken.calls[0][1].goals.plan, null);
  const bare = loadSync();
  assert.doesNotThrow(() => bare.timers[0].f());
  assert.equal(bare.calls[0][1].language, 'bn', 'no app state yet: defaults');
});

test('native-sync: nothing is sent where there is no native layer', () => {
  const c = loadSync({ available: false });
  c.timers[0].f(); c.doc.visibilityState = 'hidden'; FIRE(c, 'doc:visibilitychange');
  assert.equal(c.calls.length, 0);
});

test('the bundle loads the bridge client and the sync, in that order, after the networking layer', async () => {
  const { standaloneBlock } = await import('../scripts/web/build-web.mjs');
  const block = standaloneBlock({ siteUrl: 'https://x.test', bundleId: 'b', appVersion: '1' });
  const order = ['window.QR_STANDALONE', 'js/local-data.js', 'js/prayer-calc.js', 'js/standalone-net.js', 'js/quran-native.js', 'js/native-sync.js'].map((s) => block.indexOf(s));
  assert.ok(order.every((n) => n >= 0) && order.every((n, i) => i === 0 || n > order[i - 1]), order.join());
});
