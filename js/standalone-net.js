// ---------- Standalone app networking (only present in the Android bundle) ----------
//
// build/www/index.html (made by scripts/web/build-web.mjs) defines window.QR_STANDALONE before anything else runs. This
// file does nothing when that object is missing, so the website is never affected - it is not even loaded there.
//
// It wraps window.fetch ONCE, so no other file had to change, and does three jobs:
//   1. Quran requests for bundled editions are answered from the APK (js/local-data.js) - no network needed, ever.
//   2. Relative backend calls (/api/ai-tafsir, /api/story-submit ...) are sent to the hosted backend (siteUrl),
//      because the app's own origin (https://localhost) has no server. The backend answers CORS (api/_cors.js).
//   3. The service worker does not run inside the app, so GET responses of the public data APIs (other translations,
//      prayer times, hadith) get a small cache here: network first, last good answer when the network is gone.
//   4. Prayer times and the Hijri date: Al-Adhan is asked first, exactly as on the website; when it cannot be reached (offline,
//      or no answer within a few seconds) they are CALCULATED on the device (js/prayer-calc.js). For "today" the calculation is
//      preferred over a remembered answer, because the remembered one may be from yesterday.
// The app never waits for the network at start-up: everything it needs to open is local.
(function () {
  'use strict';
  var w = window;
  var cfg = w.QR_STANDALONE;
  if (!cfg || w.__qrStandaloneNet) return;
  w.__qrStandaloneNet = true;

  var realFetch = w.fetch ? w.fetch.bind(w) : null;
  if (!realFetch || typeof Response === 'undefined') return;

  var CACHE_NAME = 'qr-api-standalone-v1';
  var CACHE_MAX_ENTRIES = 400;
  var EDITION_LIST_TIMEOUT_MS = 6000;
  var CALC_TIMEOUT_MS = Number(cfg.calcTimeoutMs) > 0 ? Number(cfg.calcTimeoutMs) : 5000;
  var CACHEABLE_HOSTS = /^https:\/\/(?:api\.alquran\.cloud|api\.aladhan\.com)\/|^https:\/\/cdn\.jsdelivr\.net\/gh\/fawazahmed0\/hadith-api/;

  function ls() { try { return w.localStorage; } catch (e) { return null; } }
  var storage = {
    get: function (k) { var s = ls(); return s ? s.getItem(k) : null; },
    set: function (k, v) { var s = ls(); if (s) s.setItem(k, v); }
  };

  // ---- local Quran data ----
  var dataBase = (cfg.dataBase || 'data/quran/').replace(/\/?$/, '/');
  var local = (w.QR_LOCAL_DATA && w.QR_LOCAL_DATA.create) ? w.QR_LOCAL_DATA.create({
    apiBase: cfg.apiBase || 'https://api.alquran.cloud/v1',
    storage: storage,
    read: function (rel) {
      // the bundle is read with the ORIGINAL fetch (this wrapper would loop); it is a same-origin file of the app
      return realFetch(dataBase + rel, { cache: 'force-cache' }).then(function (r) {
        if (!r.ok) throw new Error('missing bundled file ' + rel);
        return r.arrayBuffer();
      });
    },
    sha256: (w.crypto && w.crypto.subtle) ? function (buf) {
      return w.crypto.subtle.digest('SHA-256', buf).then(function (d) {
        var b = new Uint8Array(d), s = '';
        for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
        return s;
      });
    } : null
  }) : null;
  w.QR_LOCAL = local;
  if (local) local.whenReady().then(function () {
    var d = local.describe();
    if (d.status !== 'ready') { try { console.warn('[standalone] bundled Quran data not used:', d.status, d.reason); } catch (e) { /* console missing */ } }
    try { w.dispatchEvent(new CustomEvent('qr:local-data', { detail: d })); } catch (e) { /* old WebView */ }
  });

  // ---- offline prayer times ----
  var calc = w.QR_PRAYER_CALC || null;

  // GET api.aladhan.com/v1/timings?latitude=&longitude=&method=[&school=]  |  /v1/timings/DD-MM-YYYY?...  |  /v1/gToH/DD-MM-YYYY
  function calcRoute(u) {
    if (!calc || u.hostname !== 'api.aladhan.com') return null;
    var p = u.pathname.replace(/\/+$/, '').split('/');            // ['', 'v1', 'timings', '16-11-2026']
    if (p[1] !== 'v1') return null;
    var m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(p[3] || '');
    var date = m ? { day: +m[1], month: +m[2], year: +m[3] } : null;
    if (p[2] === 'timings' && p.length <= 4) {
      var q = u.searchParams;
      var lat = parseFloat(q.get('latitude')), lon = parseFloat(q.get('longitude')), method = parseInt(q.get('method'), 10);
      if (!isFinite(lat) || !isFinite(lon) || !calc.METHODS[method]) return null;   // unsupported method: never guessed
      if (!date) { var n = new Date(); date = { day: n.getDate(), month: n.getMonth() + 1, year: n.getFullYear() }; }
      return { kind: 'timings', lat: lat, lon: lon, method: method, school: q.get('school') === '1' ? 1 : 0, date: date };
    }
    if (p[2] === 'gToH' && date && p.length === 4) return { kind: 'hijri', date: date };
    return null;
  }
  function calcBody(r) {
    if (r.kind === 'hijri') return calc.hijriResponse(r.date.year, r.date.month, r.date.day);
    var noon = new Date(r.date.year, r.date.month - 1, r.date.day, 12);
    var zone;
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { zone = undefined; }
    return calc.toAladhanResponse({ year: r.date.year, month: r.date.month, day: r.date.day, latitude: r.lat, longitude: r.lon,
      timezone: -noon.getTimezoneOffset() / 60, timezoneName: zone, method: r.method, school: r.school });
  }

  // ---- helpers ----
  function methodOf(input, init) { return String((init && init.method) || (input && input.method) || 'GET').toUpperCase(); }
  function urlOf(input) { return typeof input === 'string' ? input : (input && input.url) || String(input || ''); }
  function backend(path) { return String(cfg.siteUrl || '').replace(/\/+$/, '') + path; }
  function timeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }
  function openCache() { return (w.caches && w.caches.open) ? w.caches.open(CACHE_NAME) : Promise.resolve(null); }
  function remember(key, res) {
    openCache().then(function (c) {
      if (!c) return;
      return c.put(key, res).then(function () { return c.keys(); }).then(function (keys) {
        if (keys.length > CACHE_MAX_ENTRIES) return Promise.all(keys.slice(0, keys.length - CACHE_MAX_ENTRIES).map(function (k) { return c.delete(k); }));
      });
    }).catch(function () { /* cache is best effort */ });
  }
  function recall(key) { return openCache().then(function (c) { return c ? c.match(key) : null; }).catch(function () { return null; }); }

  // network first; the last good answer when the network fails
  function networkThenCache(input, init, key) {
    return realFetch(input, init).then(function (res) {
      if (res && res.ok) remember(key, res.clone());
      return res;
    }, function (err) {
      return recall(key).then(function (hit) { if (hit) return hit; throw err; });
    });
  }

  // Al-Adhan first (same as the website). Offline, slow or failing: calculated on the device. Prayer times for "today" prefer the
  // calculation over a remembered answer (which may be yesterday's); the Hijri date of a given day prefers the remembered answer.
  function calculated(input, init, key, route) {
    function fromCalc() {
      var body = null;
      try { body = calcBody(route); } catch (e) { body = null; }
      return body ? new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-QR-Source': 'calculated' } }) : null;
    }
    var offlineNow = !!(w.navigator && w.navigator.onLine === false);
    var network = offlineNow ? Promise.reject(new Error('offline')) : timeout(realFetch(input, init), CALC_TIMEOUT_MS);
    return network.then(function (res) {
      if (res && res.ok) { remember(key, res.clone()); return res; }
      throw new Error('the prayer API answered ' + (res && res.status));
    }).catch(function (err) {
      var first = route.kind === 'timings' ? fromCalc() : null;
      if (first) return first;
      return recall(key).then(function (hit) {
        if (hit) return hit;
        var late = fromCalc();
        if (late) return late;
        throw err;
      });
    });
  }

  // the list of translation editions: the real list when online (remembered), the remembered list when offline,
  // and as a last resort the editions that are bundled - so the picker is never empty on a first offline start
  function editionList(input, init, url, route) {
    var key = 'qr_ld_edlist:' + route.query;
    return timeout(realFetch(input, init), EDITION_LIST_TIMEOUT_MS).then(function (res) {
      if (res && res.ok) {
        res.clone().text().then(function (txt) { if (txt && txt.length < 400000) { try { storage.set(key, txt); } catch (e) { /* quota */ } } }).catch(function () { /* ignore */ });
        return res;
      }
      throw new Error('edition list unavailable');
    }).catch(function () {
      var saved = storage.get(key);
      if (saved) return new Response(saved, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-QR-Source': 'remembered' } });
      return local.respond(url).then(function (r) { return r || realFetch(input, init); });
    });
  }

  w.fetch = function (input, init) {
    var url = urlOf(input), method = methodOf(input, init), u = null;
    try { u = new URL(url, w.location.href); } catch (e) { return realFetch(input, init); }

    // 2. the app's own origin has no /api - use the hosted backend
    if (u.origin === w.location.origin && /^\/api\//.test(u.pathname)) {
      var target = backend(u.pathname + u.search);
      return realFetch(typeof input === 'string' ? target : new Request(target, input), typeof input === 'string' ? init : undefined);
    }

    if (method !== 'GET') return realFetch(input, init);

    // 1. bundled Quran data
    if (local && u.href.indexOf(local.apiBase) === 0) {
      var route = local.route(u.href);
      if (route && route.kind === 'editions') return editionList(input, init, u.href, route);
      if (route) {
        return local.respond(u.href).then(function (res) {
          return res || networkThenCache(input, init, u.href);
        });
      }
    }

    // 4. prayer times / Hijri date: Al-Adhan, else calculated here
    var cr = calcRoute(u);
    if (cr) return calculated(input, init, u.href, cr);

    // 3. cache for the public data APIs
    if (CACHEABLE_HOSTS.test(u.href)) return networkThenCache(input, init, u.href);
    return realFetch(input, init);
  };

  // The service worker cannot serve the app's files (they come from the APK), so it is not used here.
  try {
    if (w.navigator && w.navigator.serviceWorker) {
      Object.defineProperty(w.navigator.serviceWorker, 'register', {
        configurable: true,
        value: function () { return Promise.reject(new Error('service worker is not used in the standalone app')); }
      });
    }
  } catch (e) { /* keep the native implementation */ }
})();
