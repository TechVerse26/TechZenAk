'use strict';
// The Android launch splash is drawn in code: app/js/splash.js (inline SVG + CSS animation), started by js/platform.js, in the app only.
// These tests need no browser: they read the source files and check the contract between them. The behaviour in a real browser is
// tests/ui/splash.ui.test.js.
//
//   node --test tests/splash.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));
// source without comments (a // inside a string is not met in these files)
const code = (f) => read(f).replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '');

const SPLASH = 'app/js/splash.js';
const text = read(SPLASH);

// the artwork arrays of splash.js, evaluated on their own
function artwork() {
  const grab = (name) => {
    const m = new RegExp('var ' + name + ' = (\\[[\\s\\S]*?\\n  \\]);').exec(text);
    assert.ok(m, name + ' array found');
    return vm.runInNewContext(m[1]);
  };
  return { logo: grab('LOGO'), word: grab('WORD') };
}
// the bounding box of a path made of "M x y l dx dy ... z" (absolute start, relative lines - how the artwork is stored)
function bbox(d) {
  const nums = (s) => (s.match(/-?\d*\.?\d+/g) || []).map(Number);
  const out = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let n = 0;
  for (const sub of d.split('M').filter(Boolean)) {
    const [start, rest] = sub.split('l');
    const [x0, y0] = nums(start);
    let x = x0, y = y0;
    const add = () => { out.x0 = Math.min(out.x0, x); out.x1 = Math.max(out.x1, x); out.y0 = Math.min(out.y0, y); out.y1 = Math.max(out.y1, y); n++; };
    add();
    const v = nums(rest.replace(/z\s*$/, ''));
    assert.equal(v.length % 2, 0, 'pairs of numbers');
    for (let i = 0; i < v.length; i += 2) { x += v[i]; y += v[i + 1]; add(); }
  }
  out.points = n;
  return out;
}

test('there is no animation JSON, no Lottie runtime and no vendoring tool any more', () => {
  for (const f of ['assets/animations/quran-bangla-splash.json', 'assets/vendor/lottie/lottie_svg.min.js', 'android-build/vendor-lottie.mjs', '.github/workflows/vendor-lottie.yml', 'docs/LOTTIE_SPLASH_BN.md', 'tests/helpers/lottie-runtime-stub.js']) {
    assert.ok(!exists(f), f + ' was removed');
  }
  assert.ok(!/"assets"/.test(read('scripts/web/bundle-config.json')), 'the bundle no longer lists the removed assets/ folder (the build stops when a listed folder is missing)');
  const grep = (f) => /lottie|bodymovin|quran-bangla-splash\.json/i.test(code(f));
  for (const f of [SPLASH, 'js/platform.js', 'app/js/boot.js', 'app/js/native.js']) assert.ok(!grep(f), f + ' does not mention Lottie');
});

test('js/platform.js starts the splash only inside the app, after the website early-return, with one file', () => {
  const p = code('js/platform.js');
  const stop = p.indexOf('if(!P.isApp) return;');
  const start = p.indexOf('startSplash');
  assert.ok(stop > 0 && start > stop, 'the website returns before the splash is even defined');
  const m = /var SPLASH_FILES\s*=\s*\{([\s\S]*?)\}/.exec(p);
  assert.ok(m, 'SPLASH_FILES found');
  assert.deepEqual([...m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((x) => [x[1], x[2]]), [['script', SPLASH]], 'exactly one file: the script');
  assert.ok(exists(SPLASH));
  assert.match(p, /s\.src = SPLASH_FILES\.script;/);
  assert.doesNotMatch(p, /rel: 'preload'[^}]*splash/, 'nothing else is preloaded for the splash');
  assert.ok(!/APP_SCRIPTS\s*=\s*\[[^\]]*splash/.test(p), 'splash.js is not in APP_SCRIPTS (those run only after DOMContentLoaded)');
});

test('the existing native splash / boot safety nets are unchanged', () => {
  const p = code('js/platform.js');
  assert.match(p, /var BOOT_TIMEOUT_MS = 12000;/);
  assert.match(p, /setTimeout\(hideSplash, 9000\)/);
  assert.match(p, /c\.Plugins\.SplashScreen\.hide\(\{ fadeOutDuration: 180 \}\)/);
  assert.match(read('android-build/apply-native-patches.mjs'), /launchShowDuration:\s*8000/);
});

test('markReady() leaves the native splash to the splash while it holds it; fail() always releases it', () => {
  const p = code('js/platform.js');
  assert.match(p, /if\(!\(P\.splash && P\.splash\.holdsNative\)\) hideSplash\(\)/);
  assert.match(p, /if\(P\.splash\) P\.splash\.holdsNative = false;\s*hideSplash\(\);/);
  assert.match(p, /var splash = P\.splash = \{ holdsNative: !!P\.isNative, started: false, gaveUp: false, files: SPLASH_FILES \}/);
});

