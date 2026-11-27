'use strict';
// The Android side of the three things a person must be able to do: allow notifications, allow precise alarms, add a widget.
// Nothing here runs Android - these are the contracts between the Kotlin plugin, the manifest pieces and the web code that a build
// would only reveal as "the button does nothing" on a phone. (The whole manifest / Gradle result is checked by android-build/self-test.mjs.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NATIVE = 'android-build/native';
const kt = read(NATIVE + '/kotlin/com/techverse/quranbangla/bridge/QuranNativePlugin.kt');
const components = read(NATIVE + '/manifest/components.xml');

test('notifications: the plugin declares POST_NOTIFICATIONS and shows the system dialog on Android 13+', () => {
  assert.match(kt, /@CapacitorPlugin\(\s*name = "QuranNative",\s*[\s\S]*?permissions = \[Permission\(strings = \[Manifest\.permission\.POST_NOTIFICATIONS\], alias = NOTIFICATIONS\)\]/);
  assert.match(kt, /private const val NOTIFICATIONS = "notifications"/, 'a top-level constant: annotation arguments must be compile-time constants');
  assert.match(kt, /fun requestNotificationPermission\(call: PluginCall\)/);
  assert.match(kt, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.TIRAMISU \|\| getPermissionState\(NOTIFICATIONS\) == PermissionState\.GRANTED/, 'older Android and an existing grant answer at once');
  assert.match(kt, /requestPermissionForAlias\(NOTIFICATIONS, call, "notificationPermissionResult"\)/);
});

test('notifications: the callback Capacitor calls after the dialog exists, is public and has the name that was passed', () => {
  assert.match(kt, /@PermissionCallback\s+fun notificationPermissionResult\(call: PluginCall\)/);
  assert.doesNotMatch(kt, /private fun notificationPermissionResult/);
  assert.match(kt, /fun getNotificationPermission\(call: PluginCall\)/);
  // "granted" means notifications can really be shown: the permission AND the switch in the system settings
  assert.match(kt, /NotificationManagerCompat\.from\(context\)\.areNotificationsEnabled\(\)/);
  assert.match(kt, /put\("granted", enabled\)\.put\("state", state\)\.put\("needsRuntimePermission", needsRuntime\)/);
});

test('notifications: POST_NOTIFICATIONS is in the manifest of every build (full and safe)', () => {
  const patch = read('android-build/apply-native-patches.mjs');
  const add = /export const PERMISSIONS_ADD = \[([\s\S]*?)\];/.exec(patch)[1];
  assert.match(add, /android\.permission\.POST_NOTIFICATIONS/);
  const remove = /export const PERMISSIONS_REMOVE = \[([\s\S]*?)\];/.exec(patch)[1];
  assert.doesNotMatch(remove, /POST_NOTIFICATIONS/);
});

test('precise alarms: the manifest of the full build declares SCHEDULE_EXACT_ALARM and nothing removes it there', () => {
  assert.match(read(NATIVE + '/manifest/permissions.txt'), /^android\.permission\.SCHEDULE_EXACT_ALARM$/m);
  const patch = read('android-build/apply-native-patches.mjs');
  assert.match(patch, /permissionsRemove: PERMISSIONS_REMOVE\.filter\(\(p\) => !extra\.includes\(p\)\)/, 'a permission the overlay asks for is not removed again');
  // the permission is removed only from the SAFE build (no reminder engine there, so nothing asks for it)
  assert.match(/export const PERMISSIONS_REMOVE = \[([\s\S]*?)\];/.exec(patch)[1], /SCHEDULE_EXACT_ALARM/);
});

test('precise alarms: the settings page opens with the app package, and falls back to the app details when a phone has no such page', () => {
  assert.match(kt, /Intent\(Settings\.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri\)/);
  assert.match(kt, /val packageUri = Uri\.parse\("package:\$pkg"\)/);
  assert.match(kt, /val appDetails = Intent\(Settings\.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri\)/);
  for (const screen of ['exact-alarms', 'notifications', 'battery']) {
    const block = new RegExp('"' + screen + '" -> \\{([\\s\\S]*?)\\n            \\}').exec(kt);
    assert.ok(block, screen + ' branch found');
    assert.match(block[1], /candidates\.add\(appDetails\)/, screen + ' falls back to the app details page');
  }
  assert.match(kt, /"app" -> candidates\.add\(appDetails\)/);
  assert.match(kt, /for \(intent in candidates\) \{\s*if \(startSettings\(intent\)\)/, 'the first page that opens wins');
  assert.match(kt, /val host = activity\s*\n\s*if \(host != null\) \{\s*host\.startActivity\(intent\)/, 'inside the app task: the back button returns to the app');
});

test('precise alarms: a granted permission is acted on at once (the reminder receiver of the boot / permission-change broadcast)', () => {
  const boot = /<receiver android:name="[^"]*BootReceiver"([\s\S]*?)<\/receiver>/.exec(components);
  assert.ok(boot, 'BootReceiver declared');
  for (const action of ['android.intent.action.BOOT_COMPLETED', 'android.intent.action.MY_PACKAGE_REPLACED', 'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED', 'android.intent.action.TIMEZONE_CHANGED']) {
    assert.ok(boot[1].includes(action), 'BootReceiver listens to ' + action);
  }
  assert.match(components, /<receiver android:name="[^"]*ReminderReceiver"[^>]*android:exported="false"/, 'the alarm receiver is private to the app');
});

test('widgets: every widget has a receiver, the provider description and a layout - the three things the launcher needs to list it', () => {
  const keys = ['NextPrayerWidget', 'DailyAyahWidget', 'ContinueReadingWidget', 'QuickActionsWidget', 'ReminderStatusWidget'];
  const withBody = components.replace(/<receiver[^>]*\/>/g, '');          // self-closing receivers (the tick receiver) have no intent filter
  const receivers = [...withBody.matchAll(/<receiver android:name="[^"]*widgets\.(\w+)"([\s\S]*?)<\/receiver>/g)];
  assert.deepEqual(receivers.map((m) => m[1]).sort(), keys.slice().sort());
  for (const [, name, body] of receivers) {
    assert.match(body, /<action android:name="android\.appwidget\.action\.APPWIDGET_UPDATE"\s*\/>/, name + ' listens to APPWIDGET_UPDATE');
    const res = /android:name="android\.appwidget\.provider"\s+android:resource="@xml\/(\w+)"/.exec(body);
    assert.ok(res, name + ' has the appwidget.provider meta-data');
    const xml = read(NATIVE + '/res/xml/' + res[1] + '.xml');
    assert.match(xml, /<appwidget-provider/);
    const layout = /android:initialLayout="@layout\/(\w+)"/.exec(xml);
    assert.ok(layout, name + ' declares an initial layout');
    assert.ok(fs.existsSync(path.join(ROOT, NATIVE + '/res/layout/' + layout[1] + '.xml')), 'layout ' + layout[1] + ' exists');
    assert.match(xml, /android:minWidth="\d+dp"/); assert.match(xml, /android:minHeight="\d+dp"/);
    assert.match(xml, /android:widgetCategory="home_screen"/, name + ' is for the home screen');
  }
});

test('widgets: the layouts use only views a RemoteViews can inflate (anything else shows "Problem loading widget")', () => {
  const allowed = new Set(['FrameLayout', 'LinearLayout', 'RelativeLayout', 'GridLayout', 'AnalogClock', 'Button', 'Chronometer', 'ImageButton', 'ImageView', 'ProgressBar', 'TextClock', 'TextView', 'ViewFlipper', 'ListView', 'GridView', 'StackView', 'AdapterViewFlipper', 'ViewStub']);
  const dir = path.join(ROOT, NATIVE, 'res/layout');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/<([A-Za-z][\w.]*)[\s>]/g)) {
      assert.ok(allowed.has(m[1]), f + ' uses <' + m[1] + '>, which a widget cannot show');
    }
  }
});

test('widgets: adding from inside the app asks the launcher only on Android 8+, and every receiver is private to the system', () => {
  assert.match(kt, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.O/);
  assert.match(kt, /manager\.isRequestPinAppWidgetSupported/);
  // a widget provider is called by the system (system uid), so it does not have to be exported; the template of Android Studio does the same
  for (const m of components.matchAll(/<receiver android:name="[^"]*widgets\.\w+"([^>]*)>/g)) assert.match(m[1], /android:exported="false"/);
});
