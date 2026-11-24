'use strict';
// scripts/web/build-web.mjs on the REAL repository files (fake CDN, fixture Quran data): the bundle that goes into the APK
// must contain everything the app needs to start, nothing it must not ship, and must pass the offline-launch audit.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildFixtureDataset, ROOT } = require('./helpers/quran-fixture.js');

const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 7)]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qr-web-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function fakeCdn() {
  const body = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b); return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }; };
  return async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('.woff2')) return body(WOFF2);
    if (u.hostname === 'fonts.googleapis.com') return body("@font-face{font-family:'X';src:url(https://fonts.gstatic.com/s/x/v1/x.woff2) format('woff2')}");
    if (u.pathname.endsWith('.css')) return body('@font-face{font-family:"FA";src:url(../webfonts/fa-solid-900.woff2) format("woff2")}.fa{}');
    if (u.pathname.endsWith('.js')) return body('/* fake ' + u.pathname + ' */');
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

let built = null;
async function build() {
  if (built) return built;
  const { buildWeb } = await import('../scripts/web/build-web.mjs');
  const before = sha(path.join(ROOT, 'index.html'));
  const out = path.join(tmp(), 'www');
  const r = await buildWeb({ outDir: out, fetchImpl: fakeCdn(), vendor: { lockPath: '' }, quran: { fromDir: buildFixtureDataset().src, lockPath: '' },
    bundleId: 'test-1', appVersion: '9.9.9', siteUrl: 'https://quranbangla.vercel.app' });
  built = { r, out, before };
  return built;
}
const copyOf = (out) => { const d = path.join(tmp(), 'www'); fs.cpSync(out, d, { recursive: true }); return d; };
const audit = async (dir, o = {}) => (await import('../scripts/web/audit-launch.mjs')).auditBundle(dir, { optionalHosts: [], ...o });

test('the bundle builds from the real repository and passes the offline-launch audit', async () => {
  const { r } = await build();
  assert.deepEqual(r.audit.errors, []);
  assert.ok(r.manifest.fileCount >= 140 && r.manifest.fileCount <= 220, 'file count ' + r.manifest.fileCount);
  assert.ok(r.audit.info.platformFiles >= 20, 'the app layer file lists were read');
  assert.equal(r.audit.info.quran.verifiedFiles, 7, 'structure + surahs + editions + 4 text files, all verified against the manifest');
});

test('the repository itself is untouched: the website keeps its own index.html', async () => {
  const { before } = await build();
  assert.equal(sha(path.join(ROOT, 'index.html')), before);
  assert.ok(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('https://www.gstatic.com/firebasejs/'));
});

test('index.html in the bundle: no network tags, standalone layer first, web manifest link removed', async () => {
  const { out } = await build();
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const { findTags, isExternal } = await import('../scripts/web/html-tools.mjs');
  const ext = findTags(html).filter((t) => isExternal(t.attrs.src || t.attrs.href) && !/canonical|alternate/.test(t.attrs.rel || ''));
  assert.deepEqual(ext.map((t) => t.text), []);
  const i = (s) => html.indexOf(s);
  assert.ok(i('window.QR_STANDALONE=') > 0 && i('window.QR_STANDALONE=') < i('js/local-data.js'));
  assert.ok(i('js/local-data.js') < i('js/prayer-calc.js') && i('js/prayer-calc.js') < i('js/standalone-net.js') && i('js/standalone-net.js') < i('js/quran-native.js') && i('js/quran-native.js') < i('js/native-sync.js') && i('js/native-sync.js') < i('js/platform.js'));
  assert.ok(!/rel="manifest"/.test(html));
  assert.match(html, /window\.QR_STANDALONE=\{"siteUrl":"https:\/\/quranbangla\.vercel\.app","dataBase":"data\/quran\/","bundleId":"test-1","appVersion":"9\.9\.9"\}/);
  assert.ok(html.includes('src="vendor/gstatic.com/firebasejs/10.13.2/firebase-app-compat.js" defer'));
});

