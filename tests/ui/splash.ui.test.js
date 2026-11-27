'use strict';
// Browser tests of the Android launch splash (drawn in code: app/js/splash.js).
//
//   node --test tests/ui/splash.ui.test.js     (needs `playwright` + a Chromium build; PLAYWRIGHT_MODULE=/path/to/playwright if it is global)
//
// What runs: the REAL app (index.html -> js/platform.js -> app/js/splash.js + app/js/*, incl. the app's own boot) in headless Chromium,
// with the Capacitor native shell simulated (Capacitor.getPlatform() = 'android', plugin calls recorded). There is nothing to stand in
// for - the splash has no animation file and no runtime - so the pictures and timings checked here are what the phone runs.
//
// What is NOT covered: Android itself (the real system splash screen, a real WebView, a real GPU). External hosts (Firebase, CDNs) are
// blocked, so the app runs offline.
const test = require('node:test');
const assert = require('node:assert/strict');

const H = require('../helpers/splash-harness');
const { pw, SKIP, SCRIPT, DESKTOP_UA } = H;

let browser = null;
test.before(async () => {
  if (!pw) return;
  try { browser = await pw.chromium.launch(); } catch (e) { browser = null; }
});
test.after(async () => { if (browser) await browser.close(); });

const launch = (o) => H.launch(browser, o);
const mark = (st, name) => { const m = st.tl.find((x) => x[0] === name); return m ? m[1] : undefined; };
const guard = (t) => { if (!browser) { t.skip('Chromium could not be launched'); return false; } return true; };
const opts = (extra) => Object.assign({ skip: SKIP, timeout: 90000 }, extra);
const SLOW_APP = { delay: { '/app/js/boot.js': 9000 } };          // the app UI is not ready for a long time: the overlay stays

// The screenshot of the page, decoded by Chromium itself (no image library needed) and measured THERE: only the numbers asked for come back.
//   look(L, box, { count: '(r, g, b) => ...', at: [[x, y], ...] }) -> { w, h, total, count, at: [[r, g, b], ...] }   (x, y in screenshot pixels)
async function look(L, box, ask) {
  const png = await L.page.screenshot({ clip: box });
  const dec = await L.ctx.newPage();
  try {
    return await dec.evaluate(async (a) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + a.b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      const out = { w: img.width, h: img.height, total: img.width * img.height, count: 0, at: [] };
      if (a.count) { const fn = new Function('return ' + a.count)(); for (let i = 0; i < d.length; i += 4) if (fn(d[i], d[i + 1], d[i + 2])) out.count++; }
      for (const [x, y] of a.at || []) { const i = (y * img.width + x) * 4; out.at.push([d[i], d[i + 1], d[i + 2]]); }
      return out;
    }, { b64: png.toString('base64'), count: (ask || {}).count, at: (ask || {}).at });
  } finally { await dec.close(); }
}
// freeze every animation of the page at time t (ms from the start of the animation)
const freezeAt = (L, t) => L.page.evaluate((t) => { document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t; }); return document.getAnimations().length; }, t);

test('plays once; the native splash is released after the first frame; the overlay waits for the animation when the app is ready first', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch();
  try {
    await L.open(); await L.done();
    const st = await L.state();
    assert.equal(st.info.mode, 'code');
    assert.equal(st.hide.length >= 1, true, 'the native splash was released');
    assert.ok(st.hide[0].t >= st.info.startMs + st.info.firstFrameMs - 5, 'not before the first frame of the splash is on screen');
    assert.ok(st.info.playMs - st.info.firstFrameMs >= 190, 'the animation starts after the native fade-out, so no frame is hidden under it');
    assert.ok(mark(st, 'app-ready') < st.info.startMs + st.info.completeMs, 'precondition: the app UI was ready before the animation finished');
    assert.ok(mark(st, 'splash-done') >= st.info.startMs + st.info.playMs + 1950, 'the overlay stayed for the whole animation (about 2 s)');
    assert.equal(st.overlay, false); assert.equal(st.style, false, 'overlay and its style are removed');
    assert.equal(st.body, 'visible', 'the app UI is there');
    assert.equal(st.holds, false);
    assert.equal(st.phase, 'done');
    assert.equal(L.errors.length, 0, 'no page errors: ' + L.errors.join(' | '));
  } finally { await L.close(); }
});

