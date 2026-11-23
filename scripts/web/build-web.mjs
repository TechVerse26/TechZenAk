#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// scripts/web/build-web.mjs  -  makes the web bundle that is packed INTO the Android app (build/www)
//
// The old Android build was a shell around https://quranbangla.vercel.app. This builds what the shell now contains:
//   1. copies the web app (see scripts/web/bundle-config.json for the include / exclude lists)
//   2. vendors every CDN file the start page uses (Firebase SDK, Font Awesome, Google Fonts, EmailJS, the QR library)
//   3. builds the offline Quran dataset (tools/quran-data/quran_data.py) into data/quran
//   4. adds the standalone layer to index.html (window.QR_STANDALONE, js/local-data.js, js/prayer-calc.js, js/standalone-net.js, js/quran-native.js, js/native-sync.js) and removes
//      what a bundled app cannot use (the web manifest link)
//   5. audits the result (scripts/web/audit-launch.mjs): a bundle that could not start offline fails the build
//   6. writes bundle-manifest.json (SHA-256 of every file)
// The website itself is not touched: index.html in the repository stays exactly as it is; only the COPY is rewritten.
//
//   node scripts/web/build-web.mjs [--out build/www] [--site-url URL] [--bundle-id ID] [--app-version V]
//        [--vendor-cache DIR] [--offline] [--update-vendor-lock] [--vendor-lock-policy off|warn|enforce]
//        [--quran-from-dir DIR] [--quran-cache DIR] [--quran-lock-policy off|warn|enforce] [--update-quran-lock]
//        [--allow-incomplete]   (developer preview only: skips vendoring / Quran data problems with a loud warning)
// ---------------------------------------------------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditBundle, hostsFromConfig, listFiles, sha256File } from './audit-launch.mjs';
import { applyEdits, findTags, insertAfter, relTokens } from './html-tools.mjs';
import { vendorDeps } from './vendor-deps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
export class BuildError extends Error {}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function copyTree(src, dst, rel, isExcluded, out) {
  const abs = path.join(src, rel);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return;
  const posix = rel.split(path.sep).join('/');
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs)) copyTree(src, dst, path.join(rel, e), isExcluded, out);
  } else if (!isExcluded(posix)) {
    fs.mkdirSync(path.dirname(path.join(dst, rel)), { recursive: true });
    fs.copyFileSync(abs, path.join(dst, rel));
    out.push(posix);
  }
}

export function standaloneBlock({ siteUrl, bundleId, appVersion }) {
  const cfg = { siteUrl, dataBase: 'data/quran/', bundleId, appVersion };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `\n<script>window.QR_STANDALONE=${json};</script>\n<script src="js/local-data.js"></script>\n<script src="js/prayer-calc.js"></script>\n<script src="js/standalone-net.js"></script>\n<script src="js/quran-native.js"></script>\n<script src="js/native-sync.js"></script>`;
}

export function siteUrlFromConfig(repo) {
  const f = path.join(repo, 'app-config.js');
  const m = fs.existsSync(f) ? /siteUrl\s*:\s*'([^']+)'/.exec(fs.readFileSync(f, 'utf8')) : null;
  return m ? m[1] : '';
}

export function transformIndex(html, cfg, block) {
  const edits = [];
  for (const rule of cfg.removeFromIndex || []) {
    for (const t of findTags(html)) {
      if (t.name === rule.tag && relTokens(t.attrs).includes(rule.rel)) edits.push({ start: t.start, end: t.end, text: '' });
    }
  }
  let out = applyEdits(html, edits);
  let r = insertAfter(out, /<meta\s+charset=[^>]*>/i, block);
  if (!r.ok) r = insertAfter(out, /<head[^>]*>/i, block);
  if (!r.ok) throw new BuildError('index.html has no <head> to add the standalone layer to');
  return r.html;
}

