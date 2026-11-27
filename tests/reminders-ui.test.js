'use strict';
// app/js/reminders.js - the rules behind the reminders screen (pure functions) and its wiring into the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const API = require('../js/quran-native.js');

function load({ available = true } = {}) {
  const registered = {};
  const QRApp = { isBn: () => true, T: (bn) => bn, N: (n) => String(n), h: () => ({}), ui: {}, nav: { register: (id, def) => { registered[id] = def; }, push: (id) => { registered.pushed = id; } } };
  const win = { QRApp, QR_NATIVE: { isAvailable: () => available }, QR_NATIVE_API: API };
  vm.runInNewContext(read('app/js/reminders.js'), { window: win, document: { addEventListener() {}, removeEventListener() {} }, Object, Array, Math, Number, String, Promise, JSON, Date });
  return { core: QRApp.reminders.core, QRApp, registered };
}
const { core } = load();

test('time conversion: HH:MM <-> minutes, nothing invalid gets through', () => {
  assert.equal(core.toHHMM(0), '00:00'); assert.equal(core.toHHMM(390), '06:30'); assert.equal(core.toHHMM(1439), '23:59');
  assert.equal(core.toHHMM(-5), '00:00'); assert.equal(core.toHHMM(99999), '23:59'); assert.equal(core.toHHMM('x'), '00:00');
  assert.equal(core.toMinutes('06:30'), 390); assert.equal(core.toMinutes('6:05'), 365); assert.equal(core.toMinutes('23:59'), 1439); assert.equal(core.toMinutes('00:00'), 0);
  for (const bad of ['24:00', '12:60', '1230', '', null, undefined, 'ab:cd', '12:5', '-1:00']) assert.equal(core.toMinutes(bad), null, String(bad));
  for (let m = 0; m < 1440; m += 7) assert.equal(core.toMinutes(core.toHHMM(m)), m, 'round trip ' + m);
});

test('merge: texts and schedule come from the catalog, the user\'s choices from the saved list', () => {
  const cat = API.defaultCatalog('bn');
  const saved = [
    { id: 'prayer_fajr', enabled: true, mode: 'vibrate', timeMinutes: 777, title: 'OLD TITLE', prayer: 'isha' },
    { id: 'daily_quran', enabled: true, mode: 'silent', timeMinutes: 1290 },
    { id: 'no_longer_offered', enabled: true },
    { id: 'goal', enabled: 'yes', mode: 'loud', timeMinutes: 5000 }
  ];
  const m = core.merge(cat, saved);
  assert.equal(m.length, cat.length, 'exactly the catalog - unknown saved ids are dropped');
  const by = (id) => m.find((r) => r.id === id);
  assert.deepEqual([by('prayer_fajr').enabled, by('prayer_fajr').mode], [true, 'vibrate']);
  assert.equal(by('prayer_fajr').timeMinutes, 0, 'a prayer based reminder keeps the catalog schedule');
  assert.equal(by('prayer_fajr').prayer, 'fajr'); assert.match(by('prayer_fajr').title, /ফজর/, 'the title is the catalog one (current language)');
  assert.deepEqual([by('daily_quran').enabled, by('daily_quran').mode, by('daily_quran').timeMinutes], [true, 'silent', 1290], 'a fixed time reminder keeps the chosen time');
  assert.deepEqual([by('goal').enabled, by('goal').mode, by('goal').timeMinutes], [false, 'sound', 19 * 60], 'invalid saved values are ignored: enabled needs to be exactly true');
  assert.equal(by('azkar_morning').enabled, false, 'never saved = off');
  for (const r of m) assert.equal(API.validateReminder(r), null, r.id + ' is valid for the native side');
  assert.deepEqual(core.merge(cat, null).map((r) => r.enabled), cat.map(() => false));
  assert.deepEqual(core.merge(cat, 'garbage').length, cat.length);
});

test('alert style: the first enabled reminder decides, "sound" when none is on; applying it changes every reminder', () => {
  const cat = API.defaultCatalog('en');
  assert.equal(core.styleOf(cat), 'sound');
  const on = cat.map((r, i) => (i === 2 ? { ...r, enabled: true, mode: 'silent' } : r));
  assert.equal(core.styleOf(on), 'silent');
  const all = core.applyStyle(on, 'vibrate');
  assert.ok(all.every((r) => r.mode === 'vibrate'));
  assert.notEqual(all[0], on[0], 'a new list, the old one is untouched'); assert.equal(on[2].mode, 'silent');
  assert.equal(core.applyStyle(on, 'LOUD'), on, 'an unknown style changes nothing');
});

