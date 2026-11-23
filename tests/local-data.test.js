'use strict';
// js/local-data.js - the offline Quran engine. The dataset comes from the TEST-ONLY fixtures; the checks prove that the
// engine answers in the shapes js/reader.js, js/search.js, js/sidebar.js, js/download-manager.js and app/js/* consume.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const LD = require('../js/local-data.js');
const { buildFixtureDataset, pythonJson, ROOT } = require('./helpers/quran-fixture.js');

const ds = buildFixtureDataset();
const API = 'https://api.alquran.cloud/v1';
const hex = (buf) => Buffer.from(buf).toString('hex');

function engine(opts = {}) {
  const store = new Map();
  let hashCalls = 0;
  const dir = opts.dir || ds.dir;
  const e = LD.create({
    apiBase: API,
    read: async (rel) => { const b = fs.readFileSync(path.join(dir, rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    sha256: opts.noHash ? null : async (buf) => { hashCalls++; return hex(await webcrypto.subtle.digest('SHA-256', buf)); },
    storage: opts.storage || { get: (k) => (store.has(k) ? store.get(k) : null), set: (k, v) => store.set(k, v) }
  });
  return { e, store, hashes: () => hashCalls };
}
async function get(e, url) { const r = await e.respond(API + url); return r ? { res: r, body: await r.json() } : null; }
const texts = (ed) => ds.sourceTexts[ed];

test('manifest of the fixture bundle: 114 surahs, 6236 ayahs, every file hashed', () => {
  assert.deepEqual(ds.manifest.counts, { surahs: 114, ayahs: 6236 });
  assert.equal(ds.structure.total, 6236);
  assert.ok(Object.keys(ds.manifest.files).length >= 7);
});

test('the canonical tables in the repo and in the dataset tool are the same', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app/js/data.js'), 'utf8');
  const counts = JSON.parse('[' + /AYAH_COUNTS = \[([^\]]+)\]/.exec(src)[1] + ']');
  assert.deepEqual(counts, ds.structure.ayahCounts, 'app/js/data.js AYAH_COUNTS == dataset ayahCounts');
  const juz = JSON.parse(/D\.JUZ_START = (\[\[.*?\]\]);/s.exec(src)[1]);
  const py = pythonJson('import quran_data as q; print(json.dumps([list(x) for x in q.JUZ_START_REFERENCE]))');
  assert.deepEqual(juz, py, 'app/js/data.js JUZ_START == quran_data.py JUZ_START_REFERENCE');
  const pyCounts = pythonJson('import quran_data as q; print(json.dumps(list(q.CANONICAL_AYAH_COUNTS)))');
  assert.deepEqual(pyCounts, counts);
});

test('route(): which requests the bundle takes and which it leaves to the network', () => {
  const { e } = engine();
  const kinds = (u) => { const r = e.route(API + u); return r && r.kind; };
  assert.equal(kinds('/surah'), 'surahs');
  assert.equal(kinds('/surah/2'), 'surah');
  assert.equal(kinds('/surah/2/bn.bengali'), 'surah');
  assert.equal(kinds('/juz/30/quran-uthmani'), 'range');
  assert.equal(kinds('/page/1/en.sahih'), 'range');
  assert.equal(kinds('/hizbQuarter/240/quran-uthmani'), 'range');
  assert.equal(kinds('/ruku/12/quran-uthmani'), 'range');
  assert.equal(kinds('/ayah/2:255/en.sahih'), 'ayah');
  assert.equal(kinds('/ayah/262/quran-uthmani'), 'ayah');
  assert.equal(kinds('/search/' + encodeURIComponent('আল্লাহ') + '/all/bn.bengali'), 'search');
  assert.equal(kinds('/edition?format=text&type=translation'), 'editions');
  assert.equal(e.route('https://api.alquran.cloud/v1'), null, 'the bare API root is not a data route');
  assert.equal(e.route('https://example.com/v1/surah/1'), null, 'other hosts are never touched');
  assert.equal(e.route('https://api.alquran.cloud/v2/surah/1'), null);
  for (const u of ['/surah/0', '/surah/115', '/surah/1/editions/a,b', '/search/x/all', '/search/x/200/bn.bengali', '/juz', '/meta', '/ayah']) {
    assert.equal(e.route(API + u), null, u);
  }
});

test('GET /surah: the list of 114 surahs in the API shape', async () => {
  const { e } = engine();
  const { res, body } = await get(e, '/surah');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('x-qr-source'), 'bundled');
  assert.equal(body.code, 200); assert.equal(body.status, 'OK');
  assert.equal(body.data.length, 114);
  assert.deepEqual(Object.keys(body.data[1]).sort(), ['englishName', 'englishNameTranslation', 'name', 'number', 'numberOfAyahs', 'revelationType']);
  assert.equal(body.data[1].number, 2); assert.equal(body.data[1].numberOfAyahs, 286);
});

