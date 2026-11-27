'use strict';
// The build that ends up on the phone. The full build (Kotlin + Room via kapt) used to fail, and the workflow then quietly published the
// SAFE-MODE APK - which has no widgets, no precise alarms and no notification plugins. These tests protect what was done about it:
//   * the versions that must move together (Room < 2.7.0 cannot read the metadata of Kotlin 2.1+)
//   * the fallback ladder: full -> NO-DB (everything but the Room annotation processor) -> SAFE-MODE
//   * a failure that explains itself (the real error on top of the run page, not 60 lines of stack trace)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const wf = read('.github/workflows/build-apk.yml');
const step = (id) => {                                  // the text of the step with this id
  const start = wf.indexOf('id: ' + id);
  assert.ok(start > 0, 'step ' + id + ' exists');
  const next = wf.indexOf('\n      - name:', start);
  return wf.slice(start, next < 0 ? undefined : next);
};

test('Kotlin and Room are a pair that works: Room >= 2.7.0 for Kotlin >= 2.1 (Room 2.6.1 stops with "Provided Metadata instance has version 2.1.0")', () => {
  const cfg = JSON.parse(read('android-build/native/modules.json')).gradle;
  const v = (x) => x.split('.').map(Number);
  const atLeast = (a, b) => { a = v(a); b = v(b); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
  assert.ok(!atLeast(cfg.kotlin, '2.1.0') || atLeast(cfg.room, '2.7.0'), `Kotlin ${cfg.kotlin} with Room ${cfg.room}`);
  assert.equal(cfg.kotlin, '2.2.20', 'the Kotlin version Capacitor 8 recommends itself');
  assert.ok(atLeast(cfg.room, '2.8.0'));
});

test('the fallback ladder: full -> NO-DB (no Room annotation processor) -> SAFE-MODE, each only when the one before did not give an APK', () => {
  assert.match(step('debug_full'), /continue-on-error: true/);
  const nodb = step('debug_nodb');
  assert.match(nodb, /if: env\.DO_DEBUG == 'true' && \(steps\.create_full\.outcome == 'failure' \|\| steps\.debug_full\.outcome == 'failure'\)/);
  assert.match(nodb, /continue-on-error: true/);
  assert.match(nodb, /create-project\.sh nodb/);
  assert.match(nodb, /-debug-NO-DB\.apk/);
  assert.match(nodb, /GOOGLE_SERVICES_JSON: \$\{\{ secrets\.GOOGLE_SERVICES_JSON \}\}/, 'it keeps the push configuration: it is the full app minus the database');
  const safe = step('debug_safe');
  assert.match(safe, /&& steps\.debug_nodb\.outcome != 'success'/, 'the safe build is the LAST resort');
  assert.match(safe, /create-project\.sh safe/);
  assert.ok(wf.indexOf('id: debug_full') < wf.indexOf('id: debug_nodb') && wf.indexOf('id: debug_nodb') < wf.indexOf('id: debug_safe'));
});

test('a fallback never hides the failure: the run is still reported red, with the real error and what each fallback gave', () => {
  const last = wf.slice(wf.indexOf('- name: Mark the run as failed when the full build failed'));
  assert.match(last, /if: always\(\) && \(steps\.create_full\.outcome == 'failure' \|\| steps\.debug_full\.outcome == 'failure'\)/);
  assert.match(last, /gradle-error-summary\.mjs "\$log"/);
  assert.match(last, /gradle-error-summary\.mjs "\$log" --annotations/);
  assert.match(last, /steps\.debug_nodb\.outcome/);
  assert.match(last, /steps\.debug_safe\.outcome/);
  assert.match(last, /exit 1/);
  assert.match(step('create_full'), /tee "\$RUNNER_TEMP\/create-project-full\.log"/, 'a failure while creating the project can be summarised too');
  assert.match(wf, /\$\{\{ runner\.temp \}\}\/create-project-\*\.log/, 'and the logs travel in the build-reports artifact');
});

test('the Release page says what a reduced build lacks (English and Bengali)', () => {
  assert.match(wf, /\*NO-DB\*\) title="\$title NO-DB"; note="NO-DB:[^"]*widgets, precise alarms, reminders and notifications are all included[^"]*উইজেট/);
  assert.match(wf, /\*SAFE-MODE\*\) title="\$title SAFE MODE"; note="SAFE MODE:[^"]*NO home screen widgets, NO precise \(exact\) alarms and NO notification plugins[^"]*উইজেট/);
});

test('create-project.sh knows the nodb mode: a FULL project with QR_NATIVE_DB=off', () => {
  const sh = read('android-build/create-project.sh');
  assert.match(sh, /nodb\) MODE=full; export QR_NATIVE_DB=off ;;/);
  assert.match(sh, /usage: create-project\.sh \[full\|nodb\|safe\]/);
  const syntax = spawnSync('bash', ['-n', path.join(ROOT, 'android-build/create-project.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('the patcher honours QR_NATIVE_DB=off: no kapt plugin, no kapt block, no Room compiler - the Room runtime and Kotlin stay', async () => {
  const m = await import(path.join(ROOT, 'android-build/apply-native-patches.mjs'));
  const gradle = "apply plugin: 'com.android.application'\nandroid {\n    namespace = \"com.x\"\n}\ndependencies {\n}\n";
  const withDb = m.patchAppGradleForKotlin(gradle, { roomVersion: '2.8.4', jvmTarget: 21 }).text;
  const noDb = m.patchAppGradleForKotlin(gradle, { roomVersion: '2.8.4', jvmTarget: 21, kapt: false }).text;
  assert.match(withDb, /kotlin-kapt/); assert.match(withDb, /kapt "androidx\.room:room-compiler:2\.8\.4"/);
  assert.doesNotMatch(noDb, /kotlin-kapt|room-compiler|^kapt\s*\{/m);
  assert.match(noDb, /apply plugin: 'kotlin-android'/); assert.match(noDb, /androidx\.room:room-runtime:2\.8\.4/); assert.match(noDb, /JvmTarget\.JVM_21/);
});

test('the database is optional at run time: the plugin reports a missing database as an error, nothing else depends on it', () => {
  const kt = read('android-build/native/kotlin/com/techverse/quranbangla/bridge/QuranNativePlugin.kt');
  const m = /fun getDatabaseInfo\(call: PluginCall\) \{([\s\S]*?)\n    \}/.exec(kt);
  assert.ok(m);
  assert.match(m[1], /try \{/); assert.match(m[1], /catch \(e: Exception\)/); assert.match(m[1], /call\.reject/);
  const uses = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter((f) => f.endsWith('.kt')).filter((f) => /AppDatabase|\.db\./.test(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'))).map((f) => f.replace(/\\/g, '/'));
  const users = uses('android-build/native/kotlin').filter((f) => !f.includes('/db/'));
  assert.deepEqual(users, ['com/techverse/quranbangla/bridge/QuranNativePlugin.kt'], 'only the bridge touches the database');
});

test('gradle-error-summary.mjs shows the real cause, with a plain-language hint for the failure that was the root cause here', () => {
  const log = [
    '> Task :app:kaptDebugKotlin FAILED',
    'e: [kapt] An exception occurred: java.lang.IllegalArgumentException: Provided Metadata instance has version 2.1.0, while maximum supported version is 2.0.0.',
    '', '* What went wrong:', "Execution failed for task ':app:kaptDebugKotlin'.", '> Kapt failed with exit code 1', '', '* Try:'
  ].join('\n');
  const tmp = path.join(require('node:os').tmpdir(), 'qr-gradle-' + process.pid + '.log');
  fs.writeFileSync(tmp, log);
  try {
    const md = spawnSync('node', [path.join(ROOT, 'android-build/gradle-error-summary.mjs'), tmp], { encoding: 'utf8' }).stdout;
    assert.match(md, /Probable cause:\*\* Room is too old for this Kotlin version/);
    assert.match(md, /gradle\.room/); assert.match(md, /Failed task:\*\* `:app:kaptDebugKotlin`/);
    assert.match(md, /Provided Metadata instance has version 2\.1\.0/);
    const ann = spawnSync('node', [path.join(ROOT, 'android-build/gradle-error-summary.mjs'), tmp, '--annotations'], { encoding: 'utf8' }).stdout;
    assert.match(ann, /^::error title=Full build failed - probable cause::/m);
    const none = spawnSync('node', [path.join(ROOT, 'android-build/gradle-error-summary.mjs'), tmp + '.missing'], { encoding: 'utf8' });
    assert.equal(none.status, 0, 'a missing log never makes it fail'); assert.match(none.stdout, /No log was found/);
  } finally { fs.rmSync(tmp, { force: true }); }
});