test('grouping and descriptions', () => {
  const cat = API.defaultCatalog('bn');
  const g = (id) => core.groupOf(cat.find((r) => r.id === id));
  assert.deepEqual(['prayer_fajr', 'jumuah', 'tahajjud'].map(g), ['prayer', 'prayer', 'prayer']);
  assert.deepEqual(['ramadan_suhoor', 'ramadan_iftar', 'taraweeh'].map(g), ['ramadan', 'ramadan', 'ramadan']);
  assert.deepEqual(['azkar_morning', 'azkar_evening', 'daily_quran', 'daily_ayah', 'goal'].map(g), ['daily', 'daily', 'daily', 'daily', 'daily']);
  const d = (id, bn) => core.describe(cat.find((r) => r.id === id), bn);
  assert.equal(d('prayer_asr', false), 'At the time'); assert.equal(d('prayer_asr', true), 'ঠিক ওয়াক্তে');
  assert.equal(d('jumuah', false), '60 min before • Fridays'); assert.equal(d('jumuah', true), '৬০ মিনিট আগে • শুক্রবার');
  assert.equal(d('azkar_evening', false), '30 min after');
  assert.equal(d('azkar_morning', false), '06:30'); assert.equal(d('azkar_morning', true), '০৬:৩০');
  assert.equal(d('ramadan_suhoor', false), '30 min before • Ramadan only');
  assert.equal(d('daily_quran', false), '21:00');
  assert.ok(cat.every((r) => core.fixedTime(r) === (r.prayer === null)));
});

