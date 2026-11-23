#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// scripts/web/vendor-deps.mjs
//
// The website loads a few libraries and fonts from CDNs (Firebase SDK, Font Awesome, Google Fonts, EmailJS). That is fine in
// a browser, but the standalone Android app must start with NO network, so every CDN file the start page references is
// copied into the bundle (build/www/vendor/...) and the page is rewritten to use the local copies.
//
// It reads the page itself, so whatever index.html references is what gets bundled - versions are never repeated in a second
// place. CSS files are followed: every url(...) (fonts, images) is downloaded and the css is rewritten to point at the copies.
// By default only the woff2 variant of a font is kept (every browser engine the app can run on supports it).
//
// Checks: a downloaded file must look like what it should be (an HTML error page is not a script), size limits apply, and the
// SHA-256 of every file is compared with scripts/web/vendor.lock.json (warn or enforce; Google Fonts files are "volatile"
// because Google serves different css over time, so they are listed but never block a build).
//
//   node scripts/web/vendor-deps.mjs --html index.html --out build/www [--cache build/vendor-cache] [--offline]
//        [--lock scripts/web/vendor.lock.json] [--lock-policy off|warn|enforce] [--update-lock]
// ---------------------------------------------------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, findTags, isExternal, relTokens, removeAttr, setAttr } from './html-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A modern mobile Chrome user agent: Google Fonts answers with woff2 files only to modern browsers.
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const MAX_BYTES = { js: 3 * 1024 * 1024, css: 1024 * 1024, font: 2 * 1024 * 1024, other: 2 * 1024 * 1024 };
const VOLATILE_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const RETRIES = 3;
const RETRY_PAUSE_MS = Number(process.env.QR_VENDOR_RETRY_PAUSE_MS || 1500);
const DROP_RELS = new Set(['preconnect', 'dns-prefetch', 'preload', 'prefetch', 'modulepreload']);

export class VendorError extends Error {}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha8 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

// vendor/<host>/<path>  (query strings become a short hash so two different css requests never collide)
export function localPathFor(url) {
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean).map((s) => s.replace(/[^A-Za-z0-9._@+-]/g, '_'));
  if (!segs.length || segs.some((s) => s === '.' || s === '..')) throw new VendorError('cannot map ' + url);
  if (u.search) {
    const last = segs.pop();
    const dot = last.lastIndexOf('.');
    segs.push(dot > 0 ? `${last.slice(0, dot)}-${sha8(u.search)}${last.slice(dot)}` : `${last}-${sha8(u.search)}.css`);
  }
  return ['vendor', host, ...segs].join('/');
}

function kindOf(url, hint) {
  if (hint) return hint;
  if (/\.(?:woff2?|ttf|otf|eot)(?:$|\?)/i.test(url)) return 'font';
  if (/\.css(?:$|\?)/i.test(url)) return 'css';
  if (/\.js(?:$|\?)/i.test(url)) return 'js';
  return 'other';
}

function sanityCheck(url, kind, buf) {
  const head = buf.subarray(0, 64).toString('latin1').trimStart().toLowerCase();
  if (!buf.length) throw new VendorError(`${url}: empty response`);
  if (buf.length > MAX_BYTES[kind]) throw new VendorError(`${url}: ${buf.length} bytes is larger than the ${MAX_BYTES[kind]} byte limit for ${kind} files`);
  if ((kind === 'js' || kind === 'css') && (head.startsWith('<!doctype') || head.startsWith('<html'))) throw new VendorError(`${url}: got an HTML page instead of a ${kind} file`);
  if (kind === 'font' && /\.woff2(?:$|\?)/i.test(url) && buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new VendorError(`${url}: not a woff2 file`);
  if (kind === 'css' && !buf.includes(0x7b)) throw new VendorError(`${url}: does not look like css`);
}

// ----- css -----
// splits "a, b(c,d), e" at the top-level commas only
export function splitTopLevel(value) {
  const out = [];
  let depth = 0, quote = '', cur = '';
  for (const ch of value) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// In every @font-face src list that offers a woff2 file, keep only the woff2 sources.
export function keepWoff2Only(css) {
  return css.replace(/(src\s*:\s*)([^;}]+)(;|\})/gi, (all, pre, value, end) => {
    const parts = splitTopLevel(value);
    if (parts.length < 2) return all;
    const woff2 = parts.filter((p) => /\.woff2(?:[?#"')\s]|$)|format\(\s*["']?woff2/i.test(p));
    return woff2.length && woff2.length < parts.length ? pre + woff2.map((p) => p.trim()).join(',') + end : all;
  });
}

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|@import\s+(?:"([^"]+)"|'([^']+)')/gi;
export function cssReferences(css) {
  const refs = new Set();
  let m;
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(css))) {
    const r = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
    if (r && !r.startsWith('data:') && !r.startsWith('#') && !r.startsWith('about:')) refs.add(r);
  }
  return [...refs];
}

