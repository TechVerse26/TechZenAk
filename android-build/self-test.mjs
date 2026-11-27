#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/self-test.mjs  -  checks apply-native-patches.mjs against a hand-made imitation of the project that
// `npx cap add android` generates. Runs in about a second, needs only Node.js, and is the first step of the
// "Build APK" workflow so a broken patch script is reported before any slow download starts.
//
// IMPORTANT: this is an imitation of the Capacitor template written from its documented layout. It catches mistakes in
// the patch logic (bad XML, duplicate permissions, wrong Gradle text, missing resources); it cannot prove that the real
// Capacitor 8 template and Gradle accept the result - only the real build does that.
//
//   node android-build/self-test.mjs
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseBadging, classifyPermissions, parseApksigner, parseManifestTree, assetlinksJson, formatFingerprint, isDebugCertificate, renderMarkdown,
  readSigningBlockCertificates, signerFromApk, parseSigningReport
} from './audit-apk.mjs';
import {
  checkXml, decodePng, cornerColor, patchManifestText, groovyBlock, ktsBlock, installWebBundle, patchRootGradleForKotlin, patchAppGradleForKotlin, patchGradleProperties, detectJvmTarget, addNativeComponents, nativePermissions, readNativeConfig, NATIVE_MARK,
  findUnresolvedRefs, PERMISSIONS_ADD, PERMISSIONS_REMOVE, MARK, userAgentToken, FCM_FLAG, summaryMarkdown
} from './apply-native-patches.mjs';
import { checkStandalone, readZipIndex, readZipEntry } from './apk-bundle-check.mjs';
import { lintNative } from './native-lint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// public certificate of android-build/debug.keystore (the stable debug key) - used only to test the APK signing-block reader
const REPO_KEY_SHA256 = 'B0:88:DB:33:E6:86:13:A4:06:3F:77:3A:2C:81:6B:76:FC:71:51:E2:E9:5F:C8:4F:3D:72:2D:13:DE:62:EF:2E';
const REPO_KEY_CERT_B64 = 'MIIDFDCCAfygAwIBAgIJAIHmzurXqTxKMA0GCSqGSIb3DQEBCwUAMDcxCzAJBgNVBAYTAlVTMRAwDgYDVQQKEwdBbmRyb2lkMRYwFAYDVQQDEw1BbmRyb2lkIERlYnVnMCAXDTI2MTEwNzE1NTUyM1oYDzIwNTQwMzI1MTU1NTIzWjA3MQswCQYDVQQGEwJVUzEQMA4GA1UEChMHQW5kcm9pZDEWMBQGA1UEAxMNQW5kcm9pZCBEZWJ1ZzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMSowL/1VEWsiBfUqfY4vhRUG4FphYb2SQ9YeXiYdu6APAZ1N8u8e4+MwzVd9aXBmHbDrv1fbUWj7q5uDdF0Qpmb6EssB4wyo4SI9MMlnbhFHYb0/MKnFaa6BpmrvtRNCSJArqgnhbtWIJG6YCkjaiwjxyRKzIYqV3PlIalaZ0evR7ejetpNZlTUqFXZ3IHiiD7yFu9w+UZRfgHixlZCxo0uDUK8GDQ+n7eY8KyYM+lvHMLTJJzx5xnqKI6cqbAaxhv6aWcSASkeqIfwBrt89DTwNorRShX1zNHq6Ur9ODSbLfLMSoc6Ez5Ahey8EzByrURjkHQqu9UZgEwceBvNDGUCAwEAAaMhMB8wHQYDVR0OBBYEFLM1E270deIqw5SesT+WkvWG0BopMA0GCSqGSIb3DQEBCwUAA4IBAQANRoy2TcIr7f1ZoAfXuuygOeCIxkJdp6VC2JkBWQ7s4Gvpo2Gdh8YmuNMdeP46Mtcfl0XevlHjLLqQZJpixfa2G0N0URcG/OMbFwSaoFxGaRyE5J6p4UHAyVU2mqMY9/VLN9re1wq0tn6i3Q3BrLu1Xcizx5SLzNnZtCO39lzWC/torugonZgFYjijBw6mKFmKPDCvBuB6FR7eCw3A/y9mVOFHWhNa5dd2sZQFHhC85n6Uhr8MKgVnwmZiltOJDb7mxFGdYi9rmxWqP4mCKm10d/Mssp/7PsbxgF7I91pc+BgdLG+FViYVgrnuvMzO1HfUUxOI7/sD3KNktZ+Hes68';
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'apply-native-patches.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-selftest-'));
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail ? ' -> ' + detail : ''));
}
function eq(name, a, b) { check(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);
const count = (s, sub) => s.split(sub).length - 1;

// ------------------------------------------------------------------------------------------------ fixture builders
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// RGBA PNG; pixel(x, y) -> [r, g, b, a]; filter type alternates so the decoder's filters are exercised
function makePng(w, h, pixel, filters = [0, 1, 2, 3, 4]) {
  const rows = [];
  const prevRaw = [];
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) { const p = pixel(x, y); raw[x * 4] = p[0]; raw[x * 4 + 1] = p[1]; raw[x * 4 + 2] = p[2]; raw[x * 4 + 3] = p[3]; }
    const ft = filters[y % filters.length];
    const out = Buffer.alloc(w * 4 + 1);
    out[0] = ft;
    const prev = y > 0 ? prevRaw[y - 1] : null;
    for (let x = 0; x < w * 4; x++) {
      const a = x >= 4 ? raw[x - 4] : 0, b = prev ? prev[x] : 0, c = prev && x >= 4 ? prev[x - 4] : 0;
      let pred = 0;
      if (ft === 1) pred = a; else if (ft === 2) pred = b; else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x + 1] = (raw[x] - pred) & 255;
    }
    prevRaw.push(raw);
    rows.push(out);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}
const GREEN = [20, 64, 22, 255];

const MANIFEST_STANDARD = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;
const GRADLE_GROOVY = `apply plugin: 'com.android.application'

android {
    namespace = "com.techverse.quranbangla"
    compileSdk = rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "com.techverse.quranbangla"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
        aaptOptions {
             // Files and dirs to omit from the packaged assets dir, modified to accommodate modern web apps.
            ignoreAssetsPattern = '!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~'
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

repositories {
    flatDir{
        dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'
    }
}

dependencies {
    implementation fileTree(include: ['*.jar'], dir: 'libs')
    implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"
    implementation project(':capacitor-android')
    implementation project(':capacitor-cordova-android-plugins')
}

apply from: 'capacitor.build.gradle'

try {
    def servicesJSON = file('google-services.json')
    if (servicesJSON.text) {
        apply plugin: 'com.google.gms.google-services'
    }
} catch(Exception e) {
    logger.info("google-services.json not found, google-services plugin not applied. Push Notifications won't work")
}
`;
const GRADLE_KTS = `plugins { id("com.android.application") }

android {
    namespace = "com.techverse.quranbangla"
    defaultConfig {
        applicationId = "com.techverse.quranbangla"
        versionCode = 1
        versionName = "1.0"
    }
}
`;
const VARIABLES_GRADLE = `ext {
    minSdkVersion = 24
    compileSdkVersion = 36
    targetSdkVersion = 36
    androidxAppCompatVersion = '1.7.1'
    coreSplashScreenVersion = '1.2.0'
}
`;
const ROOT_GRADLE = `buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.13.0'
        classpath 'com.google.gms:google-services:4.4.4'
    }
}
apply from: "variables.gradle"
`;
const STYLES = `<?xml version="1.0" encoding="utf-8" ?>
<resources>

    <!-- Base application theme. -->
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.DarkActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
    </style>

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
    </style>

    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>
`;
const ADAPTIVE_OLD = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;

function makeProject(name, opts = {}) {
  const root = path.join(TMP, name);
  const app = path.join(root, 'android', 'app');
  const main = path.join(app, 'src', 'main');
  const res = path.join(main, 'res');
  const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  let manifest = opts.manifest || MANIFEST_STANDARD;
  if (opts.crlf) manifest = manifest.replace(/\n/g, '\r\n');
  put(path.join(main, 'AndroidManifest.xml'), manifest);
  if (opts.kts) put(path.join(app, 'build.gradle.kts'), GRADLE_KTS); else put(path.join(app, 'build.gradle'), opts.gradle || GRADLE_GROOVY);
  put(path.join(root, 'android', 'variables.gradle'), opts.variables || VARIABLES_GRADLE);
  put(path.join(root, 'android', 'build.gradle'), opts.rootGradle || ROOT_GRADLE);
  // the other files `cap add android` generates (Capacitor 8): the untouched MainActivity, gradle.properties and capacitor.build.gradle
  if (!opts.noMainActivity) put(path.join(main, 'java', 'com', 'techverse', 'quranbangla', 'MainActivity.java'), opts.mainActivity || 'package com.techverse.quranbangla;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n');
  put(path.join(root, 'android', 'gradle.properties'), opts.gradleProperties || '# Project-wide Gradle settings.\norg.gradle.jvmargs=-Xmx1536m\nandroid.useAndroidX=true\n');
  put(path.join(app, 'capacitor.build.gradle'), '// DO NOT EDIT THIS FILE! IT IS GENERATED EACH TIME "capacitor update" IS RUN\n\nandroid {\n  compileOptions {\n      sourceCompatibility JavaVersion.VERSION_21\n      targetCompatibility JavaVersion.VERSION_21\n  }\n}\n\napply from: "../capacitor-cordova-android-plugins/cordova.variables.gradle"\ndependencies {\n}\n');
  // the config phase writes <project>/capacitor.config.json and `cap add android` copies it into the Android assets
  const capConfig = JSON.stringify({ appId: 'com.techverse.quranbangla', appName: 'Quran Bangla', webDir: 'www', server: { androidScheme: 'https', cleartext: false }, android: { appendUserAgent: userAgentToken('1.1.0', '123') }, plugins: {} }, null, 2) + '\n';
  put(path.join(root, 'capacitor.config.json'), capConfig);
  if (!opts.noAssetsConfig) put(path.join(main, 'assets', 'capacitor.config.json'), capConfig);
  if (!opts.noStyles) put(path.join(res, 'values', 'styles.xml'), opts.styles || STYLES);
  put(path.join(res, 'values', 'strings.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">Quran Bangla</string>\n    <string name="title_activity_main">Quran Bangla</string>\n</resources>\n');
  put(path.join(res, 'values', 'ic_launcher_background.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n');
  put(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), ADAPTIVE_OLD);
  put(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), ADAPTIVE_OLD);
  const dummy = makePng(4, 4, () => [255, 255, 255, 255]);
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      fs.mkdirSync(path.join(res, 'mipmap-' + d), { recursive: true });
      fs.writeFileSync(path.join(res, 'mipmap-' + d, f), dummy);
    }
  }
  return root;
}