test('GET /surah/N/<edition>: reader.js fields (name, revelationType, numberOfAyahs, ayahs[].text)', async () => {
  const { e } = engine();
  const { body } = await get(e, '/surah/2/bn.bengali');
  const d = body.data;
  assert.equal(d.number, 2); assert.equal(d.numberOfAyahs, 286); assert.equal(d.ayahs.length, 286);
  assert.ok(d.name && d.revelationType);
  assert.equal(d.edition.identifier, 'bn.bengali'); assert.equal(d.edition.language, 'bn');
  assert.equal(d.ayahs[0].number, 8, 'global number of 2:1 is 8');
  assert.equal(d.ayahs[285].number, 293);
  assert.equal(d.ayahs[0].surah, undefined, 'surah responses carry no per-ayah surah object (like the real API)');
  assert.deepEqual(Object.keys(d.ayahs[0]), ['number', 'text', 'numberInSurah', 'juz', 'manzil', 'page', 'ruku', 'hizbQuarter', 'sajda']);
  assert.deepEqual(d.ayahs.map((a) => a.text), texts('bn.bengali').slice(7, 7 + 286), 'text is copied byte for byte (UTF-8 Bengali included)');
});

test('the default edition of /surah/N is the Arabic text (download-manager.js asks for global numbers this way)', async () => {
  const { e } = engine();
  const { body } = await get(e, '/surah/114');
  assert.equal(body.data.edition.identifier, 'quran-uthmani');
  assert.deepEqual(body.data.ayahs.map((a) => a.number), [6231, 6232, 6233, 6234, 6235, 6236]);
});

test('juz / page / hizbQuarter / ruku / manzil: ayahs carry surah objects and a surahs map', async () => {
  const { e } = engine();
  for (const [route, field, n] of [['juz', 'juz', 3], ['page', 'page', 300], ['hizbQuarter', 'hizbQuarter', 77], ['ruku', 'ruku', 100], ['manzil', 'manzil', 4]]) {
    const { body } = await get(e, `/${route}/${n}/quran-uthmani`);
    const want = ds.structure[field].map((v, i) => (v === n ? i + 1 : 0)).filter(Boolean);
    assert.equal(body.data.number, n);
    assert.deepEqual(body.data.ayahs.map((a) => a.number), want, route + ' range');
    assert.ok(body.data.ayahs.every((a) => a[field] === n && a.surah && a.surah.number >= 1), route + ' fields');
    const seen = new Set(body.data.ayahs.map((a) => String(a.surah.number)));
    assert.deepEqual(Object.keys(body.data.surahs).sort(), [...seen].sort(), route + ' surahs map');
  }
  assert.equal(await get(e, '/juz/31/quran-uthmani'), null);
  assert.equal(await get(e, '/page/605/quran-uthmani'), null);
  assert.equal(await get(e, '/hizbQuarter/241/quran-uthmani'), null);
  assert.equal(await get(e, '/ruku/9999/quran-uthmani'), null);
});

test('reader.js contract: Arabic + translation fetched separately stay aligned index by index', async () => {
  const { e } = engine();
  for (const base of ['surah/5', 'juz/12', 'page/45', 'hizbQuarter/9', 'ruku/50']) {
    const [ar, tr] = await Promise.all([`/${base}/quran-uthmani`, `/${base}/bn.bengali`].map(async (u) => (await get(e, u)).body.data));
    assert.equal(ar.ayahs.length, tr.ayahs.length, base);
    ar.ayahs.map((a, i) => ({ number: a.number, numberInSurah: a.numberInSurah, surah: base.startsWith('surah') ? 5 : a.surah.number, page: a.page, arabic: a.text, text: tr.ayahs[i].text }))
      .forEach((x) => assert.ok(x.text.endsWith(`bn.bengali ${x.surah}:${x.numberInSurah}`), `${base}: ${x.surah}:${x.numberInSurah} is aligned with its translation`));
  }
});

test('GET /ayah/S:A/<edition> and /ayah/<global>: Ayat al-Kursi is global ayah 262', async () => {
  const { e } = engine();
  for (const ref of ['2:255', '262']) {
    const { body } = await get(e, `/ayah/${ref}/en.sahih`);
    const d = body.data;
    assert.equal(d.number, 262); assert.equal(d.numberInSurah, 255); assert.equal(d.surah.number, 2);
    assert.equal(d.surah.englishName, 'Fixture 2');
    assert.equal(d.text, texts('en.sahih')[261]);
    assert.equal(d.edition.identifier, 'en.sahih');
  }
  assert.equal((await get(e, '/ayah/2:255')).body.data.edition.identifier, 'quran-uthmani');
  for (const bad of ['/ayah/2:287/en.sahih', '/ayah/0/en.sahih', '/ayah/6237/en.sahih', '/ayah/115:1/en.sahih', '/ayah/x/en.sahih']) {
    assert.equal(await get(e, bad), null, bad);
  }
});

test('the sajda marker of an ayah keeps the API shape (object, or false)', async () => {
  const { e } = engine();
  const { body } = await get(e, '/ayah/1160/quran-uthmani');
  assert.deepEqual(body.data.sajda, { id: 1, recommended: true, obligatory: false });
  assert.equal((await get(e, '/ayah/1/quran-uthmani')).body.data.sajda, false);
});