const rel = (from, to) => {
  const r = path.posix.relative(path.posix.dirname(from), to);
  return r.startsWith('.') ? r : './' + r;
};

// ----- main -----
export async function vendorDeps(opts) {
  const { html, outDir, fetchImpl, cacheDir = '', offline = false, woff2Only = true, lockPath = '', lockPolicy = 'warn', updateLock = false } = opts;
  const log = opts.log || (() => {});
  const files = new Map(); // local path -> { bytes, sha256, source }
  const warnings = [];

  async function download(url, kind) {
    const key = cacheDir ? path.join(cacheDir, sha256(url)) : '';
    let buf = null;
    if (key && fs.existsSync(key)) buf = fs.readFileSync(key);
    else if (offline) throw new VendorError(`${url} is not in the cache and --offline is set`);
    else {
      // a CDN hiccup must not fail a build: up to 3 attempts for network errors and 5xx answers (a 404 is final)
      let res, lastError = '';
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
          res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
          if (res.ok || res.status < 500) break;
          lastError = `HTTP ${res.status}`;
        } catch (e) { res = null; lastError = String(e.message || e); }
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * attempt));
      }
      if (!res) throw new VendorError(`could not download ${url}: ${lastError}`);
      if (!res.ok) throw new VendorError(`could not download ${url}: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    }
    sanityCheck(url, kind, buf);
    if (key && !fs.existsSync(key)) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(key, buf); }
    return buf;
  }
  function store(local, buf, source) {
    const prev = files.get(local);
    if (prev && prev.sha256 !== sha256(buf)) throw new VendorError(`two different files want the same place: ${local}`);
    const file = path.join(outDir, local);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    files.set(local, { bytes: buf.length, sha256: sha256(buf), source });
  }

  async function vendorCss(url) {
    const local = localPathFor(url);
    let css = (await download(url, 'css')).toString('utf8');
    if (woff2Only) css = keepWoff2Only(css);
    const rewrite = new Map();
    for (const ref of cssReferences(css)) {
      const abs = new URL(ref, url).href;
      const target = localPathFor(abs);
      if (!files.has(target)) store(target, await download(abs, kindOf(abs)), abs);
      // same-host relative references keep their spelling (the mirror keeps the folder structure); others are rewritten
      if (isExternal(ref) || !ref.startsWith('.')) rewrite.set(ref, rel(local, target));
    }
    // token by token (never a plain text replace: "a.woff" must not damage "a.woff2")
    css = css.replace(CSS_URL_RE, (whole, a, b, c, d, e) => {
      const ref = (a ?? b ?? c ?? d ?? e ?? '').trim();
      return rewrite.has(ref) ? whole.replace(ref, rewrite.get(ref)) : whole;
    });
    store(local, Buffer.from(css, 'utf8'), url);
    return local;
  }

  const edits = [];
  const mapping = {};
  const dropped = [];
  for (const tag of findTags(html)) {
    const attr = tag.name === 'script' ? tag.attrs.src : tag.attrs.href;
    if (!attr || !isExternal(attr)) continue;
    const url = attr.startsWith('//') ? 'https:' + attr : attr;
    const rels = relTokens(tag.attrs);
    if (tag.name === 'link' && rels.some((r) => DROP_RELS.has(r))) { edits.push({ start: tag.start, end: tag.end, text: '' }); dropped.push(url); continue; }
    if (tag.name === 'link' && !rels.includes('stylesheet')) { warnings.push(`external <link rel="${tag.attrs.rel}"> left as it is: ${url}`); continue; }
    let local;
    if (tag.name === 'script') { local = localPathFor(url); if (!mapping[url]) store(local, await download(url, 'js'), url); }
    else local = mapping[url] || await vendorCss(url);
    mapping[url] = local;
    let text = setAttr(tag.text, tag.name === 'script' ? 'src' : 'href', local);
    text = removeAttr(removeAttr(text, 'integrity'), 'crossorigin');
    edits.push({ start: tag.start, end: tag.end, text });
    log(`vendored ${url} -> ${local}`);
  }

  // files the page does not reference but scripts load later (e.g. the QR code library of the 2-step-verification screen)
  for (const extra of opts.extraUrls || []) {
    const url = typeof extra === 'string' ? extra : extra.url;
    const kind = kindOf(url, extra.kind);
    if (kind === 'css') await vendorCss(url);
    else if (!files.has(localPathFor(url))) store(localPathFor(url), await download(url, kind), url);
    mapping[url] = localPathFor(url);
    log(`vendored (extra) ${url} -> ${localPathFor(url)}`);
  }

  // lock file
  const entries = Object.fromEntries([...files].map(([p, f]) => [p, { sha256: f.sha256, bytes: f.bytes }]));
  if (lockPath && lockPolicy !== 'off') {
    if (updateLock || !fs.existsSync(lockPath)) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ schema: 1, note: 'SHA-256 of every vendored CDN file. Review a change, then run with --update-lock.', files: entries }, null, 2) + '\n');
      warnings.push(`lock file written: ${lockPath} (commit it)`);
    } else {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')).files || {};
      const problems = [];
      for (const [p, f] of Object.entries(entries)) {
        const host = p.split('/')[1];
        if (!lock[p]) { if (!VOLATILE_HOSTS.has(host)) warnings.push(`not in the lock file yet: ${p}`); continue; }
        if (lock[p].sha256 !== f.sha256) (VOLATILE_HOSTS.has(host) ? warnings : problems).push(`${p} differs from vendor.lock.json`);
      }
      if (problems.length && lockPolicy === 'enforce') throw new VendorError(problems.join('; ') + ' - review the change, then run with --update-lock');
      warnings.push(...problems.map((x) => 'WARNING: ' + x));
    }
  }
  return { html: applyEdits(html, edits), files: entries, mapping, dropped, warnings };
}

// ----- CLI -----
function parseArgs(argv) {
  const o = { html: 'index.html', out: 'build/www', cache: '', offline: false, lock: path.join(HERE, 'vendor.lock.json'), lockPolicy: 'warn', updateLock: false, woff2Only: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html') o.html = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--cache') o.cache = argv[++i];
    else if (a === '--offline') o.offline = true;
    else if (a === '--lock') o.lock = argv[++i];
    else if (a === '--lock-policy') o.lockPolicy = argv[++i];
    else if (a === '--update-lock') o.updateLock = true;
    else if (a === '--keep-all-font-formats') o.woff2Only = false;
    else throw new VendorError('unknown option ' + a);
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const html = fs.readFileSync(o.html, 'utf8');
    const r = await vendorDeps({ html, outDir: o.out, fetchImpl: fetch, cacheDir: o.cache, offline: o.offline, lockPath: o.lock, lockPolicy: o.lockPolicy, updateLock: o.updateLock, woff2Only: o.woff2Only, log: console.log });
    fs.writeFileSync(path.join(o.out, 'index.vendored.html'), r.html);
    for (const w of r.warnings) console.log(w);
    console.log(`OK: ${Object.keys(r.files).length} vendor files, ${(Object.values(r.files).reduce((a, f) => a + f.bytes, 0) / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.error('ERROR: ' + (e.message || e));
    process.exit(1);
  }
}