test('wired into the app: screen registered, script list, Discover tile that exists only with the native layer, deep link', () => {
  const { registered, QRApp } = load();
  assert.ok(registered.reminders && registered.reminders.singleton);
  assert.equal(registered.reminders.topbar().lead, 'back');
  QRApp.reminders.open(); assert.equal(registered.pushed, 'reminders');
  assert.equal(QRApp.reminders.available(), true);
  assert.equal(load({ available: false }).QRApp.reminders.available(), false, 'false on the website / the safe build');
  assert.match(read('js/platform.js'), /'app\/js\/tasbih\.js',\s*\n\s*'app\/js\/reminders\.js',\s*\n\s*'app\/js\/widgets\.js',\s*\n\s*'app\/js\/compat\.js'/);
  const disc = read('app/js/discover.js');
  assert.match(disc, /\{ id: 'reminders', group: 'daily', icon: 'bell'.*visible: function\(\)\{ return !!\(QRApp\.reminders && QRApp\.reminders\.available\(\)\); \}/);
  assert.match(disc, /list: function\(\)\{ return FEATURES\.filter\(function\(f\)\{ return !f\.visible \|\| f\.visible\(\); \}\); \}/);
  assert.match(read('app/js/notifications.js'), /reminders: function\(\)\{ QRApp\.features\.open\('reminders'\); \}/);
});

test('the screen only calls bridge methods that exist, with the shapes the bridge defines', () => {
  const src = read('app/js/reminders.js');
  const used = new Set([...src.matchAll(/\b(?:b|bridge\(\))\.(\w+)\(/g)].map((m) => m[1]));
  const client = Object.getOwnPropertyNames(API.QuranNativeClient.prototype);
  for (const name of used) assert.ok(client.includes(name), `reminders.js calls QR_NATIVE.${name}() which the bridge client does not have`);
  for (const screen of [...src.matchAll(/'(exact-alarms|notifications|battery|app)'/g)].map((m) => m[1])) assert.ok(['exact-alarms', 'notifications', 'battery', 'app'].includes(screen));
  assert.ok(used.has('setReminders') && used.has('getReminders') && used.has('openSettings') && used.has('refreshCapabilities'));
});

test('every UI helper and icon the two new screens use exists in the app layer (a wrong name would break the screen at run time)', () => {
  const ui = read('app/js/ui.js');
  const defined = new Set([...ui.matchAll(/UI\.(\w+)\s*=\s*function/g)].map((m) => m[1]));
  const core = read('app/js/core.js');
  const icons = new Set([...core.slice(core.indexOf('var ICONS = {')).matchAll(/^\s*([A-Za-z0-9_]+)\s*:\s*['"]M/gm)].map((m) => m[1]));
  for (const f of ['app/js/tasbih.js', 'app/js/reminders.js']) {
    const src = read(f);
    for (const m of src.matchAll(/\bUI\.(\w+)\(/g)) assert.ok(defined.has(m[1]), `${f} calls UI.${m[1]}() which ui.js does not define`);
    for (const m of src.matchAll(/(?:icon|UI\.banner\([^,]+,)\s*['"](\w+)['"]/g)) assert.ok(icons.has(m[1]), `${f} uses the icon "${m[1]}" which core.js does not define`);
  }
  const disc = read('app/js/discover.js');
  for (const id of ['tasbih', 'reminders']) {
    const icon = new RegExp(`id: '${id}'[^}]*icon: '(\\w+)'`).exec(disc)[1];
    assert.ok(icons.has(icon), `the Discover tile of ${id} uses the icon "${icon}"`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// permissions: the notification permission is REQUESTED (system dialog); the settings page is only the second step
// ---------------------------------------------------------------------------------------------------------------------------------
function loadPermissions({ requestResult, openResult = true, confirmAnswer = true } = {}) {
  const seen = { requested: 0, settings: [], confirms: [], snacks: [] };
  const QRApp = {
    isBn: () => false, T: (bn, en) => en, N: (n) => String(n), h: () => ({}),
    ui: { confirm: (o) => { seen.confirms.push(o); return Promise.resolve(confirmAnswer); }, snack: (t) => { seen.snacks.push(t); } },
    nav: { register() {}, push() {} }
  };
  const bridge = {
    isAvailable: () => true,
    requestNotifications: () => { seen.requested++; return Promise.resolve(requestResult); },
    openSettings: (screen) => { seen.settings.push(screen); return Promise.resolve(openResult); }
  };
  const win = { QRApp, QR_NATIVE: bridge, QR_NATIVE_API: API };
  vm.runInNewContext(read('app/js/reminders.js'), { window: win, document: { addEventListener() {}, removeEventListener() {} }, Object, Array, Math, Number, String, Promise, JSON, Date });
  return { core: QRApp.reminders.core, seen };
}

test('notification permission: the system dialog is asked first; when it is granted nothing else is shown', async () => {
  const p = loadPermissions({ requestResult: { granted: true, state: 'granted' } });
  assert.equal(await p.core.askNotifications(), true);
  assert.equal(p.seen.requested, 1);
  assert.deepEqual(p.seen.confirms, []); assert.deepEqual(p.seen.settings, []);
});

test('notification permission: when the dialog cannot help (denied twice / switched off) the person is told so and the right settings page opens', async () => {
  for (const answer of [{ granted: false, state: 'denied' }, null]) {
    const p = loadPermissions({ requestResult: answer, confirmAnswer: true });
    assert.equal(await p.core.askNotifications(), false);
    assert.equal(p.seen.requested, 1, 'the dialog was tried first');
    assert.equal(p.seen.confirms.length, 1, 'with an explanation ...');
    assert.match(p.seen.confirms[0].text, /Open the phone settings/);
    assert.deepEqual(p.seen.settings, ['notifications'], '... and the notification settings of this app');
  }
  const no = loadPermissions({ requestResult: { granted: false }, confirmAnswer: false });
  assert.equal(await no.core.askNotifications(), false);
  assert.deepEqual(no.seen.settings, [], 'the person said no: nothing is opened');
});

test('precise alarms: the system page of the app opens; when this phone has none the person is told where to find it', async () => {
  const ok = loadPermissions({ openResult: true });
  assert.equal(await ok.core.askExactAlarms(), true);
  assert.deepEqual(ok.seen.settings, ['exact-alarms']); assert.deepEqual(ok.seen.snacks, []);
  const bad = loadPermissions({ openResult: false });
  assert.equal(await bad.core.askExactAlarms(), false);
  assert.equal(bad.seen.snacks.length, 1); assert.match(bad.seen.snacks[0], /Alarms & reminders/);
});

test('a permission given in the system settings is noticed when the app comes back, so the alarms are planned again at once', () => {
  const { core } = load();
  assert.equal(core.permissionGained({ exactAlarms: false, notificationsEnabled: true }, { exactAlarms: true, notificationsEnabled: true }), true);
  assert.equal(core.permissionGained({ exactAlarms: true, notificationsEnabled: false }, { exactAlarms: true, notificationsEnabled: true }), true);
  assert.equal(core.permissionGained({ exactAlarms: true, notificationsEnabled: true }, { exactAlarms: true, notificationsEnabled: true }), false);
  assert.equal(core.permissionGained({ exactAlarms: true, notificationsEnabled: true }, { exactAlarms: false, notificationsEnabled: true }), false, 'taking a permission away is not "gained"');
  assert.equal(core.permissionGained(null, { exactAlarms: true }), false, 'the first look is not a change');
  assert.equal(core.permissionGained({ exactAlarms: false }, null), false);
});

test('the reminders screen offers real buttons for the permissions (not only a link to the settings)', () => {
  const src = read('app/js/reminders.js');
  assert.match(src, /T\('নোটিফিকেশনের অনুমতি দিন', 'Allow notifications'\)[^\n]*askNotifications\(\)/);
  assert.match(src, /T\('নির্ভুল অ্যালার্মের অনুমতি দিন', 'Allow precise alarms'\)[^\n]*askExactAlarms\(\)/);
  assert.match(src, /if\(v && S\.caps && S\.caps\.notificationsEnabled === false\) askNotifications\(\)/, 'switching a reminder on asks for the notification permission');
});