test('platform.js has its own last-resort timer, so a broken splash.js can never keep the overlay on screen', () => {
  const p = code('js/platform.js');
  assert.match(p, /var SPLASH_LAST_RESORT_MS = 16000;/);
  assert.match(p, /setTimeout\(lastResort, SPLASH_LAST_RESORT_MS\)/);
  assert.match(p, /s\.onerror = function\(\)\{ giveUp\('app\/js\/splash\.js failed to load'\); \}/);
  assert.match(p, /SPLASH_START_TIMEOUT_MS = 5000/);
});

test('the website never references the launch splash', () => {
  assert.doesNotMatch(read('index.html'), /splash\.js|qa-splash/);
  const data = read('js/data.js');
  for (const name of ['APP_SHELL_CORE', 'APP_SHELL_DEFERRED']) {
    const m = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;').exec(data);
    assert.ok(m);
    assert.doesNotMatch(m[1], /splash|lottie/i, name + ' does not list splash files');
  }
  assert.doesNotMatch(read('sw.js'), /splash/i);
  for (const f of fs.readdirSync(path.join(ROOT, 'css'))) if (f.endsWith('.css')) assert.doesNotMatch(read('css/' + f), /qa-splash|qa-sp-/, 'css/' + f);
});

test('the app asks the service worker to keep the splash script for offline starts', () => {
  const boot = code('app/js/boot.js');
  assert.match(boot, /P\.splash && P\.splash\.files/);
  assert.match(boot, /\[sp\.script\]\.filter\(Boolean\)/);
  assert.match(code(SPLASH), /type: 'CACHE_ASSETS', urls: \[FILES\.script \|\| 'app\/js\/splash\.js'\]/);
});

test('the service-worker cache generation was bumped (platform.js / boot.js / native.js / splash.js are served cache-first)', () => {
  const m = /const SW_VERSION = '(v\d+\.\d+\.\d+\.\d+)'/.exec(read('js/data.js'));
  assert.ok(m, 'SW_VERSION found');
  assert.notEqual(m[1], 'v1.03.03.01810', 'the generation before the code-drawn splash and the permission / widget screens');
  assert.notEqual(m[1], 'v1.03.03.01808');
});

test('native.js keeps its hands off the system bars while the splash holds them', () => {
  const nat = code('app/js/native.js');
  assert.match(nat, /var hold = P\.splash;\s*if\(hold && hold\.barsHeld\)\{ hold\.pendingScheme = scheme; return; \}/);
});

