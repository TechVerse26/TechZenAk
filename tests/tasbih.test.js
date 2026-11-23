'use strict';
// app/js/tasbih.js - the counting rules (pure functions) and the wiring into the app (feature list, deep link, script list).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'app/js/tasbih.js'), 'utf8');

function load({ prefs = {} } = {}) {
  const store = { ...prefs };
  const registered = {};
  const QRApp = {
    isBn: () => true, T: (bn) => bn, N: (n) => String(n), h: () => ({}), icon: () => '', ui: {}, native: {},
    prefs: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
    nav: { register: (id, def) => { registered[id] = def; }, push: (id) => { registered.pushed = id; } },
    debounce: (fn) => fn
  };
  const win = { QRApp };
  vm.runInNewContext(SRC, { window: win, Math, Date, Object, Array, Number, String, JSON, isFinite, Promise });
  return { core: QRApp.tasbih.core, QRApp, registered, store };
}
const day = (y, m, d) => new Date(y, m - 1, d, 12);

test('a tap counts, and a finished round starts again from zero', () => {
  const { core } = load();
  const s = core.defaults();
  for (let i = 1; i <= 32; i++) { const r = core.tap(s, day(2026, 11, 18)); assert.equal(r.roundCompleted, false); assert.equal(s.counts.subhanallah, i); }
  const r = core.tap(s, day(2026, 11, 18));
  assert.equal(r.roundCompleted, true);
  assert.equal(s.counts.subhanallah, 0); assert.equal(s.rounds.subhanallah, 1); assert.equal(s.today, 33);
});

test('the target decides when a round ends: 99, 100, and "no target" (never)', () => {
  const { core } = load();
  for (const [target, taps, rounds, left] of [[99, 250, 2, 52], [100, 250, 2, 50], [0, 250, 0, 250]]) {
    const s = core.defaults(); core.setTarget(s, target);
    for (let i = 0; i < taps; i++) core.tap(s, day(2026, 11, 18));
    assert.equal(s.rounds.subhanallah, rounds, 'rounds for target ' + target);
    assert.equal(s.counts.subhanallah, left, 'count left for target ' + target);
  }
  const s = core.defaults(); core.setTarget(s, 7);
  assert.equal(s.target, 33, 'a target that is not offered is ignored');
});

test('every dhikr has its own count and rounds; selecting an unknown one is ignored', () => {
  const { core } = load();
  const s = core.defaults();
  core.tap(s, day(2026, 11, 18)); core.tap(s, day(2026, 11, 18));
  core.select(s, 'allahuakbar'); core.tap(s, day(2026, 11, 18));
  core.select(s, 'nonsense'); assert.equal(s.dhikr, 'allahuakbar');
  assert.deepEqual([s.counts.subhanallah, s.counts.allahuakbar, s.today], [2, 1, 3]);
  assert.equal(core.DHIKR.length, 6); assert.ok(core.DHIKR.every((d) => d.id === 'free' || d.ar.length > 3));
});

test('undo takes back the last tap - including the tap that finished a round', () => {
  const { core } = load();
  const s = core.defaults();                                   // target 33
  for (let i = 0; i < 5; i++) core.tap(s, day(2026, 11, 18));
  assert.equal(core.undo(s), true); assert.deepEqual([s.counts.subhanallah, s.today], [4, 4]);
  for (let i = 0; i < 29; i++) core.tap(s, day(2026, 11, 18)); // 33 in total
  assert.deepEqual([s.counts.subhanallah, s.rounds.subhanallah, s.today], [0, 1, 33], 'the 33rd tap finished the round');
  assert.equal(core.undo(s), true);
  assert.deepEqual([s.counts.subhanallah, s.rounds.subhanallah, s.today], [32, 0, 32], 'the round is reopened with one tap to go');
  assert.equal(core.undo(core.defaults()), false, 'nothing to take back');
});

test('undo is limited to the last 50 taps', () => {
  const { core } = load();
  const s = core.defaults(); core.setTarget(s, 0);
  for (let i = 0; i < 80; i++) core.tap(s, day(2026, 11, 18));
  let n = 0; while (core.undo(s)) n++;
  assert.equal(n, 50); assert.equal(s.counts.subhanallah, 30);
});