test('nothing but the one script is fetched for the splash: no JSON, no runtime, no image', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch();
  try {
    await L.open(); await L.done();
    const hits = L.srv.hits.filter((h) => /splash|lottie|assets\/|animations/i.test(h));
    assert.deepEqual(hits, [SCRIPT], 'only app/js/splash.js');
  } finally { await L.close(); }
});

test('the very first frame is the plain native splash colour; the animation starts paused and is started after the native fade', opts(), async (t) => {
  if (!guard(t)) return;
  // a MutationObserver looks at the overlay in the same task in which splash.js inserted it: no timing luck involved
  const watch = `new MutationObserver(function(){
    var ov = document.getElementById('qa-splash');
    if(!ov || window.__first) return;
    var animated = [].slice.call(ov.querySelectorAll('*')).filter(function(e){ return getComputedStyle(e).animationName !== 'none'; });
    // only the splash's own animations (the app UI under it has CSS transitions of its own that start with the page)
    var mine = document.getAnimations().filter(function(a){ return a.effect && a.effect.target && ov.contains(a.effect.target); });
    window.__first = {
      cls: ov.className, bg: getComputedStyle(ov).backgroundColor, animated: animated.length, anims: mine.length,
      allPaused: animated.every(function(e){ return !/running/.test(getComputedStyle(e).animationPlayState); }),
      advanced: mine.some(function(a){ return a.currentTime > 0; }),
      phase: window.QR_PLATFORM.splash.phase, nativeHides: window.__native.splashHide.length
    };
  }).observe(document, { childList: true, subtree: true });`;
  const L = await launch({ server: SLOW_APP, init: watch });
  try {
    await L.open();
    await L.page.waitForFunction(() => window.__first, null, { timeout: 8000 });
    const first = await L.page.evaluate(() => window.__first);
    assert.equal(first.bg, 'rgb(9, 39, 35)', 'exactly the colour of the native splash (manifest theme_color #092723)');
    assert.match(first.cls, /qa-sp-wait/, 'created in the waiting state');
    assert.ok(first.animated >= 25 && first.anims >= 30, 'the animations exist ...');
    assert.equal(first.allPaused, true, '... every one of them is paused ...');
    assert.equal(first.advanced, false, '... and none has advanced');
    assert.equal(first.phase, 'building');
    assert.equal(first.nativeHides, 0, 'the native splash is still on screen: nothing is released before something is painted');
    await freezeAt(L, 0);
    await L.page.waitForTimeout(80);
    const shot = await look(L, { x: 0, y: 0, width: 412, height: 915 }, { count: '(r, g, b) => Math.abs(r - 9) <= 1 && Math.abs(g - 39) <= 1 && Math.abs(b - 35) <= 1' });
    assert.ok(shot.count / shot.total > 0.999, 'at time 0 every pixel is #092723 - no colour jump when the native splash hands over (' + shot.count + ' of ' + shot.total + ')');
    await L.page.waitForFunction(() => window.__native && window.__native.splashHide.length >= 1, null, { timeout: 6000 });
    const st = await L.state();
    assert.ok(st.hide[0].t >= st.info.startMs + st.info.firstFrameMs - 5, 'the native splash was released only after the splash had painted');
  } finally { await L.close(); }
});