// A minimal but valid web bundle - what scripts/web/build-web.mjs produces: the files plus bundle-manifest.json with real sizes and SHA-256.
function makeBundle(dir, { standalone = true } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  const files = {
    'index.html': standalone
      ? '<!doctype html><html><head><meta charset="utf-8"><script>window.QR_STANDALONE={"siteUrl":"https://quranbangla.vercel.app"};</script></head><body></body></html>'
      : '<!doctype html><html><head></head><body>the website</body></html>',
    'js/app.js': 'console.log("app");',
    'data/quran/manifest.json': '{"schema":1,"counts":{"surahs":114,"ayahs":6236},"editions":["quran-uthmani","bn.bengali"]}'
  };
  const listed = {};
  for (const [rel, text] of Object.entries(files)) {
    const buf = Buffer.from(text);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), buf);
    listed[rel] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }
  fs.writeFileSync(path.join(dir, 'bundle-manifest.json'), JSON.stringify({ schema: 1, bundleId: 'selftest', bundleSha256: 'a'.repeat(64), files: listed }));
  return dir;
}
const BUNDLE = makeBundle(path.join(TMP, 'bundle'));

function envFor(extra = {}) {
  const e = { PATH: process.env.PATH, APP_ID: 'com.techverse.quranbangla', APP_NAME: 'Quran Bangla', APP_VERSION: '1.1.0', APP_VERSION_CODE: '123', SITE_URL: 'https://quranbangla.vercel.app', WEB_BUNDLE_DIR: BUNDLE, QR_NATIVE_MODULES: 'none' };
  return Object.assign(e, extra);
}
function run(phase, project, { mode = 'full', repo = REPO, env = {}, args = [] } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, phase, '--mode', mode, '--project', project, '--repo', repo, ...args], { env: envFor(env), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function xmllint(file) {
  const r = spawnSync('xmllint', ['--noout', file], { encoding: 'utf8' });
  if (r.error) return null; // xmllint not installed
  return r.status === 0 ? '' : r.stderr;
}

// ------------------------------------------------------------------------------------------------------ 1. checkXml
{
  eq('checkXml accepts the Capacitor manifest', checkXml(MANIFEST_STANDARD), null);
  check('checkXml: unclosed tag', checkXml('<a><b></a>') !== null);
  check('checkXml: mismatched tag', checkXml('<a></b>') !== null);
  check('checkXml: duplicate attribute', /duplicate/.test(checkXml('<a x="1" x="2"/>') || ''));
  check('checkXml: bare ampersand', checkXml('<a>fish & chips</a>') !== null);
  eq('checkXml: escaped ampersand', checkXml('<a b="x &amp; y">&lt;ok&gt;</a>'), null);
  check('checkXml: two roots', checkXml('<a/><b/>') !== null);
  check('checkXml: unterminated comment', checkXml('<a><!-- x</a>') !== null);
  check('checkXml: double hyphen in comment', checkXml('<a><!-- a -- b --></a>') !== null);
  check('checkXml: unquoted attribute', checkXml('<a b=1/>') !== null);
  eq('checkXml: CDATA + PI', checkXml('<?xml version="1.0"?><a><![CDATA[<x>&]]></a>'), null);
}

// -------------------------------------------------------------------------------------------------------- 2. PNG
{
  const png = makePng(40, 40, (x, y) => (x < 8 && y < 8) || (x > 31 && y < 8) || (x < 8 && y > 31) || (x > 31 && y > 31) ? GREEN : [200, 200, 0, 255]);
  const d = decodePng(png);
  eq('decodePng width', d.width, 40);
  eq('decodePng corner pixel', Array.from(d.data.subarray(0, 4)).join(','), GREEN.join(','));
  eq('decodePng centre pixel', Array.from(d.data.subarray((20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 4)).join(','), '200,200,0,255');
  eq('cornerColor', cornerColor(d), '#144016');
  check('decodePng rejects garbage', (() => { try { decodePng(Buffer.from('nope')); return false; } catch (e) { return true; } })());
  // the real maskable icon of the project
  const real = path.join(REPO, 'icons', 'icon-512-maskable.png');
  if (exists(real)) {
    const c = cornerColor(decodePng(fs.readFileSync(real)));
    check('real maskable icon corner colour is a hex colour', /^#[0-9A-F]{6}$/.test(c), c);
  }
}

// ----------------------------------------------------------------------------------------- 3. patchManifestText (pure)
{
  const r = patchManifestText(MANIFEST_STANDARD, { host: 'quranbangla.vercel.app' });
  const t = r.text;
  eq('manifest well-formed', checkXml(t), null);
  check('manifest marker', t.includes(MARK));
  check('tools namespace added once', count(t, 'xmlns:tools=') === 1);
  for (const p of PERMISSIONS_ADD) eq('permission once: ' + p, count(t, '"' + p + '"'), 1);
  for (const p of PERMISSIONS_REMOVE) check('permission blocked: ' + p, t.includes('"' + p + '" tools:node="remove"'));
  eq('INTERNET not duplicated', count(t, 'android.permission.INTERNET'), 1);
  check('allowBackup false', /android:allowBackup="false"/.test(t) && !/android:allowBackup="true"/.test(t));
  check('tools:replace allowBackup', /tools:replace="android:allowBackup"/.test(t));
  check('app link filter', t.includes('<intent-filter android:autoVerify="true">') && t.includes('android:host="quranbangla.vercel.app" android:path="/"') && t.includes('android:path="/index.html"'));
  check('custom scheme filter', t.includes('<data android:scheme="quranbangla" />'));
  check('shortcuts meta', t.includes('android:name="android.app.shortcuts" android:resource="@xml/shortcuts"'));
  for (const n of ['default_notification_icon', 'default_notification_color', 'default_notification_channel_id']) check('fcm meta ' + n, t.includes('com.google.firebase.messaging.' + n));
  check('launcher activity keeps launchMode + exported', /android:launchMode="singleTask"/.test(t) && /android:exported="true"/.test(t));
  check('autoVerify filter has no custom scheme', !/autoVerify[\s\S]{0,400}scheme="quranbangla"[\s\S]{0,40}<\/intent-filter>/.test(t.split('</intent-filter>')[1] || ''));
  check('provider untouched', t.includes('androidx.core.content.FileProvider') && t.includes('${applicationId}.fileprovider'));
  const again = patchManifestText(t, { host: 'quranbangla.vercel.app' });
  check('manifest patch is idempotent', again.changed === false && again.text === t);
  const lx = xmllint; // eslint-disable-line no-unused-vars
  // existing permissions are never declared twice
  const pre = MANIFEST_STANDARD.replace('<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.VIBRATE" />\n    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />');
  const r2 = patchManifestText(pre, { host: 'quranbangla.vercel.app' });
  eq('VIBRATE not duplicated', count(r2.text, 'android.permission.VIBRATE'), 1);
  eq('ACCESS_NETWORK_STATE not duplicated', count(r2.text, 'android.permission.ACCESS_NETWORK_STATE'), 1);
  eq('r2 well-formed', checkXml(r2.text), null);
  // a forbidden permission already written into the generated manifest becomes a removal marker (no duplicate element)
  const bad = MANIFEST_STANDARD.replace('<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />');
  const r3 = patchManifestText(bad, { host: 'quranbangla.vercel.app' });
  eq('forbidden permission appears once', count(r3.text, 'android.permission.WRITE_EXTERNAL_STORAGE'), 1);
  check('forbidden permission is marked remove', /WRITE_EXTERNAL_STORAGE" tools:node="remove"/.test(r3.text));
  eq('r3 well-formed', checkXml(r3.text), null);
  // tools already declared, activity without launchMode/exported, CRLF
  const odd = MANIFEST_STANDARD.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">', '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools" package="com.techverse.quranbangla">')
    .replace('android:launchMode="singleTask"\n            android:exported="true">', '>').replace(/\n/g, '\r\n');
  const r4 = patchManifestText(odd, { host: 'quranbangla.vercel.app' });
  eq('xmlns:tools not duplicated', count(r4.text, 'xmlns:tools='), 1);
  check('launchMode added', /android:launchMode="singleTask"/.test(r4.text));
  check('exported added', /android:exported="true"/.test(r4.text));
  eq('r4 well-formed', checkXml(r4.text), null);
  check('manifest without launcher activity is rejected', (() => { try { patchManifestText(MANIFEST_STANDARD.replace('android.intent.category.LAUNCHER', 'android.intent.category.INFO'), { host: 'a.b' }); return false; } catch (e) { return /launcher activity/.test(e.message); } })());
  check('invalid host is rejected', (() => { try { patchManifestText(MANIFEST_STANDARD, { host: 'a b"><x' }); return false; } catch (e) { return /host/.test(e.message); } })());
  // the site is optional now: without a host there is no https App Link filter, everything else stays
  const nh = patchManifestText(MANIFEST_STANDARD, { host: '' });
  check('without a site host: no https App Link filter', !/android:scheme="https"/.test(nh.text) && !/autoVerify/.test(nh.text));
  check('without a site host: quranbangla:// links and shortcuts remain', nh.text.includes('android:scheme="quranbangla"') && nh.text.includes('@xml/shortcuts'));
  eq('without a site host: still well-formed', checkXml(nh.text), null);
  check('without a site host: the comment does not promise website links', !/links to the website/.test(nh.text));
}

// ------------------------------------------------------------------------------------------ 4. config phase (full / safe)
{
  const full = path.join(TMP, 'cfg-full');
  const r = run('config', full);
  eq('config full exit code', r.code, 0, r.out);
  const cfg = JSON.parse(read(path.join(full, 'capacitor.config.json')));
  eq('cfg appId', cfg.appId, 'com.techverse.quranbangla');
  check('cfg has NO server.url - the app runs from its own bundle', !('url' in cfg.server) && !JSON.stringify(cfg).includes('quranbangla.vercel.app'));
  eq('cfg androidScheme', cfg.server.androidScheme, 'https');
  eq('cfg cleartext off', cfg.server.cleartext, false);
  check('cfg has no errorPath (nothing is loaded from the network at start)', !('errorPath' in cfg.server));
  eq('cfg webDir', cfg.webDir, 'www');
  eq('cfg user agent token', cfg.android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  eq('cfg insets', cfg.plugins.SystemBars.insetsHandling, 'disable');
  eq('cfg system bars style (dark theme)', cfg.plugins.SystemBars.style, 'DARK');
  eq('cfg edge-to-edge colour', cfg.plugins.EdgeToEdge.backgroundColor, '#092723');
  eq('cfg splash autohide', cfg.plugins.SplashScreen.launchAutoHide, true);
  eq('cfg splash resource', cfg.plugins.SplashScreen.androidSplashResourceName, 'qr_splash');
  eq('cfg notification icon', cfg.plugins.LocalNotifications.smallIcon, 'ic_stat_quran');
  check('www/index.html is the standalone page', read(path.join(full, 'www', 'index.html')).includes('window.QR_STANDALONE'));
  check('www carries the verified bundle (files + bundle-manifest.json)', exists(path.join(full, 'www', 'js', 'app.js')) && exists(path.join(full, 'www', 'bundle-manifest.json')) && exists(path.join(full, 'www', 'data', 'quran', 'manifest.json')));
  check('no error.html and no placeholder page any more', !exists(path.join(full, 'www', 'error.html')));
  check('config output says what it did', /bundled web app \(no server\.url\)/.test(r.out) && /verified against bundle-manifest\.json/.test(r.out), r.out);
  const safe = path.join(TMP, 'cfg-safe');
  const rs = run('config', safe, { mode: 'safe' });
  eq('config safe exit code', rs.code, 0);
  const cs = JSON.parse(read(path.join(safe, 'capacitor.config.json')));
  check('safe config has no errorPath / splash / notification plugin keys', !cs.server.errorPath && !cs.plugins.SplashScreen && !cs.plugins.LocalNotifications);
  check('safe config: bundled app (no server.url), https scheme, edge-to-edge kept', !('url' in cs.server) && cs.server.androidScheme === 'https' && cs.plugins.EdgeToEdge.backgroundColor === '#092723');
  check('safe mode ships the same verified bundle', exists(path.join(safe, 'www', 'bundle-manifest.json')) && !exists(path.join(safe, 'www', 'error.html')));
  // settings validation
  for (const [label, env] of [
    ['APP_ID invalid', { APP_ID: 'not an id' }], ['APP_ID single segment', { APP_ID: 'quran' }], ['version code text', { APP_VERSION_CODE: 'abc' }],
    ['version code zero', { APP_VERSION_CODE: '0' }], ['version code huge', { APP_VERSION_CODE: '2200000000' }], ['version name quote', { APP_VERSION: '1.0"; evil' }],
    ['http site url', { SITE_URL: 'http://quranbangla.vercel.app' }], ['site url is not a url', { SITE_URL: 'not a url' }], ['empty app name', { APP_NAME: '' }]
  ]) {
    const rr = run('config', path.join(TMP, 'cfg-bad'), { env });
    check('rejects: ' + label, rr.code === 1 && /ERROR/.test(rr.out), rr.out);
  }
  // the site address is optional (hosted backend + App Links only); its old name LIVE_URL still works
  const noSite = run('config', path.join(TMP, 'cfg-nosite'), { env: { SITE_URL: '' } });
  eq('an empty SITE_URL is accepted (the app does not need the website)', noSite.code, 0, noSite.out);
  const legacy = run('config', path.join(TMP, 'cfg-legacy'), { env: { SITE_URL: '', LIVE_URL: 'https://quranbangla.vercel.app' } });
  eq('the old LIVE_URL name is still accepted', legacy.code, 0, legacy.out);
  const badLegacy = run('config', path.join(TMP, 'cfg-legacy-bad'), { env: { SITE_URL: '', LIVE_URL: 'http://quranbangla.vercel.app' } });
  check('... and validated like SITE_URL', badLegacy.code === 1 && /SITE_URL must start with https/.test(badLegacy.out), badLegacy.out);
}

// ------------------------------------------------------------------------------------------ 4b. the web bundle (www/)
{
  const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
  const dst = path.join(TMP, 'b-dst');
  const ok = makeBundle(path.join(TMP, 'b-ok'));
  const r = installWebBundle(ok, dst);
  eq('installWebBundle: number of files', r.files, 3);
  eq('installWebBundle: bundle id', r.bundleId, 'selftest');
  check('installWebBundle: every file is copied unchanged', ['index.html', 'js/app.js', 'data/quran/manifest.json', 'bundle-manifest.json'].every((f) => read(path.join(ok, f)) === read(path.join(dst, f))));
  fs.writeFileSync(path.join(dst, 'old-leftover.txt'), 'x');
  installWebBundle(ok, dst);
  check('installWebBundle: a leftover from an earlier run is removed', !exists(path.join(dst, 'old-leftover.txt')));
  check('a missing bundle is refused, with the command that makes it', throwsWith(() => installWebBundle(path.join(TMP, 'nope'), dst), /node scripts\/web\/build-web\.mjs/));
  const t1 = makeBundle(path.join(TMP, 'b-t1'));
  fs.writeFileSync(path.join(t1, 'js', 'app.js'), 'console.log("evil");');
  check('a file changed after the build is refused', throwsWith(() => installWebBundle(t1, dst), /js\/app\.js differs from bundle-manifest/));
  const t2 = makeBundle(path.join(TMP, 'b-t2'));
  fs.writeFileSync(path.join(t2, 'extra.js'), 'x');
  check('a file that is not in the manifest is refused (it would ship unchecked)', throwsWith(() => installWebBundle(t2, dst), /not in bundle-manifest\.json/));
  const t3 = makeBundle(path.join(TMP, 'b-t3'));
  fs.rmSync(path.join(t3, 'js', 'app.js'));
  check('a listed file that is missing is refused', throwsWith(() => installWebBundle(t3, dst), /js\/app\.js is listed in bundle-manifest\.json but missing/));
  const t4 = makeBundle(path.join(TMP, 'b-t4'), { standalone: false });
  check('a plain website index.html is refused (it would load the website)', throwsWith(() => installWebBundle(t4, dst), /not the standalone page/));
  const t5 = makeBundle(path.join(TMP, 'b-t5'));
  const m5 = JSON.parse(read(path.join(t5, 'bundle-manifest.json')));
  m5.files['../evil.txt'] = { bytes: 1, sha256: '0'.repeat(64) };
  fs.writeFileSync(path.join(t5, 'bundle-manifest.json'), JSON.stringify(m5));
  check('a manifest path that leaves the folder is refused', throwsWith(() => installWebBundle(t5, dst), /unsafe path/));
  const t6 = makeBundle(path.join(TMP, 'b-t6'));
  fs.writeFileSync(path.join(t6, 'bundle-manifest.json'), '{ not json');
  check('a broken manifest is refused', throwsWith(() => installWebBundle(t6, dst), /not valid JSON/));
  const t7 = makeBundle(path.join(TMP, 'b-t7'));
  fs.writeFileSync(path.join(t7, 'bundle-manifest.json'), JSON.stringify({ schema: 2, files: {} }));
  check('an unknown manifest format is refused', throwsWith(() => installWebBundle(t7, dst), /unsupported format/));
  // the same guarantees through the command line (what the workflow runs)
  const none = run('config', path.join(TMP, 'cfg-nobundle'), { env: { WEB_BUNDLE_DIR: path.join(TMP, 'no-such-bundle') } });
  check('config phase stops clearly when there is no bundle', none.code === 1 && /web bundle is missing/.test(none.out), none.out);
  const tampered = run('config', path.join(TMP, 'cfg-tampered'), { env: { WEB_BUNDLE_DIR: t1 } });
  check('config phase refuses a tampered bundle', tampered.code === 1 && /differs from bundle-manifest/.test(tampered.out), tampered.out);
}

// ------------------------------------------------------------------------------------------------ 5. android phase full
{
  const proj = makeProject('full');
  const r = run('android', proj, { env: { GOOGLE_SERVICES_JSON: '' } });
  eq('android full exit code', r.code, 0, r.out);
  check('android full warns about missing google-services', /GOOGLE_SERVICES_JSON secret is not set/.test(r.out));
  const manifestFile = path.join(proj, 'android/app/src/main/AndroidManifest.xml');
  const manifest = read(manifestFile);
  eq('manifest well-formed (file)', checkXml(manifest), null);
  const lint = xmllint(manifestFile);
  check('xmllint accepts the manifest', lint === null || lint === '', lint);
  check('manifest has no CRLF', !manifest.includes('\r'));
  check('manifest permissions present', PERMISSIONS_ADD.every((p) => manifest.includes(p)));
  const gradle = read(path.join(proj, 'android/app/build.gradle'));
  check('gradle block present once', count(gradle, MARK) === 1);
  check('gradle versionCode', gradle.includes('versionCode = 123') && gradle.includes('versionName = "1.1.0"'));
  check('gradle signing from env', gradle.includes("System.getenv('QR_KEYSTORE_PATH')") && gradle.includes("signingConfigs.getByName('qrRelease')"));
  check('gradle: original google-services block untouched', gradle.includes("apply plugin: 'com.google.gms.google-services'") && gradle.includes('apply from: \'capacitor.build.gradle\''));
  // the only literal password allowed is the public debug-key default "android"; anything else would be a leaked secret
  check('gradle: no secrets or paths written', !/password\s*=\s*['"](?!android['"])[^'"]+['"]/i.test(gradle));
  check('gradle: fixed debug key wired to the environment', gradle.includes("System.getenv('QR_DEBUG_KEYSTORE_PATH')") && gradle.includes("keyAlias = 'androiddebugkey'"));
  const res = path.join(proj, 'android/app/src/main/res');
  const shortcuts = read(path.join(res, 'xml/shortcuts.xml'));
  check('shortcuts: app id substituted', !shortcuts.includes('__APP_ID__') && shortcuts.includes('android:targetClass="com.techverse.quranbangla.MainActivity"'));
  eq('shortcuts well-formed', checkXml(shortcuts), null);
  for (const f of ['drawable/ic_stat_quran.xml', 'drawable/ic_shortcut_continue.xml', 'drawable/ic_shortcut_search.xml', 'drawable/ic_shortcut_prayer.xml', 'drawable/ic_shortcut_qibla.xml', 'values/qr_strings.xml', 'values-bn/qr_strings.xml', 'values/qr_colors.xml']) check('resource copied: ' + f, exists(path.join(res, f)));
  const theme = read(path.join(res, 'values/qr_theme.xml'));
  check('theme colours', theme.includes('name="qr_splash_background">#092723<') && /name="qr_icon_background">#[0-9A-F]{6}</.test(theme));
  eq('theme well-formed', checkXml(theme), null);
  const adaptive = read(path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'));
  check('adaptive icon written', adaptive.includes('@color/qr_icon_background') && adaptive.includes('@drawable/qr_icon_foreground_inset'));
  check('round icon equals adaptive icon', adaptive === read(path.join(res, 'mipmap-anydpi-v26/ic_launcher_round.xml')));
  check('foreground png copied', exists(path.join(res, 'drawable-nodpi/qr_icon_foreground.png')) && exists(path.join(res, 'drawable-nodpi/qr_splash_icon.png')));
  check('splash drawable written', exists(path.join(res, 'drawable/qr_splash.xml')));
  const legacy = fs.readFileSync(path.join(res, 'mipmap-xxxhdpi/ic_launcher.png'));
  check('legacy launcher PNG replaced by the project icon', legacy.length > 1000, String(legacy.length));
  const styles = read(path.join(res, 'values/styles.xml'));
  check('splash theme patched once', count(styles, 'windowSplashScreenBackground') === 1 && styles.includes('@color/qr_splash_background'));
  eq('styles well-formed', checkXml(styles), null);
  for (const f of ['drawable/qr_icon_foreground_inset.xml', 'drawable/qr_splash.xml', 'mipmap-anydpi-v26/ic_launcher.xml']) eq('well-formed ' + f, checkXml(read(path.join(res, f))), null);
  check('no unresolved references in files created by the script', findUnresolvedRefs([manifestFile, path.join(res, 'xml/shortcuts.xml'), path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), path.join(res, 'drawable/qr_splash.xml'), path.join(res, 'drawable/qr_icon_foreground_inset.xml')], res).filter((x) => /qr_|ic_stat|ic_shortcut|shortcuts/.test(x)).length === 0);
  check('report written', exists(path.join(proj, 'qr-patch-report.android.json')));
  // without a Firebase configuration the app must NOT be told that push is available (register() would crash it)
  const noFcmCfg = JSON.parse(read(path.join(proj, 'android/app/src/main/assets/capacitor.config.json')));
  eq('no secret -> user agent has no fcm flag', noFcmCfg.android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  const noFcmReport = JSON.parse(read(path.join(proj, 'qr-patch-report.android.json')));
  check('no secret -> report says fcm is off', noFcmReport.fcm === false && !noFcmReport.fcmFlag);
  check('no secret -> summary says push is NOT enabled', /Push notifications \(Firebase Cloud Messaging\): \*\*NOT enabled/.test(summaryMarkdown(noFcmReport)));
  // second run changes nothing
  const snapshot = [manifestFile, path.join(proj, 'android/app/build.gradle'), path.join(res, 'values/styles.xml')].map(read);
  const r2 = run('android', proj, { env: { GOOGLE_SERVICES_JSON: '' } });
  eq('android full second run exit code', r2.code, 0, r2.out);
  const after = [manifestFile, path.join(proj, 'android/app/build.gradle'), path.join(res, 'values/styles.xml')].map(read);
  check('android patches are idempotent', snapshot.every((s, i) => s === after[i]));
}

// ---------------------------------------------------------------------------------------- 6. google-services.json handling
{
  const fake = (pkg, project = 'quranfreeapps') => JSON.stringify({ project_info: { project_number: '421704127278', project_id: project }, client: [{ client_info: { mobilesdk_app_id: '1:421704127278:android:abc', android_client_info: { package_name: pkg } }, api_key: [{ current_key: 'AIzaFAKEFAKEFAKE' }] }], configuration_version: '1' });
  const a = makeProject('gs-raw');
  const ra = run('android', a, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  eq('raw google-services exit', ra.code, 0, ra.out);
  check('raw google-services written', exists(path.join(a, 'android/app/google-services.json')));
  check('secret value is never printed', !ra.out.includes('AIzaFAKE'));
  const b = makeProject('gs-b64');
  const rb = run('android', b, { env: { GOOGLE_SERVICES_JSON: Buffer.from(fake('com.techverse.quranbangla')).toString('base64') } });
  eq('base64 google-services exit', rb.code, 0, rb.out);
  check('base64 google-services decoded', /"project_id": "quranfreeapps"/.test(read(path.join(b, 'android/app/google-services.json'))));
  const c = makeProject('gs-wrongpkg');
  const rc = run('android', c, { env: { GOOGLE_SERVICES_JSON: fake('com.other.app') } });
  check('wrong package is rejected', rc.code === 1 && /no Android app with package name/.test(rc.out), rc.out);
  const d = makeProject('gs-badjson');
  const rd = run('android', d, { env: { GOOGLE_SERVICES_JSON: 'this is not json' } });
  check('garbage secret is rejected', rd.code === 1 && /neither valid JSON nor base64/.test(rd.out), rd.out);
  const e = makeProject('gs-otherproject');
  const re = run('android', e, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla', 'some-other-project') } });
  check('other Firebase project only warns', re.code === 0 && /website uses "quranfreeapps"/.test(re.out), re.out);
  const f = makeProject('gs-lenient');
  const rf = run('android', f, { env: { GOOGLE_SERVICES_JSON: 'garbage', QR_PATCH_LENIENT: '1' } });
  check('lenient mode turns a bad optional step into a warning', rf.code === 0 && /skipped \(QR_PATCH_LENIENT=1\)/.test(rf.out), rf.out);

  // ---- the "fcm" capability flag in the user agent (producer: patch script, consumer: app/js/native.js) ----
  const cfgOf = (proj, where) => JSON.parse(read(where === 'assets' ? path.join(proj, 'android/app/src/main/assets/capacitor.config.json') : path.join(proj, 'capacitor.config.json')));
  eq('userAgentToken without flags', userAgentToken('1.1.0', 5), 'QuranBanglaApp/1.1.0 (5)');
  eq('userAgentToken with the fcm flag', userAgentToken('1.1.0', 5, [FCM_FLAG]), 'QuranBanglaApp/1.1.0 (5; fcm)');
  eq('valid secret -> assets config carries the fcm flag', cfgOf(a, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123; fcm)');
  eq('valid secret -> project config carries the fcm flag', cfgOf(a, 'project').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123; fcm)');
  eq('base64 secret -> fcm flag too', cfgOf(b, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123; fcm)');
  check('the rest of the Capacitor config is untouched by the flag', (() => { const c = cfgOf(a, 'assets'); return c.server.androidScheme === 'https' && !('url' in c.server) && c.appId === 'com.techverse.quranbangla'; })());
  const flagReport = JSON.parse(read(path.join(a, 'qr-patch-report.android.json')));
  check('report: fcm + fcmFlag true', flagReport.fcm === true && flagReport.fcmFlag === true);
  check('summary says push is enabled', /Push notifications \(Firebase Cloud Messaging\): \*\*enabled in this build\*\*/.test(summaryMarkdown(flagReport)));
  const before2 = [read(path.join(a, 'android/app/src/main/assets/capacitor.config.json')), read(path.join(a, 'android/app/build.gradle'))];
  const ra2 = run('android', a, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  eq('second run with the secret: exit code', ra2.code, 0, ra2.out);
  check('second run with the secret changes nothing', before2[0] === read(path.join(a, 'android/app/src/main/assets/capacitor.config.json')) && before2[1] === read(path.join(a, 'android/app/build.gradle')));
  eq('wrong package -> no flag', cfgOf(c, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  eq('garbage secret -> no flag', cfgOf(d, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  eq('lenient + garbage secret -> no flag', cfgOf(f, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  // valid secret but the Android assets config is missing: the build must fail instead of shipping an app that cannot use push
  const g = makeProject('gs-noassets', { noAssetsConfig: true });
  const rg = run('android', g, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  check('missing assets config + secret fails the build', rg.code === 1 && /capacitor\.config\.json not found/.test(rg.out), rg.out);
  // valid secret but no Google services Gradle plugin anywhere: Firebase would never start -> error, not a warning
  const hGradle = GRADLE_GROOVY.replace(/try \{[\s\S]*?\n\}\n$/, '');
  const hRoot = ROOT_GRADLE.replace("        classpath 'com.google.gms:google-services:4.4.4'\n", '');
  const hh = makeProject('gs-noplugin', { gradle: hGradle, rootGradle: hRoot });
  check('fixture really has no google-services plugin', !/google-services/.test(read(path.join(hh, 'android/app/build.gradle'))) && !/google-services/.test(read(path.join(hh, 'android/build.gradle'))));
  const rh = run('android', hh, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  check('secret without the Gradle plugin is an error', rh.code === 1 && /Google services Gradle plugin/.test(rh.out), rh.out);
  // plugin missing from the app module only (classpath present): the script applies it
  const iGradle = GRADLE_GROOVY.replace(/try \{[\s\S]*?\n\}\n$/, '');
  const ii = makeProject('gs-applyplugin', { gradle: iGradle });
  const ri = run('android', ii, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  eq('plugin applied by the script: exit code', ri.code, 0, ri.out);
  check('plugin applied by the script: line appended once', count(read(path.join(ii, 'android/app/build.gradle')), "apply plugin: 'com.google.gms.google-services'") === 1);
  // the consumer: app/js/native.js must parse exactly this token format
  const nativeSrc = read(path.join(REPO, 'app/js/native.js'));
  const reSrc = /var m = (\/QuranBanglaApp[^\n]*?\/)\.exec\(navigator\.userAgent/.exec(nativeSrc);
  check('native.js has the user-agent regex', !!reSrc);
  if (reSrc) {
    const re = new Function('return ' + reSrc[1])();
    const t1 = re.exec('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 QuranBanglaApp/1.1.0 (123; fcm)');
    check('native.js parses the flagged token', !!t1 && t1[1] === '1.1.0' && t1[2] === '123' && /\bfcm\b/.test(t1[3] || ''));
    const t2 = re.exec('Mozilla/5.0 QuranBanglaApp/1.1.0 (123)');
    check('native.js parses the plain token', !!t2 && t2[1] === '1.1.0' && t2[2] === '123' && !t2[3]);
    const t3 = re.exec('Mozilla/5.0 QuranBanglaApp/1.1.0');
    check('native.js parses a token without a build code', !!t3 && t3[1] === '1.1.0' && !t3[2]);
  }
}

// ---------------------------------------------------------------------------------------------------- 7. safe mode
{
  const proj = makeProject('safe');
  const before = read(path.join(proj, 'android/app/src/main/AndroidManifest.xml'));
  const r = run('android', proj, { mode: 'safe' });
  eq('android safe exit code', r.code, 0, r.out);
  eq('safe mode leaves the manifest alone', read(path.join(proj, 'android/app/src/main/AndroidManifest.xml')), before);
  const gradle = read(path.join(proj, 'android/app/build.gradle'));
  check('safe mode still sets version + signing', gradle.includes('versionCode = 123') && gradle.includes('qrRelease'));
  const res = path.join(proj, 'android/app/src/main/res');
  check('safe mode removes adaptive definitions like the old workflow', !exists(path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml')));
  check('safe mode copies no extra resources', !exists(path.join(res, 'xml/shortcuts.xml')) && !exists(path.join(res, 'values/qr_theme.xml')));
  check('safe mode does not touch the splash theme', !read(path.join(res, 'values/styles.xml')).includes('windowSplashScreenBackground'));
}

// ------------------------------------------------------------------------------------------ 8. template variations
{
  const k = makeProject('kts', { kts: true });
  const rk = run('android', k);
  eq('kts template exit code', rk.code, 0, rk.out);
  const kt = read(path.join(k, 'android/app/build.gradle.kts'));
  check('kts block written', kt.includes('versionCode = 123') && kt.includes('create("qrRelease")') && kt.includes('System.getenv("QR_KEYSTORE_PATH")'));
  const ns = makeProject('nostyles', { noStyles: true });
  const rn = run('android', ns);
  eq('missing styles.xml is tolerated', rn.code, 0, rn.out);
  const cr = makeProject('crlf', { crlf: true });
  const rcr = run('android', cr);
  eq('CRLF manifest exit code', rcr.code, 0, rcr.out);
  check('CRLF manifest becomes well-formed LF text', !read(path.join(cr, 'android/app/src/main/AndroidManifest.xml')).includes('\r'));
  const other = makeProject('otherstyles', { styles: STYLES.replace('parent="Theme.SplashScreen"', 'parent="Theme.AppCompat.Light.NoActionBar"') });
  const ro = run('android', other);
  eq('non-SplashScreen launch theme is left alone', ro.code, 0, ro.out);
  check('non-SplashScreen launch theme not modified', !read(path.join(other, 'android/app/res/../src/main/res/values/styles.xml')).includes('windowSplashScreenBackground'));
  const low = makeProject('lowsdk', { variables: VARIABLES_GRADLE.replace('targetSdkVersion = 36', 'targetSdkVersion = 33') });
  const rl = run('android', low);
  check('low targetSdk only warns', rl.code === 0 && /targetSdkVersion is 33/.test(rl.out), rl.out);
  const empty = path.join(TMP, 'empty-project');
  fs.mkdirSync(empty, { recursive: true });
  const re = run('android', empty);
  check('missing generated project gives a clear error', re.code === 1 && /npx cap add android/.test(re.out), re.out);
  const nogradle = makeProject('nogradle');
  fs.unlinkSync(path.join(nogradle, 'android/app/build.gradle'));
  const rng = run('android', nogradle);
  check('missing gradle file stops the build', rng.code === 1 && /build\.gradle/.test(rng.out), rng.out);
}

// -------------------------------------------------------------------- 9. repository without a maskable icon / manifest
{
  const repo = path.join(TMP, 'mini-repo');
  fs.mkdirSync(path.join(repo, 'icons'), { recursive: true });
  fs.cpSync(path.join(REPO, 'android-build', 'res'), path.join(repo, 'android-build', 'res'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(repo, 'icons', 'a.png'), makePng(8, 8, () => [10, 100, 60, 255]));
  fs.writeFileSync(path.join(repo, 'manifest.json'), JSON.stringify({ theme_color: '#FFFFFF', icons: [{ src: 'icons/a.png', sizes: '192x192', type: 'image/png', purpose: 'any' }] }));
  const proj = makeProject('nomask');
  const r = run('android', proj, { repo });
  eq('no maskable icon: exit code', r.code, 0, r.out);
  check('no maskable icon: legacy icons used', !exists(path.join(proj, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')), r.out);
  const cfgDir = path.join(TMP, 'mini-cfg');
  const rc = run('config', cfgDir, { repo });
  eq('light theme colour: exit code', rc.code, 0, rc.out);
  eq('light theme colour -> LIGHT status bar style', JSON.parse(read(path.join(cfgDir, 'capacitor.config.json'))).plugins.SystemBars.style, 'LIGHT');
  fs.writeFileSync(path.join(repo, 'manifest.json'), '{ not json');
  const rb = run('config', path.join(TMP, 'mini-cfg2'), { repo });
  check('broken manifest.json only warns', rb.code === 0 && /not valid JSON/.test(rb.out), rb.out);
  eq('broken manifest.json: the config is still written (bundled app, https scheme)', JSON.parse(read(path.join(TMP, 'mini-cfg2', 'capacitor.config.json'))).server.androidScheme, 'https');
}

// ---------------------------------------------------------------------------------------------- 10. Gradle text sanity
{
  const g = groovyBlock({ versionName: '1.1.0', versionCode: '123' });
  check('groovy: balanced braces', count(g, '{') === count(g, '}'));
  check('groovy: no template placeholders left', !/undefined|\$\{/.test(g));
  const k = ktsBlock({ versionName: '1.1.0', versionCode: '123' });
  check('kts: balanced braces', count(k, '{') === count(k, '}'));
  check('groovy: debug signing uses the fixed key from the environment', /QR_DEBUG_KEYSTORE_PATH/.test(g) && /\bdebug\s*\{/.test(g) && /androiddebugkey/.test(g) && /storeFile = qrDebugKeystore/.test(g) && /\.android\/debug\.keystore/.test(g));
  check('kts: debug signing uses the fixed key from the environment', /QR_DEBUG_KEYSTORE_PATH/.test(k) && /getByName\("debug"\)/.test(k) && /androiddebugkey/.test(k) && /\.android\/debug\.keystore/.test(k));
  check('groovy: the debug key block comes before the release block', g.indexOf('qrDebugKeystore') < g.indexOf('qrKeystorePath'));
}

// ---------------------------------------------------------------------------------------- 11. APK audit parsers
{
  const badging = `package: name='com.techverse.quranbangla' versionCode='123' versionName='1.1.0' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'
sdkVersion:'24'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.ACCESS_NETWORK_STATE'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
uses-permission: name='android.permission.WAKE_LOCK'
uses-permission: name='com.google.android.c2dm.permission.RECEIVE'
uses-permission: name='com.techverse.quranbangla.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
uses-permission: name='android.permission.WRITE_EXTERNAL_STORAGE' maxSdkVersion='28'
uses-permission: name='android.permission.SOMETHING_NEW'
application-label:'Quran Bangla'
launchable-activity: name='com.techverse.quranbangla.MainActivity'  label='' icon=''
native-code: 'arm64-v8a' 'x86_64'
`;
  const b = parseBadging(badging);
  eq('badging package', b.package, 'com.techverse.quranbangla');
  eq('badging versionCode', b.versionCode, '123');
  eq('badging versionName', b.versionName, '1.1.0');
  eq('badging target sdk', b.targetSdk, '36');
  eq('badging min sdk', b.minSdk, '24');
  eq('badging compile sdk', b.compileSdk, '36');
  eq('badging permission count', b.permissions.length, 8);
  eq('badging launchable', b.launchable, 'com.techverse.quranbangla.MainActivity');
  eq('badging native code', b.nativeCode.join(','), 'arm64-v8a,x86_64');
  const c = classifyPermissions(b.permissions, 'com.techverse.quranbangla');
  eq('allowed permissions', c.allowed.length, 6);
  eq('forbidden permissions', c.forbidden.map((p) => p.name).join(','), 'android.permission.WRITE_EXTERNAL_STORAGE');
  eq('unexpected permissions', c.unexpected.map((p) => p.name).join(','), 'android.permission.SOMETHING_NEW');
  for (const p of ['android.permission.SCHEDULE_EXACT_ALARM', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.CAMERA', 'android.permission.READ_SMS', 'com.google.android.gms.permission.AD_ID', 'android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.READ_CONTACTS'])
    eq('forbidden: ' + p, classifyPermissions([{ name: p, maxSdk: '' }], 'x.y').forbidden.length, 1);
  for (const p of ['android.permission.POST_NOTIFICATIONS', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.RECEIVE_BOOT_COMPLETED'])
    eq('allowed: ' + p, classifyPermissions([{ name: p, maxSdk: '' }], 'x.y').allowed.length, 1);
  const signer = parseApksigner(`Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Number of signers: 1
Signer #1 certificate DN: CN=Quran Bangla, O=TechVerse, C=BD
Signer #1 certificate SHA-256 digest: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567
`);
  eq('apksigner verified', signer.verified, true);
  eq('apksigner v2 scheme', signer.schemes.v2, true);
  eq('apksigner DN', signer.signers[0].dn, 'CN=Quran Bangla, O=TechVerse, C=BD');
  eq('apksigner SHA-256 formatting', signer.signers[0].sha256, '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF');
  check('debug certificate detected', isDebugCertificate('C=US, O=Android, CN=Android Debug') && !isDebugCertificate(signer.signers[0].dn));
  check('failed verification detected', parseApksigner('DOES NOT VERIFY\nERROR: JAR_SIG_NO_SIGNATURES').verified === false);
  eq('formatFingerprint', formatFingerprint('ab:cd:ef'), 'AB:CD:EF');
  // newer build-tools print the SDK range instead of a number: "Signer (minSdkVersion=24, maxSdkVersion=2147483647) certificate ..."
  const ranged = parseApksigner(`Verifies
Verified using v3 scheme (APK Signature Scheme v3): true
Number of signers: 1
Signer (minSdkVersion=24, maxSdkVersion=2147483647) certificate DN: C=US, O=Android, CN=Android Debug
Signer (minSdkVersion=24, maxSdkVersion=2147483647) certificate SHA-256 digest: b088db33e68613a4063f773a2c816b76fc7151e2e95fc84f3d722d13de62ef2e
`);
  eq('apksigner (SDK-range format) SHA-256', ranged.signers[0] && ranged.signers[0].sha256, REPO_KEY_SHA256);
  eq('apksigner (SDK-range format) signer count', ranged.signers.length, 1);
  // signing block reader: a hand-made APK (data + APK Signing Block + central directory + end record) that carries the repo's debug certificate
  {
    const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const lp = (b) => Buffer.concat([u32(b.length), b]);
    const der = Buffer.from(REPO_KEY_CERT_B64, 'base64');
    const digests = lp(lp(Buffer.concat([u32(0x103), lp(Buffer.alloc(32, 7))])));
    const certs = lp(lp(der));
    const attrs = lp(Buffer.alloc(0));
    const sigs = lp(lp(Buffer.concat([u32(0x103), lp(Buffer.alloc(256, 9))])));
    const pub = lp(Buffer.alloc(294, 5));
    const v2Value = lp(lp(Buffer.concat([lp(Buffer.concat([digests, certs, attrs])), sigs, pub])));
    const v3Value = lp(lp(Buffer.concat([lp(Buffer.concat([digests, certs, u32(24), u32(0x7fffffff), attrs])), u32(24), u32(0x7fffffff), sigs, pub])));
    const pair = (id, value) => Buffer.concat([u64(4 + value.length), u32(id), value]);
    const makeApk = (pairs) => {
      const prefix = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(300, 1)]);
      let block = Buffer.alloc(0);
      if (pairs) {
        const body = Buffer.concat(pairs);
        block = Buffer.concat([u64(body.length + 24), body, u64(body.length + 24), Buffer.from('APK Sig Block 42', 'latin1')]);
      }
      const cdir = Buffer.concat([Buffer.from('PK\x01\x02'), Buffer.alloc(60, 2)]);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(cdir.length, 12); eocd.writeUInt32LE(prefix.length + block.length, 16);
      return Buffer.concat([prefix, block, cdir, eocd]);
    };
    const padding = pair(0x42726577, Buffer.alloc(120));     // unknown ids (verity padding) must be skipped
    const fV2 = path.join(TMP, 'sigblock-v2.apk'), fV3 = path.join(TMP, 'sigblock-v3.apk'), fNone = path.join(TMP, 'unsigned.apk'), fJunk = path.join(TMP, 'junk.apk');
    fs.writeFileSync(fV2, makeApk([padding, pair(0x7109871a, v2Value)]));
    fs.writeFileSync(fV3, makeApk([pair(0xf05368c0, v3Value), padding]));
    fs.writeFileSync(fNone, makeApk(null));
    fs.writeFileSync(fJunk, Buffer.from('this is not an apk'));
    const s2 = signerFromApk(fV2), s3 = signerFromApk(fV3);
    eq('signing block v2: SHA-256 of the certificate', s2 && s2.sha256, REPO_KEY_SHA256);
    eq('signing block v3: SHA-256 of the certificate', s3 && s3.sha256, REPO_KEY_SHA256);
    eq('signing block v2: scheme', s2 && s2.source, 'signing block v2');
    eq('signing block v3: scheme', s3 && s3.source, 'signing block v3');
    check('signing block: debug certificate detected', !!s2 && isDebugCertificate(s2.dn), s2 && s2.dn);
    eq('signing block: SHA-1 of the certificate', s2 && s2.sha1, '69:E7:76:E5:5B:99:EA:04:7D:09:F6:47:C7:CF:46:2C:A8:05:E8:EF');
    eq('unsigned APK has no signer', signerFromApk(fNone), null);
    eq('junk file has no signer', signerFromApk(fJunk), null);
    eq('missing file has no signer', signerFromApk(path.join(TMP, 'does-not-exist.apk')), null);
    eq('signing block: nothing to read in a short buffer', readSigningBlockCertificates(Buffer.alloc(10)).length, 0);
  // Gradle's own report of the debug key (diagnostic row in the audit)
  {
    const report = `> Task :app:signingReport
Variant: debug
Config: debug
Store: /home/runner/.android/debug.keystore
Alias: AndroidDebugKey
MD5: 4C:36:7B:6C:25:3F:4E:2A:90:0B:AB:5B:5D:57:1E:11
SHA1: 69:E7:76:E5:5B:99:EA:04:7D:09:F6:47:C7:CF:46:2C:A8:05:E8:EF
SHA-256: ${REPO_KEY_SHA256}
Valid until: Wednesday, 7 November 2054
----------
Variant: release
Config: null
----------
Variant: debugAndroidTest
Config: debug
Store: /home/runner/.android/debug.keystore
`;
    const gr = parseSigningReport(report);
    eq('signing report: store', gr && gr.store, '/home/runner/.android/debug.keystore');
    eq('signing report: SHA-256', gr && gr.sha256, REPO_KEY_SHA256);
    eq('signing report: alias', gr && gr.alias, 'AndroidDebugKey');
    eq('signing report: nothing found in unrelated text', parseSigningReport('BUILD SUCCESSFUL'), null);
  }
  }
  const tree = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=123
    E: application (line=24)
      A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false
      E: activity (line=30)
        E: intent-filter (line=40)
          A: http://schemas.android.com/apk/res/android:autoVerify(0x010104ee)=true
          E: data (line=44)
            A: http://schemas.android.com/apk/res/android:scheme(0x01010027)="https" (Raw: "https")
            A: http://schemas.android.com/apk/res/android:host(0x01010028)="quranbangla.vercel.app" (Raw: "quranbangla.vercel.app")
        E: intent-filter (line=50)
          E: data (line=54)
            A: http://schemas.android.com/apk/res/android:scheme(0x01010027)="quranbangla" (Raw: "quranbangla")
        E: meta-data (line=58)
          A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.app.shortcuts" (Raw: "android.app.shortcuts")
      E: meta-data (line=60)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.google.firebase.messaging.default_notification_channel_id" (Raw: "x")
`;
  const mt = parseManifestTree(tree);
  check('manifest tree parsed', mt.parsed === true && mt.allowBackup === false && mt.autoVerify === true && mt.shortcuts === true && mt.fcmChannel === true);
  eq('manifest tree schemes', mt.schemes.join(','), 'https,quranbangla');
  eq('manifest tree hosts', mt.hosts.join(','), 'quranbangla.vercel.app');
  eq('manifest tree allowBackup true', parseManifestTree('  E: manifest (line=2)\n  A: x:allowBackup(0x01010280)=true').allowBackup, true);
  eq('manifest tree: unparsable output', parseManifestTree('garbage').parsed, false);
  const links = JSON.parse(assetlinksJson('com.techverse.quranbangla', [signer.signers[0].sha256]));
  eq('assetlinks package', links[0].target.package_name, 'com.techverse.quranbangla');
  eq('assetlinks relation', links[0].relation[0], 'delegate_permission/common.handle_all_urls');
  const md = renderMarkdown({ file: 'a.apk', kind: 'release', size: 5 * 1048576, sha256: 'abc', badging: b, permissions: c, manifest: mt, signer: signer.signers[0], debugKey: false, findings: [{ level: 'warn', text: 'w' }] });
  check('markdown report', md.includes('Certificate SHA-256') && md.includes('WARN: w') && md.includes('FORBIDDEN'));
}

// ------------------------------------------------------------------------------ 5b. android phase without a site address
{
  const proj = makeProject('full');
  const r = run('android', proj, { env: { SITE_URL: '', GOOGLE_SERVICES_JSON: '' } });
  eq('android phase works without SITE_URL', r.code, 0, r.out);
  const m = read(path.join(proj, 'android/app/src/main/AndroidManifest.xml'));
  check('... no https App Link filter, quranbangla:// links and shortcuts kept', !/android:scheme="https"/.test(m) && m.includes('android:scheme="quranbangla"') && m.includes('@xml/shortcuts'));
  check('... and it says so', /no App Links \(no SITE_URL\)/.test(r.out), r.out);
}

// ------------------------------------------------------------------------ 7. the finished APK: the standalone promise
{
  // a minimal zip writer (an APK is a zip) so the reader is tested on real zip bytes, stored and deflated
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function makeZip(files, { deflate = true } = {}) {
    const parts = [], central = [];
    let offset = 0;
    for (const [name, data] of Object.entries(files)) {
      const raw = Buffer.from(data), comp = deflate ? zlib.deflateRawSync(raw) : raw, method = deflate ? 8 : 0, nameBuf = Buffer.from(name), crc = crc32(raw);
      const loc = Buffer.alloc(30);
      loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(method, 8); loc.writeUInt32LE(crc, 14);
      loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(nameBuf.length, 26);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(method, 10); cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
      parts.push(loc, nameBuf, comp); central.push(cen, nameBuf);
      offset += 30 + nameBuf.length + comp.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22), n = Object.keys(files).length;
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, end]);
  }
  const apkFiles = () => {
    const f = { 'AndroidManifest.xml': 'binary-manifest', 'assets/capacitor.config.json': JSON.stringify({ appId: 'x', server: { androidScheme: 'https', cleartext: false } }), 'assets/public/native-bridge.js': '/* capacitor */' };
    for (const rel of ['index.html', 'js/app.js', 'data/quran/manifest.json', 'bundle-manifest.json']) f['assets/public/' + rel] = fs.readFileSync(path.join(BUNDLE, rel));
    return f;
  };
  const levelTexts = (r, level) => r.findings.filter((x) => x.level === level).map((x) => x.text);

  // the zip reader itself
  const z = makeZip({ 'a.txt': 'hello hello hello', 'dir/b.bin': Buffer.from([0, 1, 2, 255]) });
  const idx = readZipIndex(z);
  eq('zip reader: entries', [...idx.keys()].join(','), 'a.txt,dir/b.bin');
  eq('zip reader: deflated entry', readZipEntry(z, idx.get('a.txt')).toString(), 'hello hello hello');
  eq('zip reader: binary entry', Array.from(readZipEntry(z, idx.get('dir/b.bin'))).join(','), '0,1,2,255');
  eq('zip reader: stored entry', readZipEntry(makeZip({ 'a.txt': 'plain' }, { deflate: false }), readZipIndex(makeZip({ 'a.txt': 'plain' }, { deflate: false })).get('a.txt')).toString(), 'plain');
  check('zip reader: garbage is refused', (() => { try { readZipIndex(Buffer.from('this is not a zip file at all, not even close')); return false; } catch (e) { return /not a zip/.test(e.message); } })());

  for (const deflate of [true, false]) {
    const r = checkStandalone(makeZip(apkFiles(), { deflate }));
    eq(`a correct standalone APK has no findings (${deflate ? 'deflated' : 'stored'} entries)`, r.findings.length, 0, JSON.stringify(r.findings));
    eq('... verified file count', r.info.files, 3);
    eq('... bundle id', r.info.bundleId, 'selftest');
    eq('... offline Quran editions', r.info.quranEditions.join(','), 'quran-uthmani,bn.bengali');
    eq('... no server.url', r.info.serverUrl, '');
  }
  const bad = (label, mutate, level, re) => {
    const f = apkFiles(); mutate(f);
    const r = checkStandalone(makeZip(f));
    check(label, levelTexts(r, level).some((x) => re.test(x)), JSON.stringify(r.findings));
  };
  bad('server.url in the APK is an error', (f) => { f['assets/capacitor.config.json'] = JSON.stringify({ server: { url: 'https://quranbangla.vercel.app' } }); }, 'error', /server\.url https:\/\/quranbangla\.vercel\.app: the app would load that website/);
  bad('no capacitor.config.json is an error', (f) => { delete f['assets/capacitor.config.json']; }, 'error', /capacitor\.config\.json is not in the APK/);
  bad('http as the app scheme is a warning', (f) => { f['assets/capacitor.config.json'] = JSON.stringify({ server: { androidScheme: 'http' } }); }, 'warn', /androidScheme is http/);
  bad('a leftover server.errorPath is a warning', (f) => { f['assets/capacitor.config.json'] = JSON.stringify({ server: { errorPath: 'error.html' } }); }, 'warn', /errorPath/);
  bad('a missing start page is an error', (f) => { delete f['assets/public/index.html']; }, 'error', /no start page/);
  bad('a website index.html is an error', (f) => { f['assets/public/index.html'] = '<html>the website</html>'; }, 'error', /not the standalone page/);
  bad('a bundled file changed inside the APK is an error', (f) => { f['assets/public/js/app.js'] = 'console.log("evil");'; }, 'error', /js\/app\.js differs from bundle-manifest/);
  bad('a bundled file missing from the APK is an error', (f) => { delete f['assets/public/js/app.js']; }, 'error', /js\/app\.js is missing from the APK/);
  bad('no bundle-manifest.json is an error', (f) => { delete f['assets/public/bundle-manifest.json']; }, 'error', /bundle-manifest\.json is missing/);
  bad('a broken bundle-manifest.json is an error', (f) => { f['assets/public/bundle-manifest.json'] = '{ nope'; }, 'error', /bundle-manifest\.json is not valid JSON/);
  bad('no offline Quran data is an error', (f) => { delete f['assets/public/data/quran/manifest.json']; }, 'error', /offline Quran data is not in the APK/);
  bad('Quran data with the wrong counts is an error', (f) => { f['assets/public/data/quran/manifest.json'] = '{"schema":1,"counts":{"surahs":113,"ayahs":6236}}'; }, 'error', /does not describe 114 surahs/);
  bad('an unlisted file in assets/public is a warning', (f) => { f['assets/public/stray.js'] = 'x'; }, 'warn', /not part of the verified bundle, e\.g\. stray\.js/);
  const cap = checkStandalone(makeZip({ ...apkFiles(), 'assets/public/cordova.js': '//', 'assets/public/cordova_plugins.js': '//' }));
  eq("Capacitor's own files (native-bridge.js, cordova*.js) are not reported", cap.findings.length, 0, JSON.stringify(cap.findings));
  check('a file that is not a zip is reported, not thrown', checkStandalone(Buffer.from('definitely not an apk, but long enough to scan')).findings[0].text.includes('could not be read as a zip'));
}

// ------------------------------------------------------------------------------------ 8. native modules (Kotlin overlay)
{
  const BUILD = path.join(REPO, 'android-build');
  const listAll = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath || e.path, e.name)).sort();
  const hashAll = (dir) => Object.fromEntries(listAll(dir).map((f) => [path.relative(dir, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
  const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

  // --- the overlay itself, and its configuration
  const lint = lintNative(BUILD);
  eq('native-lint finds no error in the committed overlay', lint.errors.length, 0, lint.errors.join('\n'));
  const cfg = readNativeConfig(BUILD);
  eq('modules.json: Kotlin version', cfg.gradle.kotlin, '2.2.20');
  eq('modules.json: Room version', cfg.gradle.room, '2.8.4');
  // Guard against the failure that made the full build fall back to SAFE MODE: Room older than 2.7.0 cannot read the metadata of
  // Kotlin 2.1+ ("Provided Metadata instance has version 2.1.0, while maximum supported version is 2.0.0"), so the two must move together.
  const versionAtLeast = (v, min) => {
    const a = String(v).split('.').map(Number), b = String(min).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return true;
  };
  check('modules.json: Room is new enough for this Kotlin (Room < 2.7.0 cannot read Kotlin 2.1+ metadata)', !versionAtLeast(cfg.gradle.kotlin, '2.1.0') || versionAtLeast(cfg.gradle.room, '2.7.0'));
  eq('the exact alarm permission is the only extra permission', nativePermissions(BUILD).join(','), 'android.permission.SCHEDULE_EXACT_ALARM');

  // --- Gradle edits as pure functions
  const g1 = patchRootGradleForKotlin(ROOT_GRADLE, '2.2.20');
  check('root build.gradle: the Kotlin plugin follows the Android Gradle plugin line', g1.changed && /classpath 'com\.android\.tools\.build:gradle:[\d.]+'\n\s+classpath 'org\.jetbrains\.kotlin:kotlin-gradle-plugin:2\.2\.20' \/\/ qr-native-modules/.test(g1.text), g1.text);
  eq('root build.gradle: the existing classpath lines are untouched', ROOT_GRADLE.split('\n').every((l) => g1.text.includes(l)), true);
  eq('root build.gradle: a second run changes nothing', patchRootGradleForKotlin(g1.text, '2.2.20').changed, false);
  eq('root build.gradle: an existing Kotlin plugin is respected', patchRootGradleForKotlin(ROOT_GRADLE.replace("classpath 'com.google.gms:google-services:4.4.4'", "classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25'"), '2.2.20').changed, false);
  check('root build.gradle: no Android Gradle plugin line = clear error', throwsWith(() => patchRootGradleForKotlin('buildscript { dependencies { } }', '2.2.20'), /Android Gradle plugin classpath line was not found/));
  const a1 = patchAppGradleForKotlin(GRADLE_GROOVY, { roomVersion: '2.8.4', jvmTarget: 21 });
  const appIdx = (s) => s.indexOf("apply plugin: 'com.android.application'");
  check('app build.gradle: the Kotlin and kapt plugins are applied right after the application plugin', a1.changed && a1.text.indexOf("apply plugin: 'kotlin-android'") > appIdx(a1.text) && a1.text.indexOf("apply plugin: 'kotlin-kapt'") > a1.text.indexOf("apply plugin: 'kotlin-android'") && a1.text.indexOf("apply plugin: 'kotlin-kapt'") < a1.text.indexOf('android {'));
  for (const needle of ['implementation "androidx.room:room-runtime:2.8.4"', 'kapt "androidx.room:room-compiler:2.8.4"', 'JvmTarget.JVM_21', 'arg("room.schemaLocation", "$projectDir/schemas")', 'correctErrorTypes = true']) check('app build.gradle contains ' + needle, a1.text.includes(needle));
  eq('app build.gradle: every original line is still there', GRADLE_GROOVY.split('\n').filter((l) => l.trim()).every((l) => a1.text.includes(l)), true);
  eq('app build.gradle: a second run changes nothing', patchAppGradleForKotlin(a1.text, { roomVersion: '2.8.4', jvmTarget: 21 }).changed, false);
  // the middle fallback tier (QR_NATIVE_DB=off): everything except the Room annotation processor
  const nodb = patchAppGradleForKotlin(GRADLE_GROOVY, { roomVersion: '2.8.4', jvmTarget: 21, kapt: false });
  check('app build.gradle without kapt: the Kotlin plugin is applied, kapt is not', nodb.changed && nodb.text.includes("apply plugin: 'kotlin-android'") && !/kotlin-kapt/.test(nodb.text));
  check('app build.gradle without kapt: no kapt block and no Room compiler', !/^kapt\s*\{/m.test(nodb.text) && !nodb.text.includes('room-compiler') && !nodb.text.includes('room.schemaLocation'));
  check('app build.gradle without kapt: the Room runtime and the JVM target stay (the Room classes of the overlay still compile)', nodb.text.includes('implementation "androidx.room:room-runtime:2.8.4"') && nodb.text.includes('JvmTarget.JVM_21'));
  eq('app build.gradle without kapt: a second run changes nothing', patchAppGradleForKotlin(nodb.text, { roomVersion: '2.8.4', jvmTarget: 21, kapt: false }).changed, false);
  check('app build.gradle: the default is WITH kapt', patchAppGradleForKotlin(GRADLE_GROOVY, { roomVersion: '2.8.4', jvmTarget: 21 }).text.includes('kapt "androidx.room:room-compiler:2.8.4"'));
  check('app build.gradle: JVM 17 is honoured', patchAppGradleForKotlin(GRADLE_GROOVY, { roomVersion: '2.8.4', jvmTarget: 17 }).text.includes('JvmTarget.JVM_17'));
  check('app build.gradle: no application plugin line = clear error', throwsWith(() => patchAppGradleForKotlin('android { }', { roomVersion: '2.8.4', jvmTarget: 21 }), /com\.android\.application.*was not found/));
  const already = patchAppGradleForKotlin(GRADLE_GROOVY.replace("apply plugin: 'com.android.application'", "apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'"), { roomVersion: '2.8.4', jvmTarget: 21 });
  eq('app build.gradle: a Kotlin plugin that is already applied is not applied twice', (already.text.match(/apply plugin: 'kotlin-android'/g) || []).length, 1);
  eq('gradle.properties: the 1.5 GB default is raised', patchGradleProperties('org.gradle.jvmargs=-Xmx1536m\nandroid.useAndroidX=true\n').text.includes('-Xmx3072m'), true);
  eq('gradle.properties: other flags on that line survive', patchGradleProperties('org.gradle.jvmargs=-Xmx1024m -Dfile.encoding=UTF-8\n').text, 'org.gradle.jvmargs=-Xmx3072m -Dfile.encoding=UTF-8\n');
  eq('gradle.properties: 4 GB is left alone', patchGradleProperties('org.gradle.jvmargs=-Xmx4g\n').changed, false);
  eq('gradle.properties: no jvmargs line = one is added', patchGradleProperties('android.useAndroidX=true\n').text.includes('org.gradle.jvmargs=-Xmx3072m'), true);
  const jt = path.join(TMP, 'jvm-target'); fs.mkdirSync(jt, { recursive: true });
  eq('JVM target: default when nothing says otherwise', detectJvmTarget(jt), 21);
  fs.writeFileSync(path.join(jt, 'capacitor.build.gradle'), 'sourceCompatibility JavaVersion.VERSION_17');
  eq('JVM target: read from capacitor.build.gradle', detectJvmTarget(jt), 17);

  // --- manifest components as a pure function
  const mc = addNativeComponents(MANIFEST_STANDARD, read(path.join(BUILD, 'native', 'manifest', 'components.xml')));
  check('manifest: the components are inside <application>, once', mc.changed && mc.text.indexOf(NATIVE_MARK) < mc.text.lastIndexOf('</application>') && (mc.text.match(/NextPrayerWidget/g) || []).length === 1);
  eq('manifest: still well-formed', checkXml(mc.text), null);
  eq('manifest: a second run changes nothing', addNativeComponents(mc.text, 'x').changed, false);
  check('manifest: no </application> = clear error', throwsWith(() => addNativeComponents('<manifest/>', '<receiver/>'), /no <\/application>/));

  // --- the whole android phase with the overlay, on a project shaped like the one Capacitor generates
  const ALL = { QR_NATIVE_MODULES: 'all' };
  const proj = makeProject('native-all');
  const r = run('android', proj, { env: ALL });
  eq('android phase with the native modules succeeds', r.code, 0, r.out);
  check('the step is reported', /OK\s+Native modules \(Kotlin, Room, widgets, reminders\) - \d+ Kotlin file\(s\), \d+ resource file\(s\), Kotlin 2\.2\.20 \+ Room 2\.8\.4 \(kapt\), JVM target 21, MainActivity\.java replaced by MainActivity\.kt/.test(r.out), r.out);
  const java = path.join(proj, 'android', 'app', 'src', 'main', 'java', 'com', 'techverse', 'quranbangla');
  check('MainActivity.kt replaces MainActivity.java', exists(path.join(java, 'MainActivity.kt')) && !exists(path.join(java, 'MainActivity.java')));
  const mk = read(path.join(java, 'MainActivity.kt'));
  check('MainActivity.kt: package of the app, registers the plugin', /^package com\.techverse\.quranbangla$/m.test(mk) && mk.includes('registerPlugin(QuranNativePlugin::class.java)'));
  const overlayKt = listAll(path.join(BUILD, 'native', 'kotlin')).filter((f) => f.endsWith('.kt')).length;
  const javaRoot = path.join(proj, 'android', 'app', 'src', 'main', 'java');
  eq('every Kotlin file of the overlay is installed', listAll(javaRoot).filter((f) => f.endsWith('.kt')).length, overlayKt);
  check('the sub-packages keep their folders', exists(path.join(javaRoot, 'com/techverse/quranbangla/widgets/NextPrayerWidget.kt')) && exists(path.join(javaRoot, 'com/techverse/quranbangla/db/AppDatabase.kt')) && exists(path.join(javaRoot, 'com/techverse/quranbangla/bridge/QuranNativePlugin.kt')));
  check('R is imported from the app package', read(path.join(javaRoot, 'com/techverse/quranbangla/widgets/NextPrayerWidget.kt')).includes('import com.techverse.quranbangla.R\n'));
  const leftovers = listAll(path.join(proj, 'android')).filter((f) => /\.(kt|xml|gradle|properties)$/.test(f) && read(f).includes('__APP_ID__'));
  eq('no __APP_ID__ placeholder is left anywhere', leftovers.length, 0, leftovers.join('\n'));
  const resDir = path.join(proj, 'android', 'app', 'src', 'main', 'res');
  for (const f of ['layout/qw_widget_next_prayer.xml', 'layout/qw_widget_daily_ayah.xml', 'layout/qw_widget_continue.xml', 'layout/qw_widget_quick.xml', 'layout/qw_widget_reminder.xml', 'xml/qw_provider_next_prayer.xml', 'xml/qw_provider_quick.xml', 'values/qw_colors.xml', 'values-night/qw_colors.xml', 'values/qw_strings.xml', 'values-bn/qw_strings.xml', 'drawable/qw_widget_bg.xml', 'drawable/ic_qw_tasbih.xml']) check('resource installed: ' + f, exists(path.join(resDir, f)));
  const rootG = read(path.join(proj, 'android', 'build.gradle'));
  const appG = read(path.join(proj, 'android', 'app', 'build.gradle'));
  eq('root build.gradle: Kotlin plugin once', (rootG.match(/kotlin-gradle-plugin:2\.2\.20/g) || []).length, 1);
  check('app build.gradle: plugins, kapt, Room', appG.includes("apply plugin: 'kotlin-android'") && appG.includes("apply plugin: 'kotlin-kapt'") && appG.includes('androidx.room:room-compiler:2.8.4') && appG.includes('JvmTarget.JVM_21'));
  check('the version/signing patch of the earlier step is still there', appG.includes('qr-android-build'));
  check('gradle.properties has the larger heap', /org\.gradle\.jvmargs=-Xmx3072m/.test(read(path.join(proj, 'android', 'gradle.properties'))));
  const man = read(path.join(proj, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  eq('manifest is well-formed', checkXml(man), null);
  const x = xmllint(path.join(proj, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'));
  if (x !== null) eq('xmllint accepts the manifest', x, '');
  for (const cls of ['widgets.NextPrayerWidget', 'widgets.DailyAyahWidget', 'widgets.ContinueReadingWidget', 'widgets.QuickActionsWidget', 'widgets.ReminderStatusWidget', 'widgets.WidgetTickReceiver', 'reminders.ReminderReceiver', 'reminders.BootReceiver']) check('manifest declares ' + cls, man.includes('android:name="com.techverse.quranbangla.' + cls + '"'));
  check('exact alarms: SCHEDULE_EXACT_ALARM is a normal permission now (the reminder engine asks the user)', /<uses-permission android:name="android\.permission\.SCHEDULE_EXACT_ALARM"\s*\/>/.test(man) && !/SCHEDULE_EXACT_ALARM"[^>]*tools:node="remove"/.test(man));
  check('USE_EXACT_ALARM stays blocked (Google Play only allows it for alarm clock / calendar apps)', /USE_EXACT_ALARM"[^>]*tools:node="remove"/.test(man));
  check('boot receiver is exported and listens for reboot, update, time and time zone changes', /BootReceiver" android:exported="true">[\s\S]*?BOOT_COMPLETED[\s\S]*?MY_PACKAGE_REPLACED[\s\S]*?TIMEZONE_CHANGED[\s\S]*?TIME_SET/.test(man));
  check('widget providers are not exported', /NextPrayerWidget" android:exported="false"/.test(man));
  check('the existing app link / shortcut patch is intact', man.includes('android:scheme="quranbangla"') && man.includes('@xml/shortcuts'));

  // --- running it again changes nothing at all (the workflow may re-run a phase)
  const before = hashAll(path.join(proj, 'android'));
  const again = run('android', proj, { env: ALL });
  eq('a second run succeeds', again.code, 0, again.out);
  const after = hashAll(path.join(proj, 'android'));
  eq('a second run leaves every file byte for byte as it was', JSON.stringify(after) === JSON.stringify(before), true, Object.keys(after).filter((k) => after[k] !== before[k]).join(', '));

  // --- the switches and the failure modes
  const off = makeProject('native-none');
  eq('QR_NATIVE_MODULES=none succeeds', run('android', off, { env: { QR_NATIVE_MODULES: 'none' } }).code, 0);
  check('... no Kotlin, no widgets, no overlay resources, exact alarms still blocked', !exists(path.join(off, 'android/app/src/main/java/com/techverse/quranbangla/MainActivity.kt')) && exists(path.join(off, 'android/app/src/main/java/com/techverse/quranbangla/MainActivity.java')) && !read(path.join(off, 'android/app/src/main/AndroidManifest.xml')).includes('NextPrayerWidget') && !exists(path.join(off, 'android/app/src/main/res/layout/qw_widget_quick.xml')) && /SCHEDULE_EXACT_ALARM"[^>]*tools:node="remove"/.test(read(path.join(off, 'android/app/src/main/AndroidManifest.xml'))) && !read(path.join(off, 'android/build.gradle')).includes('kotlin-gradle-plugin'));
  const safeP = makeProject('native-safe');
  eq('the SAFE fallback build never has the overlay (even with QR_NATIVE_MODULES=all)', run('android', safeP, { mode: 'safe', env: ALL }).code, 0);
  check('... nothing of it is there', !exists(path.join(safeP, 'android/app/src/main/java/com/techverse/quranbangla/MainActivity.kt')) && !exists(path.join(safeP, 'android/app/src/main/res/layout/qw_widget_quick.xml')));
  // the middle fallback tier, through the command line exactly as `create-project.sh nodb` runs it: the whole overlay, no kapt
  const nodbProj = makeProject('native-nodb');
  const nodbRun = run('android', nodbProj, { env: { ...ALL, QR_NATIVE_DB: 'off' } });
  eq('QR_NATIVE_DB=off succeeds', nodbRun.code, 0, nodbRun.out);
  const nodbG = read(path.join(nodbProj, 'android/app/build.gradle'));
  check('nodb: Kotlin yes, kapt / Room compiler no, Room runtime yes', nodbG.includes("apply plugin: 'kotlin-android'") && !/kotlin-kapt|room-compiler|room\.schemaLocation/.test(nodbG) && nodbG.includes('androidx.room:room-runtime:2.8.4'));
  check('nodb: the whole overlay is still there (widgets, reminders, bridge, manifest components)', exists(path.join(nodbProj, 'android/app/src/main/java/com/techverse/quranbangla/widgets/WidgetUpdater.kt')) && exists(path.join(nodbProj, 'android/app/src/main/java/com/techverse/quranbangla/reminders/ReminderScheduler.kt')) && read(path.join(nodbProj, 'android/app/src/main/AndroidManifest.xml')).includes('android.permission.SCHEDULE_EXACT_ALARM'));
  const nodbAgain = run('android', nodbProj, { env: { ...ALL, QR_NATIVE_DB: 'off' } });
  eq('nodb: a second run succeeds and changes nothing', nodbAgain.code, 0, nodbAgain.out);
  eq('nodb: the Gradle file is identical after the second run', read(path.join(nodbProj, 'android/app/build.gradle')), nodbG);
  const badDb = run('android', makeProject('native-baddb'), { env: { ...ALL, QR_NATIVE_DB: 'maybe' } });
  check('an unknown QR_NATIVE_DB value is rejected', badDb.code === 1 && /QR_NATIVE_DB must be "on" or "off"/.test(badDb.out), badDb.out);
  const bad = run('android', makeProject('native-badenv'), { env: { QR_NATIVE_MODULES: 'some' } });
  check('an unknown QR_NATIVE_MODULES value is rejected', bad.code === 1 && /QR_NATIVE_MODULES must be "all" or "none"/.test(bad.out), bad.out);

  const custom = makeProject('native-custommain', { mainActivity: 'package com.techverse.quranbangla;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {\n  @Override protected void onStart() { super.onStart(); }\n}\n' });
  const rc = run('android', custom, { env: ALL });
  check('a MainActivity that was edited by hand is never overwritten: clear error', rc.code === 1 && /MainActivity\.java was changed/.test(rc.out), rc.out);
  check('... and nothing was written (no half patched project)', !exists(path.join(custom, 'android/app/src/main/java/com/techverse/quranbangla/MainActivity.kt')) && !read(path.join(custom, 'android/build.gradle')).includes('kotlin-gradle-plugin') && !read(path.join(custom, 'android/app/src/main/res/layout/qw_widget_quick.xml', '..', '..', '..', 'AndroidManifest.xml')).includes('NextPrayerWidget'));
  const noAgp = makeProject('native-noagp', { rootGradle: ROOT_GRADLE.replace(/classpath 'com\.android\.tools\.build:gradle:[^']*'/, '') });
  const rn = run('android', noAgp, { env: ALL });
  check('a root build.gradle without the Android Gradle plugin line: clear error, nothing written', rn.code === 1 && /Android Gradle plugin classpath line was not found/.test(rn.out) && !exists(path.join(noAgp, 'android/app/src/main/java/com/techverse/quranbangla/MainActivity.kt')), rn.out);
  const kts = makeProject('native-kts', { kts: true });
  const rk = run('android', kts, { env: ALL });
  check('a Kotlin DSL project is refused with a clear message', rk.code === 1 && /Groovy Gradle files/.test(rk.out), rk.out);
  const noMain = makeProject('native-nomain', { noMainActivity: true });
  eq('a project without any MainActivity file still gets MainActivity.kt', run('android', noMain, { env: ALL }).code, 0);
  check('... installed', exists(path.join(noMain, 'android/app/src/main/java/com/techverse/quranbangla/MainActivity.kt')));
}

// -------------------------------------------------------------------------------------------------------- report
if (process.env.QR_SELFTEST_KEEP === '1') console.log('test projects kept in ' + TMP);
else fs.rmSync(TMP, { recursive: true, force: true });
if (failures.length) {
  console.log(`\nself-test FAILED: ${failures.length} problem(s), ${passed} check(s) passed`);
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
console.log(`self-test OK: ${passed} checks passed`);
