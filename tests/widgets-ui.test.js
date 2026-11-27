'use strict';
// app/js/widgets.js - the "Home screen widgets" screen: the rules (pure functions), its wiring into the app and the add flow
// (one tap -> the system dialog of the launcher; where that is not possible -> the manual way, in words).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const API = require('../js/quran-native.js');

// The screen with a fake UI: every helper records what it was asked to draw, nothing needs a DOM.
function load({ available = true, caps = null, pin = { requested: true } } = {}) {
  const registered = {}, seen = { rows: [], banners: [], snack: [], alert: [], pins: [], appended: [] };
  const body = { innerHTML: '', appendChild(c) { seen.appended.push(c); return c; } };
  const UI = {
    banner: (text, icon, kind) => { seen.banners.push(text); return { banner: text }; },
    section: (t) => ({ section: t }), group: (rows) => ({ group: rows }),
    row: (o) => { seen.rows.push(o); return { row: o }; },
    snack: (t) => { seen.snack.push(t); }, alert: (a, b) => { seen.alert.push([a, b]); return Promise.resolve(); }
  };
  const QRApp = {
    isBn: () => false, T: (bn, en) => en, N: (n) => 'N' + n, h: (tag, attrs, ...kids) => (tag === 'div' && attrs && attrs.class === 'qa-stack qa-widgets' ? body : { tag, kids }),
    ui: UI, nav: { register: (id, def) => { registered[id] = def; }, push: (id) => { registered.pushed = id; } }
  };
  const bridge = {
    isAvailable: () => available,
    refreshCapabilities: () => Promise.resolve(caps),
    requestPinWidget: (key) => { seen.pins.push(key); return Promise.resolve(pin); }
  };
  const win = { QRApp, QR_NATIVE: bridge, QR_NATIVE_API: API };
  const listeners = [];
  vm.runInNewContext(read('app/js/widgets.js'), { window: win, document: { visibilityState: 'visible', addEventListener: (n, f) => listeners.push([n, f]), removeEventListener() {} }, Object, Array, Math, Number, String, Promise, JSON, Date, isFinite });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { core: QRApp.widgets.core, QRApp, registered, seen, body, listeners, tick, def: registered.widgets, el: { appendChild() {} } };
}

