// ---------- Offline Quran data engine (standalone Android app) ----------
//
// The website reads the Quran from https://api.alquran.cloud at run time. The standalone app has to work on its very first
// launch without a network, so the same text ships inside the APK (data/quran/, written by tools/quran-data/quran_data.py)
// and THIS file answers the API requests from it - in exactly the response shapes the existing code already consumes
// (js/reader.js, js/search.js, js/sidebar.js, js/stats.js, js/download-manager.js, app/js/*). Nothing else had to change.
//
// Rules
//   * Text is returned byte for byte as it was bundled. It is never edited, merged or generated here.
//   * Every bundled file is checked against its SHA-256 from manifest.json before it is used (once per dataset version).
//     A file that fails the check is NOT served - the request falls through to the network exactly as before.
//   * Anything the bundle cannot answer (another translation, an unknown route) returns null so the caller uses the network.
//   * Pure logic only: file access / hashing / storage are injected, so the same code is unit-tested in Node
//     (tests/local-data.test.js) and used in the app (js/standalone-net.js).
//
// create({ read(rel) -> Promise<ArrayBuffer>, sha256(buf) -> Promise<hex>|null, storage: {get,set}|null, apiBase })
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR_LOCAL_DATA = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOTAL = 6236;
  var SURAHS = 114;
  var DEFAULT_API = 'https://api.alquran.cloud/v1';
  var ARABIC = 'quran-uthmani';
  var RANGE_FIELDS = ['juz', 'manzil', 'page', 'ruku', 'hizbQuarter'];
  var RANGE_ROUTES = { juz: 'juz', manzil: 'manzil', page: 'page', ruku: 'ruku', hizbquarter: 'hizbQuarter' };
  var EDITION_RE = /^(?:[a-z]{2,3}\.[a-z0-9_]{2,40}|quran-[a-z]+(?:-[a-z]+){0,3})$/;

  function jsonResponse(data, status) {
    var body = JSON.stringify({ code: status || 200, status: status && status !== 200 ? 'Not Found' : 'OK', data: data });
    return new Response(body, { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-QR-Source': 'bundled' } });
  }
  function isInt(s) { return /^\d{1,6}$/.test(s); }
  // "the bundle is present but wrong" (checksum, structure, unreadable JSON) - as opposed to "the bundle is not there"
  function integrityError(msg) { var e = new Error(msg); e.integrity = true; return e; }

  function create(io) {
    io = io || {};
    var apiBase = (io.apiBase || DEFAULT_API).replace(/\/+$/, '');
    var st = { status: 'idle', reason: '', manifest: null, structure: null, surahs: null, editions: null, surahOf: null, ranges: null };
    var texts = {};
    var coreP = null;
    var decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

    function store(k) { try { return io.storage ? io.storage.get(k) : null; } catch (e) { return null; } }
    function storeSet(k, v) { try { if (io.storage) io.storage.set(k, v); } catch (e) { /* storage is optional */ } }

    function parse(buf, rel) {
      try { return JSON.parse(decoder.decode(buf)); } catch (e) { throw integrityError('unreadable ' + rel); }
    }

    // Reads a data file, verifies its checksum against the manifest (once per dataset version), returns the parsed JSON.
    async function verifiedRead(rel) {
      var buf = await io.read(rel);
      var want = st.manifest && st.manifest.files && st.manifest.files[rel];
      if (want && io.sha256) {
        var flag = 'qrld:ok:' + st.manifest.datasetSha256 + ':' + rel;
        if (store(flag) !== '1') {
          var got = await io.sha256(buf);
          if (got !== want.sha256) throw integrityError('checksum mismatch: ' + rel);
          storeSet(flag, '1');
        }
      }
      return parse(buf, rel);
    }

    function buildIndexes() {
      var s = st.structure;
      var surahOf = new Uint8Array(TOTAL + 1);
      for (var i = 0; i < SURAHS; i++) {
        for (var k = 0; k < s.ayahCounts[i]; k++) surahOf[s.surahStart[i] + k] = i + 1;
      }
      var ranges = {};
      RANGE_FIELDS.forEach(function (f) {
        var col = s[f], r = [];
        for (var g = 1; g <= TOTAL; g++) {
          var v = col[g - 1];
          if (!r[v]) r[v] = [g, g]; else r[v][1] = g;
        }
        ranges[f] = r;
      });
      st.surahOf = surahOf;
      st.ranges = ranges;
    }

    async function loadCore() {
      st.status = 'loading';
      try {
        var manifestBuf = await io.read('manifest.json');
        var manifest = parse(manifestBuf, 'manifest.json');
        if (!manifest || manifest.schema !== 1 || !manifest.counts || manifest.counts.ayahs !== TOTAL || manifest.counts.surahs !== SURAHS || !manifest.files) {
          throw integrityError('unsupported manifest');
        }
        st.manifest = manifest;
        var parts = await Promise.all([verifiedRead('structure.json'), verifiedRead('surahs.json'), verifiedRead('editions.json')]);
        var structure = parts[0], surahs = parts[1], editions = parts[2];
        var sum = 0;
        for (var i = 0; i < SURAHS; i++) sum += structure.ayahCounts[i];
        var ok = structure.total === TOTAL && sum === TOTAL && structure.surahStart.length === SURAHS && surahs.length === SURAHS;
        RANGE_FIELDS.forEach(function (f) { if (!structure[f] || structure[f].length !== TOTAL) ok = false; });
        if (!ok) throw integrityError('structure does not describe 114 surahs / 6236 ayahs');
        st.structure = structure; st.surahs = surahs; st.editions = editions;
        buildIndexes();
        st.status = 'ready';
      } catch (e) {
        st.status = (e && e.integrity) ? 'failed' : 'unavailable';
        st.reason = String(e && e.message || e);
      }
      return st.status;
    }
    function core() { if (!coreP) coreP = loadCore(); return coreP; }

    function getText(id) {
      if (!EDITION_RE.test(id) || !st.editions || !st.editions[id]) return Promise.resolve(null);
      if (!texts[id]) {
        texts[id] = verifiedRead('text/' + id + '.json').then(function (arr) {
          if (!Array.isArray(arr) || arr.length !== TOTAL) throw integrityError('wrong text length for ' + id);
          return arr;
        }).catch(function (e) { st.reason = String(e && e.message || e); return null; });
      }
      return texts[id];
    }

    // ---- response pieces (the shapes Al Quran Cloud returns) ----
    function surahMeta(n) { var m = st.surahs[n - 1]; return { number: m.number, name: m.name, englishName: m.englishName, englishNameTranslation: m.englishNameTranslation, revelationType: m.revelationType, numberOfAyahs: m.numberOfAyahs }; }
    function sajdaOf(g) {
      var x = st.structure.sajda && st.structure.sajda[String(g)];
      return x ? { id: x[0], recommended: !!x[1], obligatory: !!x[2] } : false;
    }
    function ayahObj(g, text, withSurah) {
      var s = st.structure, n = st.surahOf[g];
      var o = { number: g, text: text, numberInSurah: g - s.surahStart[n - 1] + 1, juz: s.juz[g - 1], manzil: s.manzil[g - 1], page: s.page[g - 1], ruku: s.ruku[g - 1], hizbQuarter: s.hizbQuarter[g - 1], sajda: sajdaOf(g) };
      if (withSurah) o.surah = surahMeta(n);
      return o;
    }
    function edObj(id) { var e = st.editions[id]; return { identifier: e.identifier, language: e.language, name: e.name, englishName: e.englishName, format: e.format, type: e.type, direction: e.direction }; }

    async function surahResponse(n, id) {
      var t = await getText(id); if (!t) return null;
      var from = st.structure.surahStart[n - 1], count = st.structure.ayahCounts[n - 1], ayahs = [];
      for (var i = 0; i < count; i++) ayahs.push(ayahObj(from + i, t[from + i - 1], false));
      var m = surahMeta(n); m.ayahs = ayahs; m.edition = edObj(id);
      return jsonResponse(m);
    }
    async function rangeResponse(field, n, id) {
      var r = st.ranges[field][n]; if (!r) return null;
      var t = await getText(id); if (!t) return null;
      var ayahs = [], surahs = {};
      for (var g = r[0]; g <= r[1]; g++) {
        var a = ayahObj(g, t[g - 1], true);
        surahs[a.surah.number] = a.surah;
        ayahs.push(a);
      }
      return jsonResponse({ number: n, ayahs: ayahs, surahs: surahs, edition: edObj(id) });
    }
    async function ayahResponse(ref, id) {
      var g = 0, m;
      if (isInt(ref)) g = parseInt(ref, 10);
      else if ((m = /^(\d{1,3}):(\d{1,3})$/.exec(ref))) {
        var sn = parseInt(m[1], 10), an = parseInt(m[2], 10);
        if (sn < 1 || sn > SURAHS || an < 1 || an > st.structure.ayahCounts[sn - 1]) return null;
        g = st.structure.surahStart[sn - 1] + an - 1;
      }
      if (g < 1 || g > TOTAL) return null;
      var t = await getText(id); if (!t) return null;
      var a = ayahObj(g, t[g - 1], true);
      a.edition = edObj(id);
      return jsonResponse(a);
    }
    async function searchResponse(keyword, scope, id) {
      var t = await getText(id); if (!t) return null;
      var kw = String(keyword).toLowerCase();
      if (!kw) return null;
      var only = scope === 'all' ? 0 : parseInt(scope, 10);
      var matches = [], ed = edObj(id);
      var from = only ? st.structure.surahStart[only - 1] : 1;
      var to = only ? from + st.structure.ayahCounts[only - 1] - 1 : TOTAL;
      for (var g = from; g <= to; g++) {
        if (t[g - 1].toLowerCase().indexOf(kw) !== -1) {
          var n = st.surahOf[g], sm = surahMeta(n);
          matches.push({ number: g, text: t[g - 1], edition: ed, surah: { number: sm.number, name: sm.name, englishName: sm.englishName, englishNameTranslation: sm.englishNameTranslation, revelationType: sm.revelationType }, numberInSurah: g - st.structure.surahStart[n - 1] + 1 });
        }
      }
      return jsonResponse({ count: matches.length, matches: matches });
    }

    // GET /edition?format=text&type=translation  (the list of editions that are bundled)
    function editionListResponse(query) {
      var q = {};
      String(query || '').split('&').forEach(function (p) { if (p) { var kv = p.split('='); q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); } });
      var out = Object.keys(st.editions).map(edObj).filter(function (e) {
        return (!q.format || e.format === q.format) && (!q.type || e.type === q.type) && (!q.language || e.language === q.language);
      });
      return jsonResponse(out);
    }

    // Returns { kind, ... } for a request the bundle may answer, or null (-> the caller uses the network).
    function route(url) {
      url = String(url || '');
      if (url !== apiBase && url.indexOf(apiBase + '/') !== 0 && url.indexOf(apiBase + '?') !== 0) return null;
      var rest = url.slice(apiBase.length), qi = rest.indexOf('?');
      var query = qi < 0 ? '' : rest.slice(qi + 1);
      var seg;
      try { seg = (qi < 0 ? rest : rest.slice(0, qi)).split('/').filter(Boolean).map(decodeURIComponent); } catch (e) { return null; }
      var head = (seg[0] || '').toLowerCase();
      var n = isInt(seg[1] || '') ? parseInt(seg[1], 10) : 0;
      if (head === 'edition' && seg.length === 1) return { kind: 'editions', query: query };
      if (head === 'surah' && seg.length === 1) return { kind: 'surahs' };
      if (head === 'surah' && n >= 1 && n <= SURAHS && seg.length <= 3 && seg[2] !== 'editions') return { kind: 'surah', n: n, ed: seg[2] || ARABIC };
      if (RANGE_ROUTES[head] && n >= 1 && seg.length <= 3 && seg[2] !== 'editions') return { kind: 'range', field: RANGE_ROUTES[head], n: n, ed: seg[2] || ARABIC };
      if (head === 'ayah' && seg.length >= 2 && seg.length <= 3 && seg[1] && seg[1] !== 'editions') return { kind: 'ayah', ref: seg[1], ed: seg[2] || ARABIC };
      if (head === 'search' && seg.length === 4 && seg[1]) {
        var scope = seg[2];
        if (scope === 'all' || (isInt(scope) && +scope >= 1 && +scope <= SURAHS)) return { kind: 'search', kw: seg[1], scope: scope, ed: seg[3] };
      }
      return null;
    }

    // Resolves to a Response for requests the bundle can answer, otherwise to null.
    async function respond(url) {
      var r = route(url);
      if (!r) return null;
      if ((await core()) !== 'ready') return null;
      switch (r.kind) {
        case 'surahs': return jsonResponse(st.surahs.map(function (m) { return surahMeta(m.number); }));
        case 'editions': return editionListResponse(r.query);
        case 'surah': return surahResponse(r.n, r.ed);
        case 'range': return rangeResponse(r.field, r.n, r.ed);
        case 'ayah': return ayahResponse(r.ref, r.ed);
        case 'search': return searchResponse(r.kw, r.scope, r.ed);
        default: return null;
      }
    }

    return {
      apiBase: apiBase,
      route: route,
      respond: respond,
      whenReady: core,
      has: function (id) { return !!(st.editions && st.editions[id]); },
      describe: function () {
        return { status: st.status, reason: st.reason, datasetSha256: st.manifest ? st.manifest.datasetSha256 : '', editions: st.editions ? Object.keys(st.editions) : [], limits: st.manifest ? st.manifest.limits : null };
      }
    };
  }

  return { create: create, TOTAL_AYAHS: TOTAL, SURAH_COUNT: SURAHS };
});