test('the picture: the logo is drawn, filled with gold, the wordmark rises, the finished frame holds', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ server: SLOW_APP });
  try {
    await L.open(); await L.phase('playing');
    const props = (sel) => L.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => { const c = getComputedStyle(e); return { dash: parseFloat(c.strokeDashoffset), op: parseFloat(c.opacity), sop: parseFloat(c.strokeOpacity) }; }), sel);
    // t = 150 ms: the first lines have just begun, nothing is filled, no letter is there
    await freezeAt(L, 150);
    const lines0 = await props('.qa-sp-line'), fill0 = await props('.qa-sp-fill'), word0 = await props('.qa-sp-word path');
    assert.equal(lines0.length, 9); assert.equal(word0.length, 11);
    assert.ok(lines0.every((l) => l.dash > 0.9), 'the lines are still (almost) undrawn');
    assert.equal(fill0[0].op, 0); assert.ok(word0.every((w) => w.op === 0));
    // t = 700 ms: the lines are drawn for the most part, the fill has not started
    await freezeAt(L, 700);
    const lines1 = await props('.qa-sp-line'), fill1 = await props('.qa-sp-fill');
    assert.ok(lines1[0].dash < 0.35 && lines1[0].dash > 0, 'the big outline is mostly drawn at 0.7 s');
    assert.equal(fill1[0].op, 0, 'the fill waits for the drawing');
    // t = 2300 ms: everything is there
    await freezeAt(L, 2300);
    const lines2 = await props('.qa-sp-line'), fill2 = await props('.qa-sp-fill'), word2 = await props('.qa-sp-word path');
    assert.ok(lines2.every((l) => l.dash === 0), 'every line is drawn');
    assert.equal(fill2[0].op, 1); assert.ok(word2.every((w) => w.op === 1), 'the wordmark is complete');
    await L.page.waitForTimeout(80);
    // pixels of the finished frame: gold in the logo area, cream wordmark, dark emerald around
    const geo = await L.page.evaluate(() => { const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }; return { mark: r('.qa-sp-mark'), word: r('.qa-sp-word') }; });
    const logoPx = await look(L, { x: geo.mark.x, y: geo.mark.y, width: geo.mark.w, height: geo.mark.h }, { count: '(r, g, b) => r > 190 && g > 150 && b < 150 && r > b + 70' });
    assert.ok(logoPx.count > 2500, 'the logo is gold (' + logoPx.count + ' gold pixels)');
    const wordPx = await look(L, { x: geo.word.x, y: geo.word.y, width: geo.word.w, height: geo.word.h }, { count: '(r, g, b) => r > 220 && g > 215 && b > 190' });
    assert.ok(wordPx.count > 1200, 'the wordmark is cream (' + wordPx.count + ' pixels)');
    const edge = await look(L, { x: 0, y: 0, width: 40, height: 40 }, { at: [[10, 10]] });
    const [r, g, b] = edge.at[0];
    assert.ok(r < 25 && g < 60 && b < 55, 'the corners stay dark emerald (vignette): ' + [r, g, b]);
  } finally { await L.close(); }
});

test('system bars: splash colour while the splash is up, the app colour right after; the app cannot flip them in between', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch();
  try {
    await L.open(); await L.done();
    const st = await L.state();
    const e2e = st.bars.filter((b) => b.p === 'EdgeToEdge.setBackgroundColor');
    const first = e2e.findIndex((b) => b.o.color === '#092723');
    assert.ok(first >= 0, 'bars took the splash colour');
    assert.ok(first <= e2e.length - 2, 'and were set back afterwards');
    assert.notEqual(e2e[e2e.length - 1].o.color, '#092723', 'the last word is the app colour');
    assert.ok(e2e[first + 1].t >= st.info.startMs + st.info.completeMs - 60, 'nothing touched the bars while the splash was playing');
    assert.ok(st.bars.find((b) => b.p === 'SystemBars.setStyle' && b.o.style === 'DARK'), 'light icons on the dark splash');
  } finally { await L.close(); }
});

test('when the animation is faster than the app, the overlay stays until the app UI is ready', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ server: { delay: { '/app/js/boot.js': 4500 } } });
  try {
    await L.open(); await L.phase('held');
    await L.page.waitForTimeout(700);
    const mid = await L.state();
    assert.equal(mid.overlay, true, 'still on screen: the app is not ready');
    assert.equal(mid.appReady, false);
    assert.equal(mid.phase, 'held');
    // the finished logo holds still (no replay, no flicker) while it waits
    const before = await L.page.evaluate(() => document.getElementById('qa-splash').getBoundingClientRect().width);
    await L.page.waitForTimeout(400);
    assert.equal(await L.page.evaluate(() => document.getElementById('qa-splash').getBoundingClientRect().width), before);
    await L.done();
    const st = await L.state();
    assert.ok(st.info.startMs + st.info.completeMs < mark(st, 'app-ready'), 'precondition: the animation finished first');
    assert.ok(mark(st, 'splash-done') >= mark(st, 'app-ready'), 'left only after the app UI was ready');
    assert.equal(st.body, 'visible');
  } finally { await L.close(); }
});

