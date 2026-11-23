'use strict';
// The native overlay (android-build/native): there is no Kotlin compiler in this environment, so these tests do two things:
//   1. prove that android-build/native-lint.mjs really catches the mistakes it claims to catch (22 deliberate mistakes)
//   2. prove that what is DUPLICATED between the web app and the Kotlin code cannot drift apart (prayer methods, the
//      ayah-of-the-day pool, deep link screens, reminder contract, Quran asset names)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'android-build', 'native');
const KT = path.join(NATIVE, 'kotlin', 'com', 'techverse', 'quranbangla');
const read = (f) => fs.readFileSync(f, 'utf8');
const lintMod = () => import('../android-build/native-lint.mjs');

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-lint-'));
  const build = path.join(tmp, 'android-build');
  fs.cpSync(NATIVE, path.join(build, 'native'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'android-build', 'res'), path.join(build, 'res'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'js'));
  fs.mkdirSync(path.join(tmp, 'app', 'js'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'js', 'data.js'), path.join(tmp, 'js', 'data.js'));
  fs.copyFileSync(path.join(ROOT, 'app', 'js', 'data.js'), path.join(tmp, 'app', 'js', 'data.js'));
  const kt = (rel) => path.join(build, 'native', 'kotlin', 'com', 'techverse', 'quranbangla', rel);
  const res = (rel) => path.join(build, 'native', 'res', rel);
  const edit = (file, fn) => fs.writeFileSync(file, fn(read(file)));
  return { tmp, build, kt, res, edit, root: (rel) => path.join(tmp, rel), lint: async () => (await lintMod()).lintNative(build) };
}

test('the overlay as it is committed: no errors, no warnings', async () => {
  const { lintNative } = await lintMod();
  const r = lintNative(path.join(ROOT, 'android-build'));
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  assert.ok(r.info.kotlinFiles >= 25 && r.info.classes >= 40 && r.info.resFiles >= 20, JSON.stringify(r.info));
});