test('what must be in the bundle is in it, and what must not be is not', async () => {
  const { out } = await build();
  const has = (f) => fs.existsSync(path.join(out, f));
  for (const f of ['index.html', 'app-config.js', 'privacy.html', 'terms.html', 'account-deletion.html', 'js/platform.js', 'js/local-data.js', 'js/prayer-calc.js', 'js/standalone-net.js', 'js/quran-native.js', 'js/native-sync.js', 'app/js/tasbih.js',
    'app/js/boot.js', 'app/css/tokens.css', 'assets/animations/quran-bangla-splash.json', 'assets/vendor/lottie/lottie_svg.min.js', 'icons/icon-192.png', 'css/legal.css', 'js/legal.js',
    'data/quran/manifest.json', 'data/quran/structure.json', 'data/quran/text/bn.bengali.json', 'bundle-manifest.json',
    'vendor/cdn.jsdelivr.net/npm/qrcode@1.4.4/build/qrcode.min.js']) assert.ok(has(f), f + ' is missing');
  for (const f of ['sw.js', 'manifest.json', '404.html', 'api', 'tests', 'scripts', 'docs', 'android-build', '.github', 'firestore.rules', 'package.json', 'README.md', 'icons/banner-donate.webp', 'icons/donation-banner-with-text.png']) {
    assert.ok(!has(f), f + ' must not be shipped in the app');
  }
});

test('QR library: js/totp.js asks for exactly the file the bundle vendors, on a version that really exists on npm', async () => {
  // The fake CDN above answers every *.js address, so it can never notice a dead real address (that is how the cdnjs 404 got
  // through). What can be checked offline: the app-side path in js/totp.js must be where vendor-deps.mjs stores the address from
  // bundle-config.json, and the website fallbacks must name the same version.
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/web/bundle-config.json'), 'utf8'));
  const qr = (cfg.extraVendor || []).map((x) => x.url).filter((u) => /qrcode/i.test(u));
  assert.equal(qr.length, 1, 'bundle-config.json lists exactly one QR library');
  const { localPathFor } = await import('../scripts/web/vendor-deps.mjs');
  const src = fs.readFileSync(path.join(ROOT, 'js/totp.js'), 'utf8');
  const list = /QR_LIB_CDN_URLS\s*=\s*\([^)]*\)\s*\?\s*\[([\s\S]*?)\]\s*:\s*\[([\s\S]*?)\]\s*;/.exec(src);
  assert.ok(list, 'QR_LIB_CDN_URLS was found in js/totp.js');
  const urls = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(urls(list[1]), [localPathFor(qr[0])], 'the app must load the QR library from the path the bundle build creates');
  const version = (u) => (/qrcode@(\d+\.\d+\.\d+)\//.exec(u) || [])[1];
  const want = version(qr[0]);
  assert.ok(want, 'the QR library address in bundle-config.json names an exact version');
  for (const u of urls(list[2])) assert.equal(version(u), want, u + ' must use the same version as bundle-config.json');
  // qrcode 1.5.x publishes no build/ folder on npm, so every .../qrcode@1.5.x/build/... address is HTTP 404 on jsdelivr and unpkg.
  for (const u of [qr[0], ...urls(list[2])]) assert.doesNotMatch(u, /qrcode@1\.5\.\d+\//, u + ': qrcode 1.5.x has no browser file on npm (HTTP 404) - use 1.4.4');
});

test('bundle-manifest.json lists every file with its real size and SHA-256', async () => {
  const { out, r } = await build();
  const m = JSON.parse(fs.readFileSync(path.join(out, 'bundle-manifest.json'), 'utf8'));
  assert.equal(m.bundleId, 'test-1'); assert.equal(m.appVersion, '9.9.9'); assert.equal(m.siteUrl, 'https://quranbangla.vercel.app');
  const { listFiles } = await import('../scripts/web/audit-launch.mjs');
  const onDisk = listFiles(out).filter((f) => f !== 'bundle-manifest.json');
  assert.deepEqual(Object.keys(m.files), onDisk);
  for (const f of onDisk) { assert.equal(m.files[f].sha256, sha(path.join(out, f)), f); assert.equal(m.files[f].bytes, fs.statSync(path.join(out, f)).size, f); }
  assert.equal(m.fileCount, onDisk.length);
  assert.match(m.bundleSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.manifest.bundleSha256, m.bundleSha256);
  assert.deepEqual(m.excluded.sort(), ['icons/banner-donate.webp', 'icons/donation-banner-with-text.png']);
});

test('audit: a script fetched from the network is an error (and only a warning in developer-preview mode)', async () => {
  const { out } = await build();
  const d = copyOf(out);
  const f = path.join(d, 'index.html');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('</head>', '<script src="https://cdn.example.com/x.js"></script></head>'));
  const a = await audit(d);
  assert.ok(a.errors.some((e) => /loads https:\/\/cdn\.example\.com\/x\.js from the network/.test(e)));
  assert.ok((await audit(d, { allowIncomplete: true })).errors.length === 0);
});