test('leaving is a fade of about 0.4 s onto the painted app, not a cut', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch();
  try {
    await L.open(); await L.phase('leaving');
    const m = await L.page.evaluate(() => { const ov = document.getElementById('qa-splash'); return ov ? { cls: ov.className, tr: getComputedStyle(ov).transitionDuration } : null; });
    assert.ok(m, 'the overlay is still there while it fades');
    assert.match(m.cls, /qa-sp-leave/);
    assert.equal(m.tr, '0.36s');
    await L.done();
    assert.equal((await L.state()).overlay, false);
  } finally { await L.close(); }
});

test('"remove animations" (reduced motion): the finished logo and one calm fade - no drawing, nothing moving, shorter', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ reducedMotion: 'reduce' });
  try {
    await L.open(); await L.phase('playing');
    const m = await L.page.evaluate(() => {
      const ov = document.getElementById('qa-splash');
      const line = getComputedStyle(ov.querySelector('.qa-sp-line'));
      const mine = document.getAnimations().filter((a) => a.effect && a.effect.target && ov.contains(a.effect.target));     // the app UI under the splash has animations of its own
      return { cls: ov.className, dash: parseFloat(line.strokeDashoffset), running: mine.filter((a) => a.effect.getComputedTiming().iterations === Infinity).length };
    });
    assert.match(m.cls, /qa-sp-still/);
    assert.equal(m.dash, 0, 'the logo is already drawn');
    assert.equal(m.running, 0, 'nothing loops or turns');
    await L.done();
    const st = await L.state();
    assert.equal(st.info.reduced, true);
    const shown = mark(st, 'splash-done') - (st.info.startMs + st.info.playMs);
    assert.ok(shown >= 1050 && shown < 1900, 'about 1.1 s, not 2 s (' + shown + ' ms)');
  } finally { await L.close(); }
});

test('only cheap properties run while it plays: no layout, no paint of the page behind it', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ server: SLOW_APP });
  try {
    await L.open(); await L.phase('playing');
    const props = await L.page.evaluate(() => {
      const out = new Set(), ov = document.getElementById('qa-splash');
      // only the splash's own animations (the app UI under it has transitions of its own)
      document.getAnimations().filter((a) => a.effect && a.effect.target && ov.contains(a.effect.target)).forEach((a) => { a.effect.getKeyframes().forEach((k) => Object.keys(k).forEach((p) => { if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) out.add(p); })); });
      return [...out].sort();
    });
    assert.deepEqual(props, ['opacity', 'strokeDashoffset', 'strokeOpacity', 'transform']);
  } finally { await L.close(); }
});

for (const [name, server, why] of [
  ['splash.js is missing', { missing: [SCRIPT] }, /failed to load/],
  ['splash.js arrives far too late', { delay: { [SCRIPT]: 6800 } }, /did not start/]
]) {
  test('fallback: ' + name + ' -> no splash, the native splash is released, the app still starts', opts({ timeout: 60000 }), async (t) => {
    if (!guard(t)) return;
    const L = await launch({ server });
    const warns = []; L.page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
    try {
      await L.open();
      await L.page.waitForFunction(() => window.QR_PLATFORM && window.QR_PLATFORM.ready === true, null, { timeout: 30000 });
      await L.page.waitForFunction(() => window.__native.splashHide.length >= 1, null, { timeout: 10000 });
      const st = await L.state();
      assert.equal(st.overlay, false); assert.equal(st.holds, false);
      assert.equal(st.body, 'visible', 'the app UI is reachable');
      assert.ok(warns.some((w) => why.test(w)), 'the reason was logged: ' + warns.join(' | '));
      await L.page.waitForTimeout(2200);                       // a late splash.js arrives now: it must do nothing
      const late = await L.state();
      assert.equal(late.overlay, false, 'a late splash does not appear any more');
      assert.equal(late.phase, undefined);
    } finally { await L.close(); }
  });
}

