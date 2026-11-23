// ---------------------------------------------------------------------------------------------------------------------
// scripts/web/audit-launch.mjs
//
// "Can this bundle start with no network?" - answered by reading the bundle, not by hoping.
//   errors    the app would not start offline (a script/stylesheet is fetched from the internet, a file the start page needs
//             is missing, the Quran data is absent or does not match its checksums, the standalone layer is not wired in)
//   warnings  worth a look, never blocking (a host nobody listed, a stylesheet reference that is also dead on the website)
// It is run by build-web.mjs on every build and by tests/web-build.test.js.
// ---------------------------------------------------------------------------------------------------------------------
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findTags, isExternal, relTokens } from './html-tools.mjs';

const LOADING_RELS = new Set(['stylesheet', 'preload', 'modulepreload', 'prefetch', 'manifest', 'icon', 'apple-touch-icon', 'shortcut']);
const HOST_SUFFIXES = ['.googleapis.com', '.gstatic.com', '.firebaseio.com', '.firebaseapp.com', '.web.app', '.cloudfunctions.net', '.google.com'];

export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}
// every host the code may talk to, from bundle-config.json
export const hostsFromConfig = (cfg) => [...((cfg && cfg.optionalOnlineHosts) || []), ...((cfg && cfg.websiteOnlyHosts) || [])];
export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function stringsIn(source, name) {
  const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`).exec(source);
  return m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : [];
}

export function auditBundle(wwwDir, opts = {}) {
  const { requireQuran = true, allowIncomplete = false, optionalHosts = [] } = opts;
  const errors = [];
  const warnings = [];
  const info = {};
  const has = (rel) => fs.existsSync(path.join(wwwDir, rel));
  const soft = allowIncomplete ? warnings : errors;
  const clean = (u) => u.split('#')[0].split('?')[0];

  if (!has('index.html')) return { errors: ['index.html is missing'], warnings, info };
  const html = fs.readFileSync(path.join(wwwDir, 'index.html'), 'utf8');

  // 1. the start page: nothing from the network, nothing missing
  for (const tag of findTags(html)) {
    const url = tag.name === 'script' ? tag.attrs.src : tag.attrs.href;
    if (!url) continue;
    if (isExternal(url)) {
      const rels = relTokens(tag.attrs);
      if (tag.name === 'script' || rels.some((r) => LOADING_RELS.has(r))) soft.push(`index.html loads ${url} from the network - the app could not start offline`);
      continue;
    }
    if (/^(?:data:|#|javascript:)/i.test(url)) continue;
    if (!has(clean(url))) errors.push(`index.html references ${clean(url)}, which is not in the bundle`);
  }

  // 2. the standalone layer is wired in, and before everything else
  const iConfig = html.indexOf('window.QR_STANDALONE');
  const iLocal = html.indexOf('js/local-data.js');
  const iCalc = html.indexOf('js/prayer-calc.js');
  const iNet = html.indexOf('js/standalone-net.js');
  const iBridge = html.indexOf('js/quran-native.js');
  const iSync = html.indexOf('js/native-sync.js');
  const iPlatform = html.indexOf('js/platform.js');
  if (iConfig < 0 || iLocal < 0 || iCalc < 0 || iNet < 0 || iBridge < 0 || iSync < 0) errors.push('index.html does not load the standalone layer (QR_STANDALONE, js/local-data.js, js/prayer-calc.js, js/standalone-net.js, js/quran-native.js, js/native-sync.js)');
  else if (!(iConfig < iLocal && iLocal < iCalc && iCalc < iNet && iNet < iBridge && iBridge < iSync && (iPlatform < 0 || iSync < iPlatform))) errors.push('the standalone layer must load before js/platform.js and in the order config, local-data, prayer-calc, standalone-net, quran-native, native-sync');
  if (has('sw.js')) warnings.push('sw.js is in the bundle although the app does not use a service worker');

  // 3. every file the app layer loads later (js/platform.js lists them) exists
  if (has('js/platform.js')) {
    const src = fs.readFileSync(path.join(wwwDir, 'js/platform.js'), 'utf8');
    const listed = [...stringsIn(src, 'var APP_STYLES'), ...stringsIn(src, 'var APP_SCRIPTS')];
    const splash = /SPLASH_FILES\s*=\s*\{([\s\S]*?)\}/.exec(src);
    if (splash) listed.push(...[...splash[1].matchAll(/:\s*'([^']+)'/g)].map((x) => x[1]));
    info.platformFiles = listed.length;
    if (listed.length < 15) errors.push(`js/platform.js lists only ${listed.length} app files - could not read its file lists`);
    for (const f of listed) if (!has(f)) errors.push(`js/platform.js loads ${f}, which is not in the bundle`);
  } else errors.push('js/platform.js is missing');

  // 4. stylesheets: no remote url(), every local url() exists
  const files = listFiles(wwwDir);
  info.files = files.length;
  info.bytes = files.reduce((a, f) => a + fs.statSync(path.join(wwwDir, f)).size, 0);
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(wwwDir, f), 'utf8');
    for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|@import\s+(?:"([^"]+)"|'([^']+)')/gi)) {
      const ref = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();
      if (!ref || /^(?:data:|#|about:)/i.test(ref)) continue;
      if (isExternal(ref)) { soft.push(`${f} fetches ${ref} from the network`); continue; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), clean(ref)));
      if (!has(target)) (f.startsWith('vendor/') ? errors : warnings).push(`${f} refers to ${ref} (${target}), which is not in the bundle${f.startsWith('vendor/') ? '' : ' (check whether the website has the same dead reference)'}`);
    }
  }

  // 5. the offline Quran data, re-verified against its own manifest
  const qdir = path.join(wwwDir, 'data', 'quran');
  if (!fs.existsSync(path.join(qdir, 'manifest.json'))) {
    if (requireQuran) soft.push('data/quran/manifest.json is missing - the Quran could not be read on a first start without a network');
    info.quran = null;
  } else {
    const manifest = JSON.parse(fs.readFileSync(path.join(qdir, 'manifest.json'), 'utf8'));
    let bad = 0;
    for (const [rel, f] of Object.entries(manifest.files || {})) {
      const p = path.join(qdir, rel);
      if (!fs.existsSync(p) || fs.statSync(p).size !== f.bytes || sha256File(p) !== f.sha256) { errors.push(`data/quran/${rel} does not match the checksum in its manifest`); bad++; }
    }
    if (!manifest.counts || manifest.counts.surahs !== 114 || manifest.counts.ayahs !== 6236) errors.push('data/quran/manifest.json does not describe 114 surahs / 6236 ayahs');
    info.quran = { datasetSha256: manifest.datasetSha256, editions: manifest.editions, limits: manifest.limits, verifiedFiles: Object.keys(manifest.files || {}).length - bad };
  }

  // 6. hosts the code talks to at run time (all optional online services) - unknown ones are listed for review
  const known = new Set(optionalHosts);
  const seen = {};
  for (const f of files.filter((x) => /^(?:js|app\/js)\/.*\.js$/.test(x))) {
    const text = fs.readFileSync(path.join(wwwDir, f), 'utf8');
    for (const m of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)) {
      const host = m[1].toLowerCase();
      (seen[host] ||= new Set()).add(f);
    }
  }
  info.onlineHosts = Object.fromEntries(Object.entries(seen).map(([h, s]) => [h, s.size]));
  for (const host of Object.keys(seen)) {
    if (known.has(host) || HOST_SUFFIXES.some((s) => host.endsWith(s))) continue;
    warnings.push(`unlisted online host in the app code: ${host} (${[...seen[host]].slice(0, 2).join(', ')}) - add it to optionalOnlineHosts in scripts/web/bundle-config.json if it is expected`);
  }
  return { errors, warnings, info };
}

// ----- CLI: node scripts/web/audit-launch.mjs build/www [--allow-incomplete] -----
import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || 'build/www';
  const cfgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundle-config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const r = auditBundle(dir, { allowIncomplete: process.argv.includes('--allow-incomplete'), optionalHosts: hostsFromConfig(cfg) });
  for (const w of r.warnings) console.log('WARNING:', w);
  for (const e of r.errors) console.log('ERROR:', e);
  console.log(`${r.errors.length ? 'FAILED' : 'OK'}: ${r.info.files} files, ${(r.info.bytes / 1048576).toFixed(1)} MB, ${r.errors.length} errors, ${r.warnings.length} warnings`);
  process.exit(r.errors.length ? 1 : 0);
}
