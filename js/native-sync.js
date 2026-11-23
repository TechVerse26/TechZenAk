// ---------- App state -> native layer (home screen widgets and alarms) ----------
//
// Widgets and alarms run outside the web view, so they cannot read the app's storage. This pushes the few facts they need -
// the last read ayah, the prayer location and method, the reading streak, the reading plan, the language - through the typed
// bridge (js/quran-native.js, source src/native/quran-native.ts) whenever they change.
//
// How it stays cheap and reliable:
//   * it never touches the app's own functions (no wrapping of save*): it LOOKS at the state on a few moments
//   * moments: shortly after start, when the app goes to the background (the important one: that is when the user goes to the
//     home screen and looks at the widget), when it comes back, and every 30 s while it is on screen
//   * the bridge client compares the new snapshot with the last one it sent and sends only a real change
// Only present in the standalone app bundle (window.QR_STANDALONE); a no-op where there is no native layer.
(function () {
  'use strict';
  var w = window;
  if (!w.QR_STANDALONE || w.__qrNativeSync) return;
  w.__qrNativeSync = true;

  var FIRST_PUSH_MS = 3000;
  var TICK_MS = 30000;

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  // top level `const` of a classic script (state) is not a property of window - it is reached by its bare name
  function appState() { return safe(function () { return typeof state !== 'undefined' ? state : null; }, null) || {}; }
  function fn(name) { return safe(function () { return typeof w[name] === 'function' ? w[name] : null; }, null); }

  function snapshot() {
    var api = w.QR_NATIVE_API;
    if (!api) return null;
    var s = appState();
    var computeStreak = fn('computeStreak'), loadActivity = fn('loadActivity'), loadPlanners = fn('loadPlanners'), todayStr = fn('todayStr');
    return api.buildSnapshot({
      language: s.language,
      translationEdition: s.translationEdition,
      lastRead: s.lastRead,
      prayerLocation: s.prayerLocation,
      prayerMethod: s.prayerMethod,
      prayerSchool: 0, // the app has no Asr school setting yet; 0 = the same default as the website (Al-Adhan school 0)
      ayahsRead: s.ayahsRead,
      streak: computeStreak && loadActivity ? safe(function () { return computeStreak(loadActivity()); }, 0) : 0,
      planners: loadPlanners ? safe(loadPlanners, []) : [],
      today: todayStr ? safe(todayStr, '') : new Date().toISOString().slice(0, 10)
    });
  }

  // now = true flushes immediately (the web view may be frozen a moment later)
  function push(now) {
    var client = w.QR_NATIVE;
    if (!client || !client.isAvailable()) return;
    var snap = snapshot();
    if (!snap) return;
    client.syncState(snap);
    if (now) client.flush();
  }

  setTimeout(function () { push(false); }, FIRST_PUSH_MS);
  setInterval(function () { if (!w.document || w.document.visibilityState !== 'hidden') push(false); }, TICK_MS);
  if (w.document && w.document.addEventListener) {
    w.document.addEventListener('visibilitychange', function () { push(w.document.visibilityState === 'hidden'); });
  }
  if (w.addEventListener) {
    w.addEventListener('pagehide', function () { push(true); });
    w.addEventListener('online', function () { push(false); });
  }
  w.QR_NATIVE_SYNC = { push: push, snapshot: snapshot };
})();