test('audit: missing files are found - in index.html, in the app-layer lists, in vendored css', async () => {
  const { out } = await build();
  const d = copyOf(out);
  fs.rmSync(path.join(d, 'app/js/boot.js'));
  fs.rmSync(path.join(d, 'js/auth.js'));
  fs.rmSync(path.join(d, 'vendor/fonts.gstatic.com'), { recursive: true });
  const errs = (await audit(d)).errors.join('\n');
  assert.match(errs, /js\/platform\.js loads app\/js\/boot\.js/);
  assert.match(errs, /index\.html references js\/auth\.js/);
  assert.match(errs, /vendor\/fonts\.googleapis\.com\/css2-[0-9a-f]{8}\.css refers to/);
});

test('audit: Quran data must exist and match its checksums', async () => {
  const { out } = await build();
  const d1 = copyOf(out);
  const f = path.join(d1, 'data/quran/text/bn.bengali.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('পরীক্ষা', 'পরিবর্তিত'));
  assert.match((await audit(d1)).errors.join('\n'), /data\/quran\/text\/bn\.bengali\.json does not match the checksum/);
  const d2 = copyOf(out);
  fs.rmSync(path.join(d2, 'data'), { recursive: true });
  assert.match((await audit(d2)).errors.join('\n'), /data\/quran\/manifest\.json is missing/);
  assert.deepEqual((await audit(d2, { allowIncomplete: true })).errors, []);
  assert.deepEqual((await audit(d2, { requireQuran: false })).errors, []);
});

test('audit: the standalone layer must be wired in, in the right order', async () => {
  const { out } = await build();
  const d = copyOf(out);
  const f = path.join(d, 'index.html');
  const html = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, html.replace('<script src="js/standalone-net.js"></script>', ''));
  assert.match((await audit(d)).errors.join('\n'), /does not load the standalone layer/);
  const layer = '<script src="js/local-data.js"></script>\n<script src="js/prayer-calc.js"></script>\n<script src="js/standalone-net.js"></script>\n<script src="js/quran-native.js"></script>\n<script src="js/native-sync.js"></script>';
  assert.ok(html.includes(layer), 'test setup: the layer block is where it is expected');
  fs.writeFileSync(f, html.replace(layer, '').replace('<script src="js/platform.js"></script>', '<script src="js/platform.js"></script>' + layer.replace(/\n/g, '')));
  assert.match((await audit(d)).errors.join('\n'), /must load before js\/platform\.js/);
});

test('audit: unknown online hosts are reported for review, never blocking', async () => {
  const { out } = await build();
  const a = await audit(out, { optionalHosts: ['api.alquran.cloud'] });
  assert.deepEqual(a.errors, []);
  assert.ok(a.warnings.some((w) => /unlisted online host in the app code: api\.aladhan\.com/.test(w)));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/web/bundle-config.json'), 'utf8'));
  const { hostsFromConfig } = await import('../scripts/web/audit-launch.mjs');
  const known = await audit(out, { optionalHosts: hostsFromConfig(cfg) });
  assert.deepEqual(known.warnings.filter((w) => /unlisted online host/.test(w)), [], 'every host the code talks to is listed in bundle-config.json');
});

test('CLI: a bundle that cannot start offline is refused unless --allow-incomplete is given', () => {
  const r = spawnSync('node', [path.join(ROOT, 'scripts/web/build-web.mjs'), '--skip-quran', '--out', path.join(tmp(), 'x')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot start offline.*--allow-incomplete/);
  const bad = spawnSync('node', [path.join(ROOT, 'scripts/web/build-web.mjs'), '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /unknown option --nope/);
});

test('transformIndex: inserts after the charset meta, removes only what bundle-config.json lists', async () => {
  const { transformIndex, standaloneBlock } = await import('../scripts/web/build-web.mjs');
  const cfg = { removeFromIndex: [{ tag: 'link', rel: 'manifest' }] };
  const out = transformIndex('<html><head><meta charset="UTF-8"><link rel="manifest" href="m.json"><link rel="icon" href="i.png"></head></html>', cfg, standaloneBlock({ siteUrl: 'https://x.test', bundleId: 'b', appVersion: '1' }));
  assert.ok(out.indexOf('QR_STANDALONE') > out.indexOf('charset') && !out.includes('manifest') && out.includes('rel="icon"'));
  assert.ok(standaloneBlock({ siteUrl: 'https://x.test/</script><script>alert(1)', bundleId: 'b', appVersion: '1' }).indexOf('</script><script>alert') < 0, 'a hostile value cannot close the script tag');
});