test('the catalogue is exactly the five widgets of the native layer, in the same order and with the same keys', () => {
  const { core } = load();
  const keys = Array.from(core.CATALOG, (w) => w.key);            // Array.from: an array of THIS realm (the screen runs in a vm context)
  assert.deepEqual(keys, API.WIDGET_KEYS, 'the keys of js/quran-native.js');
  const kotlin = read('android-build/native/kotlin/com/techverse/quranbangla/widgets/WidgetUpdater.kt');
  assert.deepEqual([...kotlin.matchAll(/Entry\("([a-z_]+)"/g)].map((m) => m[1]), keys, 'the keys of WidgetUpdater.kt');
  for (const w of core.CATALOG) {
    assert.equal(w.title.length, 2); assert.equal(w.sub.length, 2);
    assert.ok(w.title.every((t) => t.length > 2) && w.sub.every((t) => t.length > 8), 'Bengali and English texts for ' + w.key);
    assert.ok(w.icon, 'an icon for ' + w.key);
  }
});

test('rules: copies on the home screen, and which way of adding the phone offers', () => {
  const { core } = load();
  assert.equal(core.installedCount(null, 'next_prayer'), 0);
  assert.equal(core.installedCount({}, 'next_prayer'), 0);
  assert.equal(core.installedCount({ widgetsInstalled: { next_prayer: 2, daily_ayah: 0 } }, 'next_prayer'), 2);
  assert.equal(core.installedCount({ widgetsInstalled: { next_prayer: 2 } }, 'daily_ayah'), 0);
  assert.equal(core.installedCount({ widgetsInstalled: { next_prayer: 'x' } }, 'next_prayer'), 0);
  assert.equal(core.installedCount({ widgetsInstalled: { next_prayer: -3 } }, 'next_prayer'), 0);
  assert.equal(core.installedCount({ widgetsInstalled: { next_prayer: 1.9 } }, 'next_prayer'), 1);
  assert.equal(core.totalInstalled({ widgetsInstalled: { next_prayer: 2, daily_ayah: 1, quick_actions: 3 } }), 6);
  assert.equal(core.mode({ pinWidgetSupported: true }), 'pin');
  for (const c of [{ pinWidgetSupported: false }, {}, null, undefined, { pinWidgetSupported: 'true' }]) assert.equal(core.mode(c), 'manual');
});

test('wired into the app: screen registered, opened from Discover, only where the native layer exists', () => {
  const { registered, QRApp } = load();
  assert.ok(registered.widgets && registered.widgets.singleton);
  assert.equal(registered.widgets.topbar().lead, 'back');
  QRApp.widgets.open(); assert.equal(registered.pushed, 'widgets');
  assert.equal(QRApp.widgets.available(), true);
  assert.equal(load({ available: false }).QRApp.widgets.available(), false, 'false on the website / in the safe build');
  const discover = read('app/js/discover.js');
  assert.match(discover, /id: 'widgets', group: 'daily'[^\n]*visible: function\(\)\{ return !!\(QRApp\.widgets && QRApp\.widgets\.available\(\)\); \}, open: function\(\)\{ QRApp\.widgets\.open\(\); \}/);
  assert.match(read('js/platform.js'), /'app\/js\/reminders\.js',\s*\n\s*'app\/js\/widgets\.js'/);
});

test('add flow, launcher can pin: five rows, each row is the button, a tap asks the system dialog for exactly that widget', async () => {
  const s = load({ caps: { pinWidgetSupported: true, widgetsInstalled: { next_prayer: 1 } } });
  s.def.mount(s.el); s.def.show(); await s.tick(); await s.tick();
  assert.equal(s.seen.rows.length, 5);
  assert.ok(s.seen.rows.every((r) => typeof r.onClick === 'function'), 'every row is tappable');
  assert.deepEqual(s.seen.rows.map((r) => r.value), ['Add another', 'Add', 'Add', 'Add', 'Add'], 'the value says what a tap does');
  assert.match(s.seen.rows[0].sub, /1 on your home screen/);
  assert.doesNotMatch(s.seen.rows[1].sub, /home screen$/);
  assert.ok(s.seen.rows.every((r) => !r.trail), 'no button inside the row button');
  const row = { disabled: false };
  s.seen.rows[1].onClick({}, row);                                 // "Ayah of the day"
  await s.tick();
  assert.deepEqual(s.seen.pins, ['daily_ayah']);
  assert.equal(s.seen.snack.length, 1, 'the person is told to confirm in the launcher dialog');
  assert.equal(s.seen.alert.length, 0);
});

test('add flow, the launcher refuses the request: the manual way is explained, with the name of that widget', async () => {
  const s = load({ caps: { pinWidgetSupported: true }, pin: { requested: false } });
  s.def.mount(s.el); s.def.show(); await s.tick(); await s.tick();
  s.seen.rows[3].onClick({}, {});                                  // "Quran shortcuts"
  await s.tick(); await s.tick();
  assert.equal(s.seen.alert.length, 1);
  assert.match(s.seen.alert[0][1], /Widgets/); assert.match(s.seen.alert[0][1], /Quran shortcuts/); assert.match(s.seen.alert[0][1], /Quran Bangla/);
  assert.equal(s.seen.snack.length, 0);
});

test('add flow, the phone cannot pin from an app: rows are plain, the way to add them by hand is written on the screen', async () => {
  const s = load({ caps: { pinWidgetSupported: false } });
  s.def.mount(s.el); s.def.show(); await s.tick(); await s.tick();
  assert.equal(s.seen.rows.length, 5);
  assert.ok(s.seen.rows.every((r) => !r.onClick && !r.value), 'nothing that would do nothing');
  assert.ok(s.seen.banners.some((b) => /cannot add widgets from the app/.test(b)));
  assert.ok(s.seen.appended.some((n) => n && n.kids && JSON.stringify(n).includes('Touch and hold an empty spot')), 'the steps are on the screen');
});

test('no native layer (website, safe build): the screen only says that this is an app feature - it never throws', async () => {
  const s = load({ available: false, caps: null });
  s.def.mount(s.el); s.def.show(); await s.tick();
  assert.equal(s.seen.rows.length, 0);
  assert.ok(s.seen.banners.some((b) => /only available in the Android app/.test(b)));
});

test('coming back from the launcher dialog refreshes the numbers (visibilitychange), and the listener is removed with the screen', async () => {
  const s = load({ caps: { pinWidgetSupported: true } });
  s.def.mount(s.el);
  assert.equal(s.listeners.length, 1); assert.equal(s.listeners[0][0], 'visibilitychange');
  s.def.show(); await s.tick(); await s.tick();
  const before = s.seen.rows.length;
  s.listeners[0][1](); await s.tick(); await s.tick();
  assert.ok(s.seen.rows.length > before, 'rendered again');
  assert.doesNotThrow(() => s.def.unmount());
});

test('the native side behind the screen: requestPinWidget exists in the bridge and in the Kotlin plugin, with a fallback for old launchers', () => {
  const client = read('js/quran-native.js');
  assert.match(client, /requestPinWidget\(widget\)/);
  assert.match(client, /requestPinWidget\(\{ widget \}\)/, 'the plugin gets { widget }');
  const kt = read('android-build/native/kotlin/com/techverse/quranbangla/bridge/QuranNativePlugin.kt');
  assert.match(kt, /fun requestPinWidget\(call: PluginCall\)/);
  assert.match(kt, /isRequestPinAppWidgetSupported/);
  assert.match(kt, /requestPinAppWidget\(ComponentName\(context, cls\), null, null\)/);
  assert.match(kt, /call\.getString\("widget"\)/);
});