test('website: no splash code is requested, nothing is created, nothing changes', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ capacitor: false, userAgent: DESKTOP_UA, viewport: { width: 1280, height: 800 } });
  try {
    await L.open();
    await L.page.waitForTimeout(2500);
    const st = await L.state();
    assert.equal(st.dataPlatform, 'web');
    assert.equal(st.isApp, false);
    assert.equal(st.hasSplash, false, 'QR_PLATFORM.splash does not exist');
    assert.equal(st.overlay, false); assert.equal(st.style, false);
    assert.deepEqual(L.srv.hits.filter((h) => /splash|lottie|assets\/|animations/i.test(h)), [], 'no request for the splash script');
    const dom = await L.page.evaluate(() => document.documentElement.outerHTML);
    assert.doesNotMatch(dom, /lottie|qa-splash|qa-sp-/i);
  } finally { await L.close(); }
});

test('the app UI disabled for the session (existing recovery flag) -> no splash either', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ init: "try{sessionStorage.setItem('qa_disabled','1')}catch(e){}" });
  try {
    await L.open();
    await L.page.waitForTimeout(2000);
    const st = await L.state();
    assert.equal(st.isApp, false);
    assert.equal(st.overlay, false);
    assert.deepEqual(L.srv.hits.filter((h) => /splash/i.test(h)), []);
    assert.ok(st.hide.length >= 1, 'the native splash is still released by the existing website path');
  } finally { await L.close(); }
});

test('returning from the background does not replay the animation or create a second overlay', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch();
  try {
    await L.open(); await L.done();
    await L.page.evaluate(() => {
      ['visibilitychange', 'pageshow', 'focus', 'online', 'resume'].forEach((n) => { try { document.dispatchEvent(new Event(n)); window.dispatchEvent(new Event(n)); } catch (e) {} });
    });
    await L.page.waitForTimeout(900);
    const st = await L.state();
    assert.equal(st.overlay, false);
    assert.equal(L.srv.hits.filter((h) => h === SCRIPT).length, 1);
  } finally { await L.close(); }
});

test('every fresh application start plays the splash exactly once', opts(), async (t) => {
  if (!guard(t)) return;
  const L = await launch();
  try {
    for (let i = 0; i < 3; i++) {
      await L.open(); await L.done();
      const st = await L.state();
      assert.equal(st.info.mode, 'code', 'start #' + (i + 1));
      assert.ok(st.info.completeMs >= 1900, 'start #' + (i + 1) + ': the whole animation played');
    }
  } finally { await L.close(); }
});

for (const [w, h, name] of [[320, 568, 'small phone'], [360, 640, 'phone'], [412, 915, 'tall phone'], [768, 1024, 'tablet portrait'], [915, 412, 'phone landscape'], [640, 360, 'small landscape']]) {
  test('layout on a ' + name + ' (' + w + 'x' + h + '): full screen, centred, everything inside the screen', opts(), async (t) => {
    if (!guard(t)) return;
    const L = await launch({ viewport: { width: w, height: h }, server: SLOW_APP });
    try {
      await L.open(); await L.phase('playing');
      await freezeAt(L, 2300);
      const m = await L.page.evaluate(() => {
        const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        const ov = document.getElementById('qa-splash');
        return { vp: { w: innerWidth, h: innerHeight }, ov: r('#qa-splash'), mark: r('.qa-sp-mark'), word: r('.qa-sp-word'), bar: r('.qa-sp-bar'), bg: getComputedStyle(ov).backgroundColor, pos: getComputedStyle(ov).position, z: getComputedStyle(ov).zIndex, sw: document.documentElement.scrollWidth };
      });
      assert.deepEqual([m.ov.x, m.ov.y, m.ov.w, m.ov.h], [0, 0, m.vp.w, m.vp.h], 'covers the whole viewport');
      assert.equal(m.bg, 'rgb(9, 39, 35)'); assert.equal(m.pos, 'fixed'); assert.equal(m.z, '2147483647');
      const near = (a, b) => Math.abs(a - b) <= 1.5;
      for (const k of ['mark', 'word', 'bar']) {
        assert.ok(near(m[k].x + m[k].w / 2, m.vp.w / 2), k + ' is centred (' + (m[k].x + m[k].w / 2).toFixed(1) + ' vs ' + m.vp.w / 2 + ')');
        assert.ok(m[k].x >= 8 && m[k].x + m[k].w <= m.vp.w - 8, k + ' is inside the width');
        assert.ok(m[k].y >= 8 && m[k].y + m[k].h <= m.vp.h - 8, k + ' is inside the height');
      }
      assert.ok(m.mark.y + m.mark.h < m.word.y && m.word.y + m.word.h < m.bar.y, 'logo above wordmark above the light');
      assert.ok(Math.abs(m.mark.w / m.mark.h - 344 / 294) < 0.01, 'the logo is never stretched');
      assert.ok(m.sw <= m.vp.w, 'no horizontal scroll');
    } finally { await L.close(); }
  });
}