const MUTATIONS = [
  ['an unclosed brace', (s) => s.edit(s.kt('widgets/QuickActionsWidget.kt'), (t) => t.replace(/\}\s*$/, '')), /QuickActionsWidget\.kt: unclosed/],
  ['a package line that does not match the folder', (s) => s.edit(s.kt('core/Json.kt'), (t) => t.replace('package com.techverse.quranbangla.core', 'package com.techverse.quranbangla.util')), /Json\.kt: package .* does not match its folder/],
  ['__APP_ID__ used outside package/import', (s) => s.edit(s.kt('core/Deeplinks.kt'), (t) => t.replace('const val SCHEME = "quranbangla"', 'const val SCHEME = "__APP_ID__"')), /Deeplinks\.kt:\d+: __APP_ID__ may only be used/],
  ['a missing import of an app class', (s) => s.edit(s.kt('widgets/NextPrayerWidget.kt'), (t) => t.replace('import com.techverse.quranbangla.core.Deeplinks\n', '')), /NextPrayerWidget\.kt: uses Deeplinks .* without importing it/],
  ['a missing import of an app extension function', (s) => s.edit(s.kt('prayer/PrayerSchedule.kt'), (t) => t.replace('import com.techverse.quranbangla.core.stringOrNull\n', '')), /PrayerSchedule\.kt: uses stringOrNull\(\) .* without importing it/],
  ['an import that points at nothing', (s) => s.edit(s.kt('widgets/QuickActionsWidget.kt'), (t) => t.replace('import android.content.Context', 'import android.content.Context\nimport com.techverse.quranbangla.core.DoesNotExist')), /import com\.techverse\.quranbangla\.core\.DoesNotExist does not exist/],
  ['a typo in a Capacitor import', (s) => s.edit(s.kt('bridge/QuranNativePlugin.kt'), (t) => t.replace('import com.getcapacitor.JSArray', 'import com.getcapacitor.JSArrays')), /unknown name in com\.getcapacitor\./],
  ['a library that is not in the app', (s) => s.edit(s.kt('bridge/QuranNativePlugin.kt'), (t) => t.replace('import android.os.Build', 'import android.os.Build\nimport okhttp3.OkHttpClient')), /okhttp3\.OkHttpClient is not from a library the app has/],
  ['a class that is declared nowhere', (s) => s.edit(s.kt('widgets/QuickActionsWidget.kt'), (t) => t.replace('return views', 'val x = LabelsX.of(null)\n        return views')), /"LabelsX" is not declared/],
  ['R used without its import', (s) => s.edit(s.kt('widgets/QuickActionsWidget.kt'), (t) => t.replace('import __APP_ID__.R\n', '')), /uses R\.\* without "import __APP_ID__\.R"/],
  ['a layout that does not exist', (s) => fs.rmSync(s.res('layout/qw_widget_quick.xml')), /R\.layout\.qw_widget_quick is not defined/],
  ['a view id the widget layout does not have', (s) => s.edit(s.res('layout/qw_widget_next_prayer.xml'), (t) => t.replace('@+id/qw_next_time', '@+id/qw_next_timex')), /R\.id\.qw_next_time is not in qw_widget_next_prayer\.xml/],
  ['a view a launcher cannot inflate', (s) => s.edit(s.res('layout/qw_widget_continue.xml'), (t) => t.replace('<ProgressBar', '<androidx.constraintlayout.widget.ConstraintLayout')), /<androidx\.constraintlayout\.widget\.ConstraintLayout> cannot be used in a widget/],
  ['a string that exists only in a translation (no default)', (s) => s.edit(s.res('values/qw_strings.xml'), (t) => t.replace('<string name="qw_next_prayer_label">Next prayer</string>', '')), /values-bn\/qw_strings\.xml: string qw_next_prayer_label has no default/],
  ['a string every language lacks', (s) => { for (const f of ['values/qw_strings.xml', 'values-bn/qw_strings.xml']) s.edit(s.res(f), (t) => t.replace(/<string name="qw_next_prayer_label">[^<]*<\/string>/, '')); }, /@string\/qw_next_prayer_label is not defined/],
  ['a dark-mode colour with no light value', (s) => s.edit(s.res('values/qw_colors.xml'), (t) => t.replace('<color name="qw_track">#26000000</color>', '')), /values-night\/qw_colors\.xml: color qw_track has no default/],
  ['a manifest receiver without a class', (s) => s.edit(path.join(s.build, 'native', 'manifest', 'components.xml'), (t) => t.replace('com.techverse.quranbangla.widgets.WidgetTickReceiver', 'com.techverse.quranbangla.widgets.GhostReceiver')), /receiver com\.techverse\.quranbangla\.widgets\.GhostReceiver has no Kotlin class/],
  ['a manifest receiver that is not a receiver', (s) => s.edit(s.kt('reminders/BootReceiver.kt'), (t) => t.replace('class BootReceiver : BroadcastReceiver()', 'class BootReceiver : Thread()')), /BootReceiver extends Thread, a <receiver> must extend/],
  ['a component without android:exported', (s) => s.edit(path.join(s.build, 'native', 'manifest', 'components.xml'), (t) => t.replace('<receiver android:name="com.techverse.quranbangla.reminders.ReminderReceiver" android:exported="false" />', '<receiver android:name="com.techverse.quranbangla.reminders.ReminderReceiver" />')), /ReminderReceiver must declare android:exported/],
  ['a Room query with a column that does not exist', (s) => s.edit(s.kt('db/Daos.kt'), (t) => t.replace('ORDER BY openedAt DESC', 'ORDER BY openedAtX DESC')), /"openedAtX" in the query is neither an SQL word, a table nor a column/],
  ['a Room query on an unknown table', (s) => s.edit(s.kt('db/Daos.kt'), (t) => t.replace('SELECT COUNT(*) FROM notes', 'SELECT COUNT(*) FROM nots')), /query uses unknown table nots/],
  ['a Room query parameter that is not a function parameter', (s) => s.edit(s.kt('db/Daos.kt'), (t) => t.replace('LIMIT :limit")\n    fun latest(limit: Int): List<ReadingHistoryEntity>', 'LIMIT :limit")\n    fun latest(count: Int): List<ReadingHistoryEntity>')), /:limit is not a parameter of the function/],
  ['an entity missing from @Database', (s) => s.edit(s.kt('db/AppDatabase.kt'), (t) => t.replace('KeyValueEntity::class', 'ReadingHistoryEntity::class')), /entity KeyValueEntity is not listed in @Database/],
  ['an entity without a primary key', (s) => s.edit(s.kt('db/Entities.kt'), (t) => t.replace('@PrimaryKey val key: String,', 'val key: String,')), /KeyValueEntity has no @PrimaryKey/],
  ['a plugin method with the wrong signature', (s) => s.edit(s.kt('bridge/QuranNativePlugin.kt'), (t) => t.replace('fun refreshWidgets(call: PluginCall)', 'fun refreshWidgets(call: PluginCall, extra: Int)')), /@PluginMethod refreshWidgets\(.*\) must take exactly \(call: PluginCall\)/],
  ['the plugin registered after super.onCreate', (s) => s.edit(path.join(s.build, 'native', 'kotlin', 'MainActivity.kt'), (t) => t.replace('registerPlugin(QuranNativePlugin::class.java)\n        super.onCreate(savedInstanceState)', 'super.onCreate(savedInstanceState)\n        registerPlugin(QuranNativePlugin::class.java)')), /registerPlugin\(QuranNativePlugin::class\.java\) BEFORE super\.onCreate/],
  ['a widget that does not override build()', (s) => s.edit(s.kt('widgets/QuickActionsWidget.kt'), (t) => t.replace('override fun build(', 'fun buildIt(')), /a widget must override layoutId and build\(\)/],
  ['a stale SurahData.kt (js/data.js changed)', (s) => s.edit(s.root('js/data.js'), (t) => t.replace('{s:2,a:255}', '{s:2,a:256}')), /SurahData\.kt is out of date/],
  ['malformed XML', (s) => s.edit(s.res('drawable/qw_chip_bg.xml'), (t) => t.replace('</shape>', '')), /qw_chip_bg\.xml: not well-formed XML/]
];
for (const [label, mutate, expected] of MUTATIONS) {
  test(`lint catches: ${label}`, async () => {
    const s = sandbox();
    mutate(s);
    const r = await s.lint();
    assert.ok(r.errors.some((e) => expected.test(e)), `expected an error matching ${expected}, got:\n  ${r.errors.join('\n  ') || '(no errors at all)'}`);
  });
}