export async function buildWeb(o) {
  const repo = o.repo || REPO;
  const out = path.resolve(o.outDir || path.join(repo, 'build', 'www'));
  const log = o.log || (() => {});
  const warnings = [];
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'bundle-config.json'), 'utf8'));
  const siteUrl = (o.siteUrl || process.env.SITE_URL || process.env.LIVE_URL || siteUrlFromConfig(repo) || '').replace(/\/+$/, '');
  if (siteUrl && !/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(siteUrl)) throw new BuildError(`siteUrl must be an https:// address: ${siteUrl}`);
  if (!siteUrl) warnings.push('no site URL: the optional backend features (AI Tafsir, story moderation) will not be reachable from the app');

  // 1. copy
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const excluded = new Set((cfg.exclude || []).map((x) => x.path));
  const globs = (cfg.excludeGlobs || []).map(globToRegExp);
  const isExcluded = (p) => excluded.has(p) || globs.some((g) => g.test(p));
  const copied = [];
  for (const f of cfg.include.files) {
    if (!fs.existsSync(path.join(repo, f))) throw new BuildError(`${f} is listed in bundle-config.json but missing`);
    copyTree(repo, out, f, isExcluded, copied);
  }
  for (const d of cfg.include.dirs) {
    if (!fs.existsSync(path.join(repo, d))) throw new BuildError(`${d}/ is listed in bundle-config.json but missing`);
    copyTree(repo, out, d, isExcluded, copied);
  }
  log(`copied ${copied.length} files`);

  // 2. vendor the CDN files
  let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  if (o.vendor !== false) {
    const v = o.vendor || {};
    const r = await vendorDeps({
      html, outDir: out, fetchImpl: o.fetchImpl || fetch, cacheDir: v.cacheDir || '', offline: !!v.offline, woff2Only: v.woff2Only !== false,
      lockPath: v.lockPath === undefined ? path.join(HERE, 'vendor.lock.json') : v.lockPath, lockPolicy: v.lockPolicy || 'warn', updateLock: !!v.updateLock,
      extraUrls: (cfg.extraVendor || []).map((x) => x.url), log
    });
    html = r.html;
    warnings.push(...r.warnings);
    log(`vendored ${Object.keys(r.files).length} CDN files`);
  } else warnings.push('NOT vendored: the page still loads Firebase, fonts and icons from the internet (developer preview only)');

  // 3. the offline Quran data
  const q = o.quran || {};
  if (q.enabled !== false) {
    const py = ['python3', 'python'].find((c) => spawnSync(c, ['--version']).status === 0);
    if (!py) throw new BuildError('python3 is needed to build the offline Quran data (tools/quran-data/quran_data.py)');
    const args = [path.join(repo, 'tools', 'quran-data', 'quran_data.py'), 'build', '--out', path.join(out, 'data', 'quran'),
      '--lock', q.lockPath === undefined ? path.join(repo, 'tools', 'quran-data', 'quran-data.lock.json') : q.lockPath, '--lock-policy', q.lockPolicy || 'warn'];
    if (q.fromDir) args.push('--from-dir', q.fromDir);
    if (q.cacheDir) args.push('--cache-dir', q.cacheDir);
    if (q.updateLock) args.push('--update-lock');
    const res = spawnSync(py, args, { encoding: 'utf8' });
    if (res.status !== 0) throw new BuildError('the Quran data could not be built:\n' + res.stdout + res.stderr);
    for (const line of res.stdout.split('\n')) if (line.startsWith('WARNING') || line.includes('lock file')) warnings.push('quran data: ' + line);
    log(res.stdout.trim().split('\n').pop());
  } else warnings.push('NOT built: the offline Quran data (developer preview only) - the Quran needs a network on the first start');

  // 4. standalone layer
  const bundleId = String(o.bundleId || o.appVersion || 'dev');
  html = transformIndex(html, cfg, standaloneBlock({ siteUrl, bundleId, appVersion: String(o.appVersion || '') }));
  fs.writeFileSync(path.join(out, 'index.html'), html);

  // 5. audit
  const audit = auditBundle(out, { allowIncomplete: !!o.allowIncomplete, requireQuran: q.enabled !== false, optionalHosts: hostsFromConfig(cfg) });
  warnings.push(...audit.warnings);
  if (audit.errors.length) throw new BuildError('the bundle could not start offline:\n  - ' + audit.errors.join('\n  - '));

  // 6. manifest
  const files = {};
  for (const f of listFiles(out)) files[f] = { bytes: fs.statSync(path.join(out, f)).size, sha256: sha256File(path.join(out, f)) };
  const bundleSha256 = crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).map(([p, f]) => [p, f.sha256]))).digest('hex');
  const manifest = {
    schema: 1, generator: 'scripts/web/build-web.mjs', bundleId, appVersion: String(o.appVersion || ''), siteUrl,
    generatedAt: new Date().toISOString(), fileCount: Object.keys(files).length, totalBytes: Object.values(files).reduce((a, f) => a + f.bytes, 0),
    bundleSha256, quran: audit.info.quran || null, excluded: (cfg.exclude || []).map((x) => x.path), files
  };
  fs.writeFileSync(path.join(out, 'bundle-manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  return { outDir: out, manifest, warnings, audit };
}

// ----- CLI -----
function parseArgs(argv) {
  const o = { vendor: {}, quran: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--out') o.outDir = next();
    else if (a === '--site-url') o.siteUrl = next();
    else if (a === '--bundle-id') o.bundleId = next();
    else if (a === '--app-version') o.appVersion = next();
    else if (a === '--vendor-cache') o.vendor.cacheDir = next();
    else if (a === '--offline') o.vendor.offline = true;
    else if (a === '--update-vendor-lock') o.vendor.updateLock = true;
    else if (a === '--vendor-lock-policy') o.vendor.lockPolicy = next();
    else if (a === '--quran-from-dir') o.quran.fromDir = next();
    else if (a === '--quran-cache') o.quran.cacheDir = next();
    else if (a === '--quran-lock-policy') o.quran.lockPolicy = next();
    else if (a === '--update-quran-lock') o.quran.updateLock = true;
    else if (a === '--allow-incomplete') { o.allowIncomplete = true; }
    else if (a === '--skip-vendor') o.vendor = false;
    else if (a === '--skip-quran') o.quran = { enabled: false };
    else throw new BuildError('unknown option ' + a);
  }
  if ((o.vendor === false || o.quran.enabled === false) && !o.allowIncomplete) throw new BuildError('--skip-vendor / --skip-quran make a bundle that cannot start offline; add --allow-incomplete if that is what you want (developer preview)');
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const r = await buildWeb({ ...o, log: console.log });
    for (const w of r.warnings) console.log('WARNING:', w);
    console.log(`OK: ${r.outDir} - ${r.manifest.fileCount} files, ${(r.manifest.totalBytes / 1048576).toFixed(1)} MB, bundle ${r.manifest.bundleSha256.slice(0, 12)}`);
  } catch (e) {
    console.error('ERROR: ' + (e.message || e));
    process.exit(1);
  }
}