test('existing recovery still works: when the app UI never starts, the 12 s watchdog reloads into the website UI and the splash is gone', opts({ timeout: 80000 }), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ server: { delay: { '/app/js/boot.js': 40000 } } });
  try {
    await L.open();
    await L.page.waitForFunction(() => { try { return sessionStorage.getItem('qa_disabled') === '1' && window.QR_PLATFORM && window.QR_PLATFORM.isApp === false; } catch (e) { return false; } }, null, { timeout: 40000 });
    await L.page.waitForFunction(() => window.__native && window.__native.splashHide.length >= 1, null, { timeout: 8000 });
    const st = await L.state();
    assert.equal(st.dataPlatform, 'web', 'the plain website UI');
    assert.equal(st.overlay, false, 'no splash left on screen');
    assert.equal(st.body, 'visible');
  } finally { await L.close(); }
});

test('first launch: the splash script reaches the service worker as soon as it is active, long before the app is idle', opts({ timeout: 90000 }), async (t) => {
  if (!guard(t)) return;
  // boot.js is held back, so the app's own "idle" precache cannot be what caches the file
  const L = await launch({ serviceWorkers: 'allow', server: { delay: { '/app/js/boot.js': 12000 } } });
  try {
    await L.open(); await L.phase('held');
    const none = await L.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    assert.equal(none, 0, 'precondition: no service worker yet');
    await L.page.evaluate(() => navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => true));
    let missing = ['(not checked yet)'];
    for (let i = 0; i < 30 && missing.length; i++) {
      missing = await L.page.evaluate(async () => { const out = []; for (const u of ['app/js/splash.js']) if (!(await caches.match(u))) out.push(u); return out; });
      if (missing.length) await L.page.waitForTimeout(400);
    }
    assert.deepEqual(missing, [], 'cached by the service worker');
    assert.equal((await L.state()).appReady, false, 'and the app was still not ready - boot.js idle precache did not do it');
  } finally { await L.close(); }
});

test('cached / offline start: the second launch plays the splash from the service-worker cache', opts({ timeout: 120000 }), async (t) => {
  if (!guard(t)) return;
  const L = await launch({ serviceWorkers: 'allow' });
  try {
    await L.open(); await L.done();
    await L.page.evaluate(() => navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => true));
    let missing = ['(not checked yet)'];
    for (let i = 0; i < 120 && missing.length; i++) {          // polled from here: Playwright does not await an async page predicate
      missing = await L.page.evaluate(async () => {
        const P = window.QR_PLATFORM;
        const out = [];
        for (const u of [].concat(P.styles, P.scripts, [P.splash.files.script])) if (!(await caches.match(u))) out.push(u);
        return out;
      });
      if (missing.length) await L.page.waitForTimeout(500);
    }
    assert.deepEqual(missing, [], 'the service worker cached the app UI files and the splash script');
    await L.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await L.ctx.setOffline(true);                      // from here on nothing can reach the server: what plays comes from the cache
    await L.page.reload({ waitUntil: 'commit' });
    await L.done();
    const st = await L.state();
    assert.equal(st.info.mode, 'code', 'the splash played without any connection');
    assert.equal(st.body, 'visible');
  } finally { await L.close(); }
});
