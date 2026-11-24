#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/preflight.mjs  -  cheap repository checks that run before the slow Android build starts.
//
//   node android-build/preflight.mjs [--release]
//
// Fails (exit 1) on things that would ship a broken app: a JavaScript syntax error, a missing app UI file, a missing
// icon, a service-worker precache entry that does not exist (a 404 there makes the whole offline cache fail).
// Warns about things that must be filled in before a Google Play release (contact e-mail on the policy pages) and about a
// missing lottie-web runtime (the Android launch splash then shows the static brand splash instead of the animation).
// Also checks the tooling that makes the app standalone (scripts/web, tools/quran-data): its files and configuration exist
// and the website's own index.html has not been touched by it.
// Only Node.js built-ins are used.
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GITHUB_WORKSPACE || path.resolve(HERE, '..');
const RELEASE = process.argv.includes('--release') || process.env.QR_BUILD_RELEASE === 'true';
const gha = process.env.GITHUB_ACTIONS === 'true';
const errors = [];
const warnings = [];

const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');
const abs = (p) => path.join(REPO, p.replace(/^\.\//, '').split('?')[0].split('#')[0]);
const exists = (p) => fs.existsSync(abs(p));
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const fail = (m) => { errors.push(m); console.log(gha ? '::error::' + esc(m) : 'ERROR: ' + m); };
const warn = (m) => { warnings.push(m); console.log(gha ? '::warning::' + esc(m) : 'WARNING: ' + m); };

function listFiles(dir, ext) {
  const out = [];
  const full = abs(dir);
  if (!fs.existsSync(full)) return out;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// 1. every JavaScript file compiles (nothing is executed)
let checked = 0;
for (const f of [...listFiles('js', '.js'), ...listFiles('app/js', '.js'), 'sw.js', 'app-config.js']) {
  if (!exists(f)) continue;
  try { new vm.Script(read(f), { filename: f }); checked++; }
  catch (e) { fail(`${f}: JavaScript syntax error - ${e.message}`); }
}
console.log(`JavaScript syntax: ${checked} file(s) checked`);

// 2. the files js/platform.js loads in the app exist
if (!exists('js/platform.js')) fail('js/platform.js is missing');
else {
  const text = read('js/platform.js');
  const block = (name) => { const m = new RegExp('var ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]').exec(text); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  const styles = block('APP_STYLES'), scripts = block('APP_SCRIPTS');
  if (!styles || !scripts) fail('could not read APP_STYLES / APP_SCRIPTS from js/platform.js');
  else {
    for (const f of [...styles, ...scripts]) if (!exists(f)) fail(`app UI file listed in js/platform.js does not exist: ${f}`);
    console.log(`app UI files: ${styles.length} stylesheet(s), ${scripts.length} script(s)`);
  }
}
if (exists('index.html') && !/<script[^>]+src="js\/platform\.js"/.test(read('index.html'))) fail('index.html does not load js/platform.js (the app UI would never start)');

// 2b. the Android launch splash (Lottie): the files js/platform.js hands to app/js/splash.js
if (exists('js/platform.js')) {
  const text = read('js/platform.js');
  const m = /var SPLASH_FILES\s*=\s*\{([\s\S]*?)\}/.exec(text);
  if (!m) fail('could not read SPLASH_FILES from js/platform.js (the Lottie launch splash would never start)');
  else {
    const files = Object.fromEntries([...m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
    for (const key of ['script', 'data', 'fallback']) {
      if (!files[key]) fail(`SPLASH_FILES.${key} is missing in js/platform.js`);
      else if (!exists(files[key])) fail(`launch splash file listed in js/platform.js does not exist: ${files[key]}`);
    }
    if (files.data && exists(files.data)) {
      try {
        const a = JSON.parse(read(files.data));
        if (!Array.isArray(a.layers) || !a.layers.length || !(a.w > 0) || !(a.h > 0) || !(a.fr > 0) || !(a.op > a.ip)) fail(`${files.data} is not a usable Lottie animation (needs layers, w, h, fr and ip < op)`);
        else console.log(`launch splash animation: ${a.w}x${a.h}, ${a.fr} fps, frames ${a.ip}-${a.op}, ${a.layers.length} layer(s)`);
      } catch (e) { fail(`${files.data} is not valid JSON: ${e.message}`); }
    }
    // The runtime is part of the web bundle packed into the APK (assets/ is bundled), and the app has a static fallback - so a
    // missing runtime is a warning (the animation would not play), never a build failure.
    if (files.runtime) {
      const dir = files.runtime.replace(/\/[^/]*$/, '');
      if (!exists(files.runtime)) warn(`${files.runtime} is missing - the app will show the static brand splash instead of the animation. Add it with GitHub > Actions > "Vendor Lottie runtime" > Run workflow (or: node android-build/vendor-lottie.mjs) and deploy the site.`);
      else {
        const sha = crypto.createHash('sha256').update(fs.readFileSync(abs(files.runtime))).digest('hex');
        if (!exists(dir + '/VERSION.json')) warn(`${dir}/VERSION.json is missing - the version and checksum of the lottie-web runtime are not recorded (run node android-build/vendor-lottie.mjs)`);
        else {
          try {
            const v = JSON.parse(read(dir + '/VERSION.json'));
            if (v.sha256 !== sha) fail(`${files.runtime} does not match the sha256 recorded in ${dir}/VERSION.json - the runtime file was changed by hand (re-run node android-build/vendor-lottie.mjs)`);
            else console.log(`lottie-web runtime: ${v.name}@${v.version}, sha256 ${sha.slice(0, 12)}...`);
          } catch (e) { fail(`${dir}/VERSION.json is not valid JSON: ${e.message}`); }
        }
        if (!['LICENSE.md', 'LICENSE', 'LICENSE.txt'].some((n) => exists(dir + '/' + n))) fail(`${dir} has no license file - the license of lottie-web has to be kept next to the code`);
      }
    }
  }
  // website isolation: nothing the website serves or precaches may mention the launch splash
  for (const file of ['index.html', 'js/data.js', 'sw.js']) {
    if (!exists(file)) continue;
    let t = read(file);
    if (file !== 'index.html') {
      const lists = ['APP_SHELL_CORE', 'APP_SHELL_DEFERRED'].map((n) => { const x = new RegExp('(?:const|let|var)\\s+' + n + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;').exec(t); return x ? x[1] : ''; });
      t = lists.join('\n');
    }
    if (/lottie|quran-bangla-splash|app\/js\/splash|assets\/animations/i.test(t)) fail(`${file} references the launch splash files - the normal website must never load them`);
  }
}

// 3. the service worker precache lists point at real files
for (const file of ['js/data.js', 'sw.js']) {
  if (!exists(file)) continue;
  const text = read(file);
  for (const name of ['APP_SHELL_CORE', 'APP_SHELL_DEFERRED']) {
    const m = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;').exec(text);
    if (!m) continue;
    const entries = [...m[1].matchAll(/'(\.\/[^']*|\/[^']*)'/g)].map((x) => x[1]).filter((x) => x !== './' && x !== '/');
    const missing = entries.filter((x) => !exists(x));
    if (missing.length) fail(`${file} ${name} lists file(s) that do not exist: ${missing.join(', ')}`);
    else console.log(`${file} ${name}: ${entries.length} file(s) exist`);
  }
}

// 4. manifest + icons
if (!exists('manifest.json')) fail('manifest.json is missing');
else {
  try {
    const m = JSON.parse(read('manifest.json'));
    if (!/^#[0-9a-f]{6}$/i.test(m.theme_color || '')) warn('manifest.json theme_color is not a #RRGGBB colour - the default will be used for the system bars');
    const icons = (m.icons || []).filter((i) => /\.png/i.test(i.src));
    if (!icons.length) fail('manifest.json has no PNG icons (needed for the launcher icon)');
    for (const i of icons) if (!exists(i.src)) fail(`manifest.json icon does not exist: ${i.src}`);
    if (!icons.some((i) => /maskable/.test(i.purpose || ''))) warn('manifest.json has no "maskable" icon - the launcher icon will not be adaptive');
  } catch (e) { fail('manifest.json is not valid JSON: ' + e.message); }
}

// 5. native resources + scripts of this folder
for (const f of ['android-build/apply-native-patches.mjs', 'android-build/create-project.sh', 'android-build/res/xml/shortcuts.xml', 'android-build/res/drawable/ic_stat_quran.xml', 'android-build/res/values/qr_colors.xml']) {
  if (!exists(f)) fail(`${f} is missing`);
}

// 6. things that must be filled in before Google Play
for (const f of ['privacy.html', 'terms.html', 'account-deletion.html']) if (!exists(f)) fail(`${f} is missing (Google Play requires a privacy policy and an account-deletion page)`);
if (exists('app-config.js')) {
  const cfg = read('app-config.js');
  const email = /supportEmail\s*:\s*'([^']*)'/.exec(cfg);
  const dev = /developerName\s*:\s*'([^']*)'/.exec(cfg);
  const note = 'app-config.js: ';
  if (!email || !email[1].trim()) (RELEASE ? warn : (m) => console.log('NOTE: ' + m))(note + 'supportEmail is empty - the privacy policy shows no contact address yet. Google Play requires a contact point; set it before publishing.');
  if (!dev || !dev[1].trim()) (RELEASE ? warn : (m) => console.log('NOTE: ' + m))(note + 'developerName is empty - the privacy policy does not name the developer yet.');
} else fail('app-config.js is missing');

// 7. the standalone web bundle: the app's own copy of the web app (scripts/web, tools/quran-data)
for (const f of ['scripts/web/build-web.mjs', 'scripts/web/vendor-deps.mjs', 'scripts/web/audit-launch.mjs', 'scripts/web/html-tools.mjs', 'scripts/web/bundle-config.json',
  'tools/quran-data/quran_data.py', 'tools/quran-data/editions.json', 'js/local-data.js', 'js/prayer-calc.js', 'js/standalone-net.js', 'js/quran-native.js', 'js/native-sync.js', 'src/native/quran-native.ts', 'tsconfig.json', 'android-build/apk-bundle-check.mjs', 'android-build/native-lint.mjs']) {
  if (!exists(f)) fail(`${f} is missing (the standalone app cannot be built without it)`);
}
if (exists('scripts/web/bundle-config.json')) {
  try {
    const c = JSON.parse(read('scripts/web/bundle-config.json'));
    for (const f of c.include.files) if (!exists(f)) fail(`scripts/web/bundle-config.json includes ${f}, which does not exist`);
    for (const d of c.include.dirs) if (!exists(d)) fail(`scripts/web/bundle-config.json includes ${d}/, which does not exist`);
    for (const x of c.exclude || []) if (!exists(x.path)) warn(`scripts/web/bundle-config.json excludes ${x.path}, which no longer exists - remove the entry`);
  } catch (e) { fail('scripts/web/bundle-config.json is not valid JSON or has no include list: ' + e.message); }
}
if (exists('tools/quran-data/editions.json')) {
  try {
    const c = JSON.parse(read('tools/quran-data/editions.json'));
    const ids = [...(c.arabic || []), ...(c.translations || [])];
    if (!ids.includes(c.structureEdition)) fail('tools/quran-data/editions.json: structureEdition must be one of the listed editions');
    for (const e of ['quran-uthmani', 'quran-simple-clean', 'bn.bengali']) if (!ids.includes(e)) warn(`tools/quran-data/editions.json does not bundle ${e} - the reader, the Arabic search or the default translation would need a network on the first start`);
    console.log(`offline Quran editions: ${ids.join(', ')}`);
  } catch (e) { fail('tools/quran-data/editions.json is not valid JSON: ' + e.message); }
}
if (exists('app/js/data.js')) {
  const m = /AYAH_COUNTS\s*=\s*\[([^\]]+)\]/.exec(read('app/js/data.js'));
  const counts = m ? m[1].split(',').map((x) => Number(x.trim())) : [];
  if (counts.length !== 114 || counts.reduce((a, b) => a + b, 0) !== 6236) fail('app/js/data.js AYAH_COUNTS must list 114 surahs adding up to 6236 ayahs');
}
// website isolation: the standalone layer is added to the COPY of index.html by the build - never to the website's own page
if (exists('index.html') && /QR_STANDALONE|standalone-net\.js|local-data\.js|prayer-calc\.js|quran-native\.js|native-sync\.js/.test(read('index.html'))) fail('index.html loads the standalone layer - it must only be added by scripts/web/build-web.mjs (the website must not change)');

// 8. the native overlay (Kotlin, resources, manifest components, Room): static consistency check. There is no Kotlin compiler
//    here - the real compile happens in the build - but this catches unresolved references, missing resources and wrong
//    Room queries in seconds. (See android-build/native-lint.mjs.)
try {
  const { lintNative } = await import('./native-lint.mjs');
  const r = lintNative(HERE);
  for (const e of r.errors) fail('native overlay: ' + e);
  for (const w of r.warnings) warn('native overlay: ' + w);
  console.log(`native overlay: ${r.info.kotlinFiles} Kotlin file(s), ${r.info.classes} classes/objects, ${r.info.resFiles} resource file(s) checked`);
} catch (e) { fail('native overlay lint could not run: ' + e.message); }

console.log(`\npreflight: ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
