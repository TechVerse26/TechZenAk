'use strict';
// scripts/web/vendor-deps.mjs with a fake CDN: every external script / stylesheet / font of the start page must end up in
// the bundle, the page must point at the local copies, and bad downloads must stop the build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qr-vendor-'));
process.env.QR_VENDOR_RETRY_PAUSE_MS = '1'; // keep the retry test fast
const mod = () => import('../scripts/web/vendor-deps.mjs');

const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40, 7)]);
const GF_URL = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Hind+Siliguri:wght@400&display=swap';
const FA_URL = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css';
const FB_URL = 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js';
const EJS_URL = 'https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js';

const HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="${GF_URL.replace(/&/g, '&amp;')}" rel="stylesheet">
<link rel="stylesheet" href="${FA_URL}" integrity="sha384-abc" crossorigin="anonymous">
<link rel="stylesheet" href="css/base.css">
<script src="${FB_URL}" defer></script>
<script src="${EJS_URL}" defer crossorigin></script>
<script>var s = '<link rel="stylesheet" href="https://evil.example/never.css">'; document.write(s);</script>
<script src="js/app.js" defer></script>
</head><body></body></html>`;

function cdn(overrides = {}) {
  const hits = [];
  const table = {
    [FB_URL]: '/* firebase app */ var firebase = {};',
    [EJS_URL]: '/* emailjs */ var emailjs = {};',
    [GF_URL]: "@font-face{font-family:'Amiri';src:url(https://fonts.gstatic.com/s/amiri/v27/aaa.woff2) format('woff2');unicode-range:U+0600-06FF}\n@font-face{font-family:'Hind Siliguri';src:url('https://fonts.gstatic.com/s/hind/v12/bbb.woff2') format('woff2');}",
    [FA_URL]: '@font-face{font-family:"FA";src:url(../webfonts/fa-solid-900.woff2) format("woff2"),url(../webfonts/fa-solid-900.ttf) format("truetype")}.fa{background:url(data:image/svg+xml;base64,AAA,BBB)}',
    'https://fonts.gstatic.com/s/amiri/v27/aaa.woff2': WOFF2,
    'https://fonts.gstatic.com/s/hind/v12/bbb.woff2': WOFF2,
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-solid-900.woff2': WOFF2,
    ...overrides
  };
  const fetchImpl = async (url, init) => {
    hits.push(url);
    assert.match(init.headers['User-Agent'], /Chrome\/1\d\d/, 'a modern user agent is sent (Google Fonts serves woff2 to it)');
    const v = table[url];
    if (v === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    if (typeof v === 'function') return v();
    const b = Buffer.isBuffer(v) ? v : Buffer.from(v);
    return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  };
  return { fetchImpl, hits };
}
const run = async (extra = {}, cdnOverrides = {}) => {
  const { vendorDeps } = await mod();
  const out = tmp();
  const c = cdn(cdnOverrides);
  const r = await vendorDeps({ html: HTML, outDir: out, fetchImpl: c.fetchImpl, ...extra });
  return { r, out, c };
};

test('localPathFor: mirrors host + path, hashes query strings, refuses traversal', async () => {
  const { localPathFor } = await mod();
  assert.equal(localPathFor(FB_URL), 'vendor/gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
  assert.match(localPathFor(GF_URL), /^vendor\/fonts\.googleapis\.com\/css2-[0-9a-f]{8}\.css$/);
  assert.notEqual(localPathFor(GF_URL), localPathFor(GF_URL + '&x=1'));
  // the URL parser already resolves "%2e%2e" segments, and a double-encoded one is neutralised ("%" becomes "_")
  assert.equal(localPathFor('https://x.com/%2e%2e/etc/passwd'), 'vendor/x.com/etc/passwd');
  assert.ok(!localPathFor('https://x.com/a/%252e%252e/b').split('/').includes('..'));
  assert.ok(localPathFor('https://x.com/a/%252e%252e/b').startsWith('vendor/x.com/'));
  assert.throws(() => localPathFor('https://x.com/'), /cannot map/);
});

test('splitTopLevel / keepWoff2Only: commas inside url() or data URIs are not separators', async () => {
  const { splitTopLevel, keepWoff2Only } = await mod();
  assert.deepEqual(splitTopLevel('url(data:a,b) format("x"), url(c.woff2) format("woff2")').length, 2);
  const css = '@font-face{src:url(a.woff2) format("woff2"),url(a.ttf) format("truetype");}@font-face{src:url(only.ttf) format("truetype")}';
  const out = keepWoff2Only(css);
  assert.ok(out.includes('a.woff2') && !out.includes('a.ttf'));
  assert.ok(out.includes('only.ttf'), 'a face with no woff2 keeps what it has');
});

test('the page is rewritten: every CDN script/stylesheet is local, hints are dropped, other attributes survive', async () => {
  const { r } = await run();
  const html = r.html;
  assert.ok(html.includes('src="vendor/gstatic.com/firebasejs/10.13.2/firebase-app-compat.js" defer'), 'defer kept');
  assert.ok(html.includes('vendor/cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js'));
  assert.ok(html.includes('href="vendor/cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css"'));
  assert.match(html, /href="vendor\/fonts\.googleapis\.com\/css2-[0-9a-f]{8}\.css" rel="stylesheet"/);
  assert.ok(!/rel="preconnect"/.test(html), 'preconnect hints are removed');
  assert.ok(!/integrity=|crossorigin/.test(html.replace(/<script>[\s\S]*?<\/script>/, '')), 'integrity/crossorigin removed from rewritten tags');
  assert.ok(html.includes('href="css/base.css"') && html.includes('src="js/app.js" defer'), 'local tags untouched');
  assert.ok(html.includes('https://evil.example/never.css'), 'text inside an inline <script> is never treated as a tag');
  assert.equal(r.dropped.length, 1);
});

test('css is followed: fonts are mirrored, absolute urls rewritten, relative ones kept, ttf not downloaded', async () => {
  const { r, out, c } = await run();
  const gf = Object.keys(r.files).find((p) => /css2-[0-9a-f]{8}\.css$/.test(p));
  const gfCss = fs.readFileSync(path.join(out, gf), 'utf8');
  assert.ok(gfCss.includes('url(../fonts.gstatic.com/s/amiri/v27/aaa.woff2)'));
  assert.ok(gfCss.includes("url('../fonts.gstatic.com/s/hind/v12/bbb.woff2')"), 'quotes preserved');
  assert.ok(fs.existsSync(path.join(out, 'vendor/fonts.gstatic.com/s/amiri/v27/aaa.woff2')));
  const fa = fs.readFileSync(path.join(out, 'vendor/cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css'), 'utf8');
  assert.ok(fa.includes('url(../webfonts/fa-solid-900.woff2)') && !fa.includes('.ttf'), 'woff2 only');
  assert.ok(fa.includes('data:image/svg+xml;base64,AAA,BBB'), 'data URIs untouched');
  assert.ok(fs.existsSync(path.join(out, 'vendor/cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-solid-900.woff2')));
  assert.ok(!c.hits.some((u) => u.endsWith('.ttf')), 'the ttf variant was never requested');
  assert.equal(Object.keys(r.files).length, 7);
  for (const [p, f] of Object.entries(r.files)) assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(out, p))).digest('hex'), f.sha256, p);
});

test('--keep-all-font-formats keeps the ttf sources', async () => {
  const { r, out } = await run({ woff2Only: false }, { 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/webfonts/fa-solid-900.ttf': Buffer.alloc(30, 1) });
  const fa = fs.readFileSync(path.join(out, 'vendor/cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css'), 'utf8');
  assert.ok(fa.includes('.ttf'));
  assert.ok(Object.keys(r.files).some((p) => p.endsWith('.ttf')));
});

test('bad downloads stop the build: 404, an HTML error page instead of a script, a fake woff2, an oversized file', async () => {
  const { vendorDeps } = await mod();
  const bad = async (overrides, re) => {
    const c = cdn(overrides);
    await assert.rejects(vendorDeps({ html: HTML, outDir: tmp(), fetchImpl: c.fetchImpl }), re);
  };
  await bad({ [FB_URL]: undefined }, /HTTP 404/);
  await bad({ [FB_URL]: '<!DOCTYPE html><html>blocked</html>' }, /HTML page instead of a js file/);
  await bad({ 'https://fonts.gstatic.com/s/amiri/v27/aaa.woff2': Buffer.from('not a font at all') }, /not a woff2 file/);
  await bad({ [EJS_URL]: Buffer.alloc(3 * 1024 * 1024 + 1, 65) }, /larger than/);
  await bad({ [FB_URL]: () => { throw new Error('ECONNRESET'); } }, /could not download .*ECONNRESET/);
});

test('transient errors are retried (network error, 503); a 404 is final and not retried', async () => {
  const { vendorDeps } = await mod();
  let n = 0;
  const flaky = cdn({ [FB_URL]: () => { n++; if (n === 1) throw new Error('ECONNRESET'); if (n === 2) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }; return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('/* ok */').buffer }; } });
  const r = await vendorDeps({ html: HTML, outDir: tmp(), fetchImpl: flaky.fetchImpl });
  assert.equal(n, 3, 'two failures, then success');
  assert.ok(Object.keys(r.files).some((p) => p.endsWith('firebase-app-compat.js')));
  let m = 0;
  const gone = cdn({ [FB_URL]: () => { m++; return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }; } });
  await assert.rejects(vendorDeps({ html: HTML, outDir: tmp(), fetchImpl: gone.fetchImpl }), /HTTP 404/);
  assert.equal(m, 1, 'a 404 is not retried');
  let k = 0;
  const down = cdn({ [FB_URL]: () => { k++; throw new Error('ETIMEDOUT'); } });
  await assert.rejects(vendorDeps({ html: HTML, outDir: tmp(), fetchImpl: down.fetchImpl }), /ETIMEDOUT/);
  assert.equal(k, 3, 'gives up after 3 attempts');
});

test('lock file: written on the first run, enforced afterwards; Google Fonts changes only warn', async () => {
  const lock = path.join(tmp(), 'vendor.lock.json');
  const first = await run({ lockPath: lock, lockPolicy: 'enforce' });
  assert.ok(first.r.warnings.some((w) => /lock file written/.test(w)));
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(lock, 'utf8')).files).length, 7);
  const same = await run({ lockPath: lock, lockPolicy: 'enforce' });
  assert.deepEqual(same.r.warnings, []);
  await assert.rejects(run({ lockPath: lock, lockPolicy: 'enforce' }, { [FB_URL]: '/* firebase CHANGED */' }), /firebase-app-compat\.js differs from vendor\.lock\.json/);
  const warn = await run({ lockPath: lock, lockPolicy: 'warn' }, { [FB_URL]: '/* firebase CHANGED */' });
  assert.ok(warn.r.warnings.some((w) => /WARNING.*firebase-app-compat/.test(w)));
  const fonts = await run({ lockPath: lock, lockPolicy: 'enforce' }, { 'https://fonts.gstatic.com/s/amiri/v27/aaa.woff2': Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(9, 1)]) });
  assert.ok(fonts.r.warnings.some((w) => /aaa\.woff2 differs/.test(w)), 'volatile font files never block a build');
  await run({ lockPath: lock, lockPolicy: 'enforce', updateLock: true }, { [FB_URL]: '/* firebase CHANGED */' });
  assert.deepEqual((await run({ lockPath: lock, lockPolicy: 'enforce' }, { [FB_URL]: '/* firebase CHANGED */' })).r.warnings, []);
});

test('the download cache makes a rebuild work without any network (--offline)', async () => {
  const { vendorDeps } = await mod();
  const cache = tmp();
  await run({ cacheDir: cache });
  const dead = async () => { throw new Error('network must not be used'); };
  const r = await vendorDeps({ html: HTML, outDir: tmp(), fetchImpl: dead, cacheDir: cache, offline: true });
  assert.equal(Object.keys(r.files).length, 7);
  await assert.rejects(vendorDeps({ html: HTML, outDir: tmp(), fetchImpl: dead, cacheDir: tmp(), offline: true }), /not in the cache and --offline/);
});

test('the real index.html: every external script/stylesheet is found (what the website loads from CDNs)', async () => {
  const { findTags, isExternal } = await import('../scripts/web/html-tools.mjs');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const ext = findTags(html).filter((t) => isExternal(t.name === 'script' ? t.attrs.src : t.attrs.href)).map((t) => t.attrs.src || t.attrs.href);
  assert.ok(ext.some((u) => u.includes('firebase-app-compat.js')));
  assert.ok(ext.some((u) => u.includes('fonts.googleapis.com/css2')));
  assert.ok(ext.some((u) => u.includes('font-awesome')));
  assert.ok(ext.some((u) => u.includes('@emailjs/browser')));
  assert.ok(ext.length >= 8 && ext.length <= 12, 'unexpected number of external tags: ' + ext.length);
});