test('reset clears the count and rounds of the chosen dhikr only, and keeps today\'s total', () => {
  const { core } = load();
  const s = core.defaults();                                   // target 33
  for (let i = 0; i < 70; i++) core.tap(s, day(2026, 11, 18));
  assert.deepEqual([s.rounds.subhanallah, s.counts.subhanallah], [2, 4]);
  core.select(s, 'alhamdulillah'); core.tap(s, day(2026, 11, 18));
  core.select(s, 'subhanallah'); core.reset(s);
  assert.deepEqual([s.counts.subhanallah, s.rounds.subhanallah], [0, 0]);
  assert.equal(s.counts.alhamdulillah, 1); assert.equal(s.today, 71);
  assert.ok(!s.undo.includes('subhanallah') && s.undo.includes('alhamdulillah'), 'undo does not resurrect a reset dhikr');
});

test('today\'s total restarts on a new day, the counters themselves do not', () => {
  const { core } = load();
  const s = core.defaults(); core.setTarget(s, 0);
  core.tap(s, day(2026, 11, 18)); core.tap(s, day(2026, 11, 18));
  assert.equal(s.day, '2026-11-18'); assert.equal(s.today, 2);
  core.tap(s, day(2026, 11, 19));
  assert.equal(s.day, '2026-11-19'); assert.equal(s.today, 1); assert.equal(s.counts.subhanallah, 3);
  assert.equal(core.dayKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('progress is a whole percent of the target (0 without a target)', () => {
  const { core } = load();
  const s = core.defaults();
  for (let i = 0; i < 11; i++) core.tap(s, day(2026, 11, 18));
  assert.equal(core.progress(s), 33);
  core.setTarget(s, 0); assert.equal(core.progress(s), 0);
});

test('prototype keys are not dhikr ids (stored data is never trusted)', () => {
  const { core } = load();
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(core.normalize({ dhikr: key }).dhikr, 'subhanallah', key);
    const s = core.defaults(); core.select(s, key); assert.equal(s.dhikr, 'subhanallah', key);
    assert.deepEqual(core.normalize({ undo: [key, 'lailaha'] }).undo, ['lailaha'], key);
  }
});

test('damaged or hostile stored data becomes a clean default, never an exception', () => {
  const { core } = load();
  for (const bad of [null, undefined, 5, 'x', [], { counts: 'no' }, { dhikr: '__proto__', target: 'x', counts: { subhanallah: -5, alhamdulillah: 'many', allahuakbar: 1e99 }, today: NaN, undo: ['bogus', 'lailaha', 7] }]) {
    const s = core.normalize(bad);
    assert.equal(s.v, 1);
    assert.ok(core.DHIKR.some((d) => d.id === s.dhikr));
    assert.ok(core.TARGETS.includes(s.target));
    for (const d of core.DHIKR) { assert.ok(Number.isInteger(s.counts[d.id]) && s.counts[d.id] >= 0 && s.counts[d.id] <= 999999); assert.ok(Number.isInteger(s.rounds[d.id]) && s.rounds[d.id] >= 0); }
    assert.ok(Number.isInteger(s.today) && s.today >= 0);
    assert.ok(s.undo.every((x) => core.DHIKR.some((d) => d.id === x)));
  }
  const s = core.normalize({ dhikr: 'lailaha', target: 99, counts: { lailaha: 12 }, rounds: { lailaha: 2 }, day: '2026-11-18', today: 40, undo: ['lailaha'] });
  assert.deepEqual([s.dhikr, s.target, s.counts.lailaha, s.rounds.lailaha, s.today, s.undo.length], ['lailaha', 99, 12, 2, 40, 1], 'good data survives');
});

test('it is wired into the app: screen registered, Discover tile, deep link, script list - and the widget button leads somewhere', () => {
  const { registered, QRApp } = load();
  assert.ok(registered.tasbih && registered.tasbih.singleton && typeof registered.tasbih.mount === 'function');
  assert.equal(registered.tasbih.topbar().lead, 'back');
  QRApp.tasbih.open(); assert.equal(registered.pushed, 'tasbih');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.match(read('js/platform.js'), /'app\/js\/tasbih\.js',\s*\n\s*'app\/js\/reminders\.js',\s*\n\s*'app\/js\/compat\.js'/, 'loaded by the app layer, before compat.js');
  assert.match(read('app/js/discover.js'), /\{ id: 'tasbih', group: 'daily', icon: 'repeat'/);
  assert.match(read('app/js/notifications.js'), /tasbih: function\(\)\{ QRApp\.features\.open\('tasbih'\); \}/);
  assert.match(read('app/css/screens.css'), /\.qa-tasbih-ring\{/);
});