test('splash.js is self-contained: no network, no JSON, no URL, no other file', () => {
  const c = code(SPLASH);
  assert.doesNotMatch(c, /\bfetch\s*\(|XMLHttpRequest|\bimport\s*\(|https?:\/\/|\.json['"]|\bnew Image\b|<img|<image|url\(\s*['"]?(?!#)/i);
  assert.doesNotMatch(c, /createElement\('script'\)|createElement\("script"\)|\.src\s*=/, 'it loads no script either');
  new vm.Script(text);        // and it is valid JavaScript
});

test('splash.js does nothing when it is not the Android app (website guard), nothing twice, nothing after platform.js gave up', () => {
  const c = code(SPLASH);
  assert.match(c, /if\(!P \|\| !P\.isApp \|\| !S \|\| S\.started \|\| S\.gaveUp\) return;\s*S\.started = true;/);
  // run it as the website: no QR_PLATFORM / not the app -> nothing is created
  const created = [];
  const doc = { documentElement: { appendChild: () => created.push('overlay') }, head: { appendChild: () => created.push('style') }, getElementById: () => null, createElement: () => ({}) };
  for (const P of [undefined, { isApp: false, splash: {} }, { isApp: true, splash: { started: true } }, { isApp: true, splash: { gaveUp: true } }, { isApp: true }]) {
    vm.runInNewContext(text, { window: { QR_PLATFORM: P, addEventListener() {}, matchMedia: () => ({ matches: false }) }, document: doc, console, setTimeout, clearTimeout, performance: { now: () => 0 }, Object, Array, Date, Math, CustomEvent: function () {} });
  }
  assert.deepEqual(created, [], 'no overlay, no style');
});

test('the artwork is intact: 9 logo contours, 11 wordmark letters, every path closed, everything inside its viewBox', () => {
  const { logo, word } = artwork();
  assert.equal(logo.length, 9, 'the logo has 9 contours');
  assert.equal(word.length, 11, 'Quran Bangla = 11 letters');
  const L = { x0: -172, y0: -147, x1: 172, y1: 147 }, W = { x0: -117, y0: -19, x1: 117, y1: 19 };
  let points = 0;
  for (const d of logo) {
    assert.match(d, /^M[-\d. ]+l[-\d. ]+z$/, 'a closed polygon');
    const b = bbox(d); points += b.points;
    assert.ok(b.x0 >= L.x0 && b.x1 <= L.x1 && b.y0 >= L.y0 && b.y1 <= L.y1, 'inside the logo viewBox ' + JSON.stringify(b));
  }
  assert.ok(points > 600, 'the traced logo keeps its detail (' + points + ' points)');
  let prev = -1;
  for (const [d, delay] of word) {
    assert.match(d, /^M[-\d. ]+l[-\d. ]+z(M[-\d. ]+l[-\d. ]+z)*$/, 'closed polygons (a letter and its counters)');
    const b = bbox(d);
    assert.ok(b.x0 >= W.x0 && b.x1 <= W.x1 && b.y0 >= W.y0 && b.y1 <= W.y1, 'inside the wordmark viewBox ' + JSON.stringify(b));
    assert.ok(delay >= 0 && delay <= 1 && delay >= prev, 'the letters are staggered from left to right');
    prev = delay;
  }
  assert.equal(word[0][1], 0); assert.equal(word[word.length - 1][1], 1);
});

test('the splash colour is the native splash colour (no colour jump when the native splash hands over)', () => {
  const theme = JSON.parse(read('manifest.json')).theme_color;
  const bg = /var BG = '(#[0-9A-Fa-f]{6})'/.exec(text);
  assert.ok(bg, 'BG found in splash.js');
  assert.equal(bg[1].toLowerCase(), theme.toLowerCase(), 'splash.js BG = manifest.json theme_color');
  // the patcher paints the native splash (qr_splash_background, windowSplashScreenBackground) with that same theme colour
  const patch = read('android-build/apply-native-patches.mjs');
  assert.match(patch, /qr_splash_background">' \+ ctx\.theme/);
  assert.match(text, /background:' \+ BG \+ ';opacity:1;/, 'the overlay itself has that colour');
});

test('the first frame is the plain splash colour: every layer on top of it fades in from nothing', () => {
  assert.match(text, /\.qa-sp-vignette\{[^}]*animation:qa-sp-in 900ms ease-out both;/);
  assert.match(text, /\.qa-sp-glow\{[^}]*animation:qa-sp-in 1200ms ease-out both/);
  assert.match(text, /\.qa-sp-fill\{[^}]*animation:qa-sp-in 650ms/);
  assert.match(text, /\.qa-sp-line\{[^}]*stroke-dashoffset:1;/, 'the lines start undrawn');
  assert.match(text, /\.qa-sp-bar\{[^}]*animation:qa-sp-in 500ms/);
  assert.match(text, /el\.className = 'qa-sp-wait'/, 'created paused ...');
  assert.match(text, /el\.classList\.remove\('qa-sp-wait'\)/, '... and started only after the first frame and the native fade');
  assert.match(text, /'#qa-splash\.qa-sp-wait \*\{animation-play-state:paused!important;\}'/);
});

test('smooth by construction: only transform / opacity / stroke are animated - no blur, shadow, filter, mask or layout property', () => {
  const css = /var CSS =([\s\S]*?);\n\n  var el = null/.exec(text);
  assert.ok(css, 'CSS found');
  const style = css[1];
  assert.doesNotMatch(style, /filter\s*:|blur\(|box-shadow|text-shadow|backdrop-filter|mask|clip-path/i);
  for (const m of style.matchAll(/@keyframes ([\w-]+)\{([^@]*?\}\})/g)) {
    const props = [...m[2].matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]);
    for (const p of props) assert.ok(['opacity', 'transform', 'stroke-dashoffset', 'stroke-opacity'].includes(p), `@keyframes ${m[1]} animates "${p}"`);
  }
  assert.match(style, /will-change:transform,opacity/);
});

test('"remove animations" (prefers-reduced-motion) gets the finished logo and one calm fade', () => {
  assert.match(text, /prefers-reduced-motion: reduce/);
  assert.match(text, /'#qa-splash\.qa-sp-still \*\{animation:none!important;\}'/);
  assert.match(text, /still: 1100/);
});

test('timing: a splash worth watching, never a wait', () => {
  const t = (n) => Number(new RegExp(n + ':\\s*(\\d+)').exec(text)[1]);
  assert.ok(t('minShow') >= 1500 && t('minShow') <= 2600, 'the animation plays about two seconds');
  assert.ok(t('leave') <= 500, 'a quick fade-out');
  assert.ok(t('nativeFade') >= 180, 'starts after the native fade (platform.js uses 180 ms)');
  assert.ok(t('hardCap') < 16000, 'inside the last-resort timer of platform.js');
  assert.ok(t('afterPaint') <= 300);
  // the leave rule: both the animation and the app UI
  assert.match(text, /function maybeFinish\(\)\{\s*if\(finished \|\| !animDone \|\| !appReady\) return;\s*leave\(\);/);
});

test('the system bars take the splash colour while it is up (and only when it is not the website)', () => {
  assert.match(text, /function holdBars\(\)\{\s*if\(barsHeld \|\| !P\.isNative\) return;[\s\S]*paintBars\(BG, 'DARK'\)/);
  assert.match(text, /N\.setSystemBars\(scheme\)/);
});

test('accessibility: the overlay is one labelled image, the artwork is hidden from screen readers', () => {
  assert.match(text, /setAttribute\('role', 'img'\)/);
  assert.match(text, /setAttribute\('aria-label', 'Quran Bangla'\)/);
  assert.equal((text.match(/aria-hidden="true"/g) || []).length >= 4, true);
});