// ---------------------------------------------------------------------------------- duplicated knowledge must not drift
test('prayer methods: the Kotlin table equals js/prayer-calc.js (angles and minutes)', () => {
  const PC = require('../js/prayer-calc.js');
  const kt = read(path.join(KT, 'prayer', 'PrayerCalculator.kt'));
  const rows = [...kt.matchAll(/CalcMethod\((\d+),\s*"[^"]*",\s*([\d.]+),\s*([\d.]+),\s*(\d+),\s*(\d+)\)/g)].map((m) => ({ id: +m[1], fajr: +m[2], isha: +m[3], ishaMinutes: +m[4], ishaMinutesRamadan: +m[5] }));
  assert.deepEqual(rows.map((r) => r.id).sort((a, b) => a - b), Object.keys(PC.METHODS).map(Number).sort((a, b) => a - b), 'the same methods');
  for (const r of rows) {
    const js = PC.METHODS[r.id];
    assert.equal(r.fajr, js.fajr, 'fajr angle of method ' + r.id);
    assert.equal(r.isha, js.isha || 0, 'isha angle of method ' + r.id);
    assert.equal(r.ishaMinutes, js.ishaMinutes || 0, 'isha minutes of method ' + r.id);
    assert.equal(r.ishaMinutesRamadan, js.ishaMinutesRamadan || 0, 'ramadan isha minutes of method ' + r.id);
  }
});

test('prayer calculation constants: the Kotlin port uses the same numbers as the verified JavaScript', () => {
  const js = read(path.join(ROOT, 'js', 'prayer-calc.js'));
  const kt = read(path.join(KT, 'prayer', 'PrayerCalculator.kt'));
  for (const c of ['357.529', '0.98560028', '280.459', '0.98564736', '1.915', '0.020', '23.439', '0.00000036', '2451545.0', '365.25', '4716', '30.6001', '1524.5', '0.0347', '0.833', '10.0 / 60.0']) {
    assert.ok(js.includes(c.replace('10.0 / 60.0', '10 / 60')), 'JS has ' + c);
    assert.ok(kt.includes(c), 'Kotlin has ' + c);
  }
  assert.match(kt, /sunAngleTime\(method\.fajrAngle, 5\.0 \/ 24\.0, true\)/);
  assert.match(kt, /sunAngleTime\(riseSetAngle, 6\.0 \/ 24\.0, true\)/);
  assert.match(kt, /asrTime\(asrFactor, 13\.0 \/ 24\.0\)/);
  assert.match(kt, /sunAngleTime\(riseSetAngle, 18\.0 \/ 24\.0, false\)/);
  assert.match(kt, /val asrFactor = if \(school == 1\) 2\.0 else 1\.0/);
  assert.match(kt, /angle \/ 60\.0 \* night/);
});

test('ayah of the day: Kotlin picks exactly like the app (same pool, same day number)', () => {
  const data = read(path.join(ROOT, 'js', 'data.js'));
  assert.match(data, /Math\.floor\(Date\.UTC\(d\.getFullYear\(\), d\.getMonth\(\), d\.getDate\(\)\) \/ 86400000\)/, 'js/data.js still derives the day number from the LOCAL date this way');
  const kt = read(path.join(KT, 'core', 'DailyAyah.kt'));
  assert.match(kt, /Math\.floorDiv\(PrayerSchedule\.utcMidnight\(year, month, day\), 86_400_000L\)/);
  assert.match(kt, /pool\[\(dayNumber\(year, month, day\) % pool\.size\)\.toInt\(\)\]/);
  const pool = [...read(path.join(KT, 'core', 'SurahData.kt')).matchAll(/intArrayOf\((\d+), (\d+)\)/g)].map((m) => [+m[1], +m[2]]);
  const jsPool = [...data.match(/const AYAH_OF_DAY_POOL\s*=\s*\[([\s\S]*?)\];/)[1].matchAll(/s:\s*(\d+),\s*a:\s*(\d+)/g)].map((m) => [+m[1], +m[2]]);
  assert.deepEqual(pool, jsPool);
  assert.equal(pool.length, 30);
});

test('every deep link a widget, reminder or notification can open is a screen the app knows', () => {
  const router = read(path.join(ROOT, 'app', 'js', 'notifications.js'));
  const known = new Set([...router.slice(router.indexOf('var OPEN'), router.indexOf('var OPEN') + 2500).matchAll(/^\s*(\w+):\s*function/gm)].map((m) => m[1]));
  for (const s of ['home', 'quran', 'search', 'qibla', 'prayer', 'continue', 'planner', 'tasbih']) assert.ok(known.has(s), 'the router has no screen "' + s + '"');
  const used = new Set();
  for (const dir of ['widgets', 'reminders', 'core', 'bridge']) {
    for (const f of fs.readdirSync(path.join(KT, dir))) {
      for (const m of read(path.join(KT, dir, f)).matchAll(/Deeplinks\.screen\("(\w+)"\)/g)) used.add(m[1]);
    }
  }
  assert.ok(used.size >= 6, 'screens used: ' + [...used]);
  for (const s of used) assert.ok(known.has(s), `a widget/reminder opens quranbangla://${s} but the app does not know that screen (dead button)`);
  assert.match(router, /ayah/, 'the router understands ?surah=&ayah= links (the daily ayah widget)');
});

test('the Quran files the widgets read are the ones the dataset builder writes', () => {
  const qa = read(path.join(KT, 'core', 'QuranAssets.kt'));
  assert.match(qa, /BASE = "public\/data\/quran"/);
  for (const f of ['structure.json', 'surahs.json', 'text/']) assert.ok(qa.includes(f), f);
  const py = read(path.join(ROOT, 'tools', 'quran-data', 'quran_data.py'));
  for (const f of ['structure.json', 'surahs.json', 'f"text/{e}.json"']) assert.ok(py.includes(f), f);
  const ed = JSON.parse(read(path.join(ROOT, 'tools', 'quran-data', 'editions.json')));
  assert.ok(ed.arabic.includes('quran-uthmani') && ed.translations.includes('bn.bengali'), 'the widgets need quran-uthmani and the default translation bn.bengali');
});

test('reminder contract: the Kotlin kinds, modes and priorities are what the web side will send', () => {
  const kt = read(path.join(KT, 'reminders', 'Reminder.kt'));
  const set = (name) => [...kt.match(new RegExp(name + ' = setOf\\(([\\s\\S]*?)\\)'))[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(set('MODES'), ['sound', 'vibrate', 'silent']);
  assert.deepEqual(set('PRIORITIES'), ['high', 'default', 'low']);
  assert.deepEqual(set('KINDS'), ['prayer', 'daily_quran', 'azkar_morning', 'azkar_evening', 'daily_ayah', 'goal', 'streak', 'course', 'custom', 'ramadan_suhoor', 'ramadan_iftar', 'taraweeh', 'tahajjud', 'jumuah']);
  assert.match(kt, /"fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha", "imsak", "lastthird"/);
  const channels = read(path.join(KT, 'reminders', 'NotificationChannels.kt'));
  assert.match(channels, /CATEGORIES = listOf\("prayer", "reading", "azkar", "general"\)/);
  for (const k of set('KINDS')) assert.match(kt, new RegExp('"' + k + '"'), k);
});

test('the notification small icon the reminders use exists in the base resources', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'android-build', 'res', 'drawable', 'ic_stat_quran.xml')) || fs.readdirSync(path.join(ROOT, 'android-build', 'res')).some((d) => d.startsWith('drawable') && fs.readdirSync(path.join(ROOT, 'android-build', 'res', d)).some((f) => f.startsWith('ic_stat_quran'))));
  assert.match(read(path.join(KT, 'reminders', 'ReminderNotifier.kt')), /R\.drawable\.ic_stat_quran/);
});
