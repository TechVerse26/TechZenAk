// ---------------------------------------------------------------------------------------------------------------------
// android-build/apk-bundle-check.mjs
//
// Proves the "standalone" promise from the OUTSIDE, on the finished APK (an APK is a zip file):
//   * assets/capacitor.config.json has no server.url - the app does not load a website
//   * assets/public/index.html is the standalone page (window.QR_STANDALONE)
//   * EVERY file listed in assets/public/bundle-manifest.json is inside the APK with the listed size and SHA-256
//   * the offline Quran data is there and describes 114 surahs / 6236 ayahs
// Only Node.js built-ins are used (a small zip reader), so it runs anywhere audit-apk.mjs runs.
// ---------------------------------------------------------------------------------------------------------------------
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
// files Capacitor itself adds to assets/public during `cap sync` - not part of the web bundle, not a problem
const CAPACITOR_FILES = new Set(['native-bridge.js', 'cordova.js', 'cordova_plugins.js']);

export function readZipIndex(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const index = new Map();
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new Error('damaged zip central directory');
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    index.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10), compressedSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42)
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return index;
}

export function readZipEntry(buf, e) {
  if (buf.readUInt32LE(e.offset) !== LOC_SIG) throw new Error('damaged zip local header');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported zip compression method ' + e.method);
}

// -> { findings: [{ level: 'error' | 'warn', text }], info }
export function checkStandalone(apkBuffer) {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });
  const info = { files: null, bytes: 0, bundleId: '', quranEditions: [], serverUrl: '' };
  let index;
  try { index = readZipIndex(apkBuffer); } catch (e) { add('error', 'the APK could not be read as a zip file: ' + e.message); return { findings, info }; }
  const text = (name) => { const e = index.get(name); return e ? readZipEntry(apkBuffer, e).toString('utf8') : null; };
  const json = (name) => { const s = text(name); if (s === null) return null; try { return JSON.parse(s.replace(/^\uFEFF/, '')); } catch (e) { return undefined; } };

  // 1. no remote UI
  const cap = json('assets/capacitor.config.json');
  if (cap === null) add('error', 'assets/capacitor.config.json is not in the APK');
  else if (cap === undefined) add('error', 'assets/capacitor.config.json is not valid JSON');
  else {
    info.serverUrl = (cap.server && cap.server.url) || '';
    if (info.serverUrl) add('error', `capacitor.config.json has server.url ${info.serverUrl}: the app would load that website instead of its own bundle`);
    if (cap.server && cap.server.androidScheme && cap.server.androidScheme !== 'https') add('warn', `server.androidScheme is ${cap.server.androidScheme} - the app origin should be https://localhost`);
    if (cap.server && cap.server.errorPath) add('warn', 'server.errorPath is set - it is only used for a remote page and is not needed in a standalone app');
  }

  // 2. the page
  const html = text('assets/public/index.html');
  if (html === null) add('error', 'assets/public/index.html is not in the APK - the app has no start page');
  else if (!html.includes('window.QR_STANDALONE')) add('error', 'assets/public/index.html is not the standalone page (no window.QR_STANDALONE)');

  // 3. every bundled file, byte for byte
  const manifest = json('assets/public/bundle-manifest.json');
  if (manifest === null || manifest === undefined) add('error', 'assets/public/bundle-manifest.json is ' + (manifest === null ? 'missing' : 'not valid JSON') + ' - the web bundle cannot be verified');
  else if (manifest.schema !== 1 || !manifest.files || typeof manifest.files !== 'object') add('error', 'assets/public/bundle-manifest.json has an unsupported format');
  else {
    info.bundleId = String(manifest.bundleId || '');
    const problems = [];
    for (const [rel, want] of Object.entries(manifest.files)) {
      const e = index.get('assets/public/' + rel);
      if (!e) { problems.push(`${rel} is missing from the APK`); continue; }
      let data;
      try { data = readZipEntry(apkBuffer, e); } catch (err) { problems.push(`${rel} cannot be read (${err.message})`); continue; }
      if (data.length !== want.bytes || crypto.createHash('sha256').update(data).digest('hex') !== want.sha256) problems.push(`${rel} differs from bundle-manifest.json`);
      else info.bytes += data.length;
    }
    info.files = Object.keys(manifest.files).length - problems.length;
    for (const p of problems.slice(0, 8)) add('error', 'web bundle: ' + p);
    if (problems.length > 8) add('error', `web bundle: ${problems.length - 8} more problem(s)`);
    const extras = [...index.keys()].filter((n) => n.startsWith('assets/public/') && !n.endsWith('/'))
      .map((n) => n.slice('assets/public/'.length)).filter((n) => n !== 'bundle-manifest.json' && !(n in manifest.files) && !CAPACITOR_FILES.has(n));
    if (extras.length) add('warn', `${extras.length} file(s) in assets/public are not part of the verified bundle, e.g. ${extras.slice(0, 3).join(', ')}`);
  }

  // 4. the offline Quran
  const quran = json('assets/public/data/quran/manifest.json');
  if (quran === null || quran === undefined) add('error', 'the offline Quran data is not in the APK (assets/public/data/quran/manifest.json) - the Quran would need a network on the first start');
  else if (!quran.counts || quran.counts.surahs !== 114 || quran.counts.ayahs !== 6236) add('error', 'the offline Quran data does not describe 114 surahs / 6236 ayahs');
  else info.quranEditions = Array.isArray(quran.editions) ? quran.editions : [];
  return { findings, info };
}
