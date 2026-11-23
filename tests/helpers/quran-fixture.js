'use strict';
// Builds the offline Quran bundle from the TEST-ONLY fixtures (tools/quran-data/fixtures.py) into a temp folder, once per
// test process. The text in these fixtures is artificial on purpose (every ayah says "fixture"/"test"); real Quran text only
// ever comes from `quran_data.py build` against the real source.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'tools', 'quran-data');
let cached = null;

function python() {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  throw new Error('python3 is required for the Quran dataset tests');
}

function run(py, args) {
  const r = spawnSync(py, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('python failed: ' + args.join(' ') + '\n' + r.stdout + r.stderr);
  return r.stdout;
}

function buildFixtureDataset() {
  if (cached) return cached;
  const py = python();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-quran-'));
  const src = path.join(tmp, 'src');
  const out = path.join(tmp, 'out');
  run(py, [path.join(TOOLS, 'fixtures.py'), src]);
  run(py, [path.join(TOOLS, 'quran_data.py'), 'build', '--out', out, '--config', path.join(TOOLS, 'editions.json'),
    '--from-dir', src, '--lock', path.join(tmp, 'lock.json')]);
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8'));
  const sourceTexts = {};
  for (const e of ['quran-uthmani', 'quran-simple-clean', 'bn.bengali', 'en.sahih']) {
    const p = JSON.parse(fs.readFileSync(path.join(src, e + '.json'), 'utf8'));
    sourceTexts[e] = p.data.surahs.flatMap((s) => s.ayahs.map((a) => a.text));
  }
  cached = { tmp, src, dir: out, manifest: read('manifest.json'), structure: read('structure.json'), sourceTexts, python: py };
  return cached;
}

function pythonJson(code) {
  const py = python();
  return JSON.parse(run(py, ['-c', 'import sys,json; sys.path.insert(0,' + JSON.stringify(TOOLS) + '); ' + code]));
}

module.exports = { buildFixtureDataset, pythonJson, ROOT, TOOLS };