test('GET /search/<kw>/all/<edition>: matches carry surah + numberInSurah (js/search.js, app/js/search.js)', async () => {
  const { e } = engine();
  const kw = 'bn.bengali 2:25';
  const { body } = await get(e, '/search/' + encodeURIComponent(kw) + '/all/bn.bengali');
  const want = texts('bn.bengali').map((t, i) => (t.toLowerCase().includes(kw) ? i + 1 : 0)).filter(Boolean);
  assert.equal(body.data.count, want.length); assert.ok(want.length > 5);
  assert.deepEqual(body.data.matches.map((m) => m.number), want);
  const m = body.data.matches[0];
  assert.deepEqual(Object.keys(m).sort(), ['edition', 'number', 'numberInSurah', 'surah', 'text']);
  assert.equal(m.surah.number, 2); assert.ok(m.surah.englishName);
  const up = await get(e, '/search/' + encodeURIComponent(kw.toUpperCase()) + '/all/bn.bengali');
  assert.equal(up.body.data.count, want.length, 'case-insensitive like the API');
  const one = await get(e, '/search/fixture/1/en.sahih');
  assert.equal(one.body.data.count, 7, 'a surah number limits the search to that surah');
  const none = await get(e, '/search/zzzz-no-match/all/en.sahih');
  assert.deepEqual(none.body.data, { count: 0, matches: [] });
  const ar = await get(e, '/search/' + encodeURIComponent('اختبار') + '/all/quran-simple-clean');
  assert.equal(ar.body.data.count, 6236, 'Arabic search runs on quran-simple-clean');
});

test('GET /edition: only bundled editions, filtered like the API', async () => {
  const { e } = engine();
  const tr = (await get(e, '/edition?format=text&type=translation')).body.data;
  assert.deepEqual(tr.map((x) => x.identifier).sort(), ['bn.bengali', 'en.sahih']);
  const all = (await get(e, '/edition?format=text')).body.data;
  assert.equal(all.length, 4);
  const bn = (await get(e, '/edition?language=bn')).body.data;
  assert.deepEqual(bn.map((x) => x.identifier), ['bn.bengali']);
});

test('editions that are not bundled, or not valid identifiers, return null (-> network)', async () => {
  const { e } = engine();
  assert.equal(await get(e, '/surah/1/ur.jalandhry'), null);
  assert.equal(await get(e, '/surah/1/..%2Fmanifest'), null);
  assert.equal(await get(e, '/surah/1/BN.BENGALI'), null);
  assert.equal(await get(e, '/search/x/all/hi.hindi'), null);
});

test('checksums: a tampered text file is NOT served, the others still are', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-tamper-'));
  fs.cpSync(ds.dir, tmp, { recursive: true });
  const f = path.join(tmp, 'text', 'en.sahih.json');
  const arr = JSON.parse(fs.readFileSync(f, 'utf8')); arr[100] += ' (edited)';
  fs.writeFileSync(f, JSON.stringify(arr));
  const { e } = engine({ dir: tmp });
  assert.equal(await get(e, '/surah/1/en.sahih'), null, 'tampered edition falls back to the network');
  assert.match(e.describe().reason, /checksum mismatch: text\/en\.sahih\.json/);
  assert.equal((await get(e, '/surah/1/bn.bengali')).body.data.ayahs.length, 7, 'untouched editions keep working');
  assert.equal(e.describe().status, 'ready');
});

test('checksums: a tampered structure file disables the whole bundle (status failed)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-tamper2-'));
  fs.cpSync(ds.dir, tmp, { recursive: true });
  const f = path.join(tmp, 'structure.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.page[5000] += 1;
  fs.writeFileSync(f, JSON.stringify(s));
  const { e } = engine({ dir: tmp });
  assert.equal(await get(e, '/surah/1/bn.bengali'), null);
  assert.equal(e.describe().status, 'failed');
});

test('a missing bundle (website, or a damaged install) is "unavailable" and never throws', async () => {
  const { e } = engine({ dir: path.join(os.tmpdir(), 'qr-does-not-exist-' + Date.now()) });
  assert.equal(await get(e, '/surah/1/bn.bengali'), null);
  assert.equal(e.describe().status, 'unavailable');
});

test('a dataset version is hashed once; later starts reuse the stored result', async () => {
  const a = engine();
  await get(a.e, '/surah/1/bn.bengali');
  const first = a.hashes();
  assert.ok(first >= 4, 'structure, surahs, editions and the text were hashed: ' + first);
  const b = engine({ storage: { get: (k) => a.store.get(k) ?? null, set: (k, v) => a.store.set(k, v) } });
  await get(b.e, '/surah/1/bn.bengali');
  assert.equal(b.hashes(), 0, 'nothing is hashed again for the same dataset version');
});

test('without crypto.subtle the data is still served (the build already verified it)', async () => {
  const { e } = engine({ noHash: true });
  assert.equal((await get(e, '/surah/1/bn.bengali')).body.data.ayahs.length, 7);
});
