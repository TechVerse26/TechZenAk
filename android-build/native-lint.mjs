#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/native-lint.mjs
//
// A static consistency check of the native overlay (android-build/native). It is NOT a Kotlin compiler - the real compile
// happens in the GitHub Actions build. It catches, in seconds and without any SDK, the mistakes that most often break a
// first compile or crash a widget:
//   * unbalanced braces / parentheses, a wrong package line, a file that does not belong to its folder
//   * `unresolved reference`: a class or extension function of the app used without its import; an import that points at
//     nothing; an unknown library import; a class name that is declared nowhere
//   * resources: R.layout / R.id / R.drawable / R.string / R.xml / R.color used in Kotlin or @type/name used in XML but not
//     defined; a widget that sets a view id its own layout does not have; views a RemoteViews layout may not contain
//   * the manifest fragment: every component class exists and extends the right base class, every resource exists
//   * Room: entities, @Database list, DAO accessors, version, and every @Query (tables, columns, :parameters)
//   * the Capacitor plugin: every @PluginMethod has the (PluginCall) signature
//   * SurahData.kt is up to date with js/data.js
//
//   node android-build/native-lint.mjs            exits 1 when there is an error (warnings are printed)
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkXml } from './apply-native-patches.mjs';
import { generate as generateSurahData } from './native/generate-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUR_PACKAGE = 'com.techverse.quranbangla';
const TOKEN = '__APP_ID__';

// libraries the overlay may import; for the small, closed ones the exact class names are listed so a typo is caught
const EXTERNAL_PREFIXES = ['android.', 'androidx.', 'com.getcapacitor.', 'org.json.', 'java.', 'javax.', 'kotlin.'];
const EXTERNAL_EXACT = {
  'com.getcapacitor.': ['JSArray', 'JSObject', 'Plugin', 'PluginCall', 'PluginMethod', 'PermissionState', 'BridgeActivity', 'annotation.CapacitorPlugin', 'annotation.Permission', 'annotation.PermissionCallback'],
  'androidx.room.': ['Dao', 'Insert', 'Query', 'Update', 'OnConflictStrategy', 'Database', 'Room', 'RoomDatabase', 'Entity', 'Index', 'PrimaryKey', 'migration.Migration'],
  'androidx.core.app.': ['NotificationCompat', 'NotificationManagerCompat']
};
// names that are available without an import (Kotlin standard library, java.lang, annotations)
const IMPLICIT = new Set(['String', 'Int', 'Long', 'Double', 'Float', 'Boolean', 'Char', 'Byte', 'Short', 'Unit', 'Any', 'Nothing', 'Throwable', 'Exception', 'SecurityException',
  'Thread', 'Math', 'StringBuilder', 'ArrayList', 'HashSet', 'HashMap', 'List', 'MutableList', 'Set', 'Map', 'Pair', 'Array', 'IntArray', 'LongArray', 'Regex', 'Comparable',
  'Iterable', 'Collection', 'Sequence', 'Number', 'Enum', 'Volatile', 'Suppress', 'JvmStatic', 'Companion', 'Override', 'Synchronized', 'Charsets', 'Runnable', 'Class', 'Result',
  'IllegalArgumentException', 'IllegalStateException', 'NumberFormatException', 'Triple', 'Lazy', 'Function', 'System']);
const REMOTEVIEWS_TAGS = new Set(['FrameLayout', 'LinearLayout', 'RelativeLayout', 'GridLayout', 'AdapterViewFlipper', 'ViewFlipper', 'ListView', 'GridView', 'StackView',
  'TextView', 'Button', 'ImageView', 'ImageButton', 'ProgressBar', 'Chronometer', 'AnalogClock', 'TextClock', 'ViewStub']);
const SQL_WORDS = new Set(['select', 'from', 'where', 'order', 'by', 'desc', 'asc', 'limit', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'set', 'update', 'delete', 'insert', 'into', 'values',
  'count', 'sum', 'coalesce', 'max', 'min', 'avg', 'as', 'join', 'on', 'group', 'having', 'distinct', 'between', 'case', 'when', 'then', 'else', 'end']);

const rd = (f) => fs.readFileSync(f, 'utf8');
function files(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p)); else out.push(p);
  }
  return out.sort();
}
const posix = (p) => p.split(path.sep).join('/');

// Blanks comments and string/char literals (keeping line structure) so brace counting and token scans see code only.
export function stripKotlin(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      i += 2; continue;
    }
    if (c === '"' && src.startsWith('"""', i)) {
      i += 3;
      out += '""';
      while (i < n && !src.startsWith('"""', i)) { if (src[i] === '\n') out += '\n'; i++; }
      i += 3; continue;
    }
    if (c === '"') {
      i++; out += '""';
      while (i < n && src[i] !== '"') { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === "'") {
      let j = i + 1;
      if (src[j] === '\\') j++;
      j += 1;
      if (src[j] === "'") { out += "''"; i = j + 1; continue; }
    }
    out += c; i++;
  }
  return out;
}

export function balanced(code) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let line = 1;
  for (const ch of code) {
    if (ch === '\n') line++;
    if ('([{'.includes(ch)) stack.push([ch, line]);
    else if (')]}'.includes(ch)) {
      const top = stack.pop();
      if (!top || top[0] !== pairs[ch]) return `unbalanced "${ch}" at line ${line}`;
    }
  }
  return stack.length ? `unclosed "${stack[stack.length - 1][0]}" opened at line ${stack[stack.length - 1][1]}` : null;
}

// text between the "(" at `open` and its matching ")" (open points at the "(")
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (!depth) return { inner: s.slice(open + 1, i), end: i }; }
  }
  return null;
}
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{<'.includes(ch)) depth++;
    if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim());
}

export function lintNative(buildDir = HERE) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  const nativeDir = path.join(buildDir, 'native');
  const kotlinDir = path.join(nativeDir, 'kotlin');
  const resDir = path.join(nativeDir, 'res');
  const baseResDir = path.join(buildDir, 'res');
  const info = { kotlinFiles: 0, resFiles: 0, classes: 0 };

  if (!fs.existsSync(kotlinDir)) return { errors: ['android-build/native/kotlin is missing'], warnings, info };

  // ------------------------------------------------------------------------------------------ Kotlin: structure
  const ktFiles = files(kotlinDir).filter((f) => f.endsWith('.kt'));
  info.kotlinFiles = ktFiles.length;
  const units = []; // { file, rel, src, code, pkg, imports:Set, decls:[{kind,name}] , topFuns:Set }
  const symbols = new Map(); // fq name -> kind
  const simpleToPkgs = new Map(); // simple class name -> Set(package)
  const topFunPkg = new Map(); // function name -> Set(package)
  for (const file of ktFiles) {
    const rel = posix(path.relative(kotlinDir, file));
    const src = rd(file);
    const code = stripKotlin(src);
    const bad = balanced(code);
    if (bad) err(`${rel}: ${bad}`);
    if (/\t/.test(src)) warn(`${rel}: contains a tab character`);
    const pm = /^package\s+([\w.]+)\s*$/m.exec(code);
    if (!pm) { err(`${rel}: no package line`); continue; }
    const pkg = pm[1];
    if (pkg === TOKEN) {
      if (rel !== 'MainActivity.kt') err(`${rel}: only MainActivity.kt may use "package ${TOKEN}"`);
    } else {
      const dir = posix(path.dirname(rel));
      if (dir === '.' || pkg !== dir.split('/').join('.')) err(`${rel}: package ${pkg} does not match its folder`);
    }
    // TOKEN may only appear in the package line and in `import __APP_ID__.R`
    src.split('\n').forEach((line, i) => {
      if (line.includes(TOKEN) && !/^package\s+__APP_ID__\s*$/.test(line.trim()) && !/^import\s+__APP_ID__\.R\s*$/.test(line.trim())) err(`${rel}:${i + 1}: ${TOKEN} may only be used in "package" and "import ${TOKEN}.R"`);
    });
    const imports = new Map(); // simple name -> fq
    const starImports = [];
    for (const m of code.matchAll(/^import\s+([\w.]+)(\.\*)?(?:\s+as\s+(\w+))?\s*$/gm)) {
      if (m[2]) starImports.push(m[1]);
      else imports.set(m[3] || m[1].split('.').pop(), m[1]);
    }
    // top level declarations (brace depth 0)
    const decls = [];
    let depth = 0;
    code.split('\n').forEach((line) => {
      if (depth === 0) {
        const c = /^\s*(?:(?:public|internal|private|protected|abstract|open|data|sealed|enum|annotation|inline|const|final)\s+)*(class|object|interface|typealias)\s+(\w+)/.exec(line);
        if (c) decls.push({ kind: c[1], name: c[2] });
        const f = /^\s*(?:(?:public|internal|private|inline|tailrec|operator|infix)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.<>?,\s]*\.)?(\w+)\s*\(/.exec(line);
        if (f && !/^\s*private\s/.test(line)) decls.push({ kind: 'fun', name: f[1] });
        const v = /^\s*(?:(?:public|internal|const)\s+)*(?:val|var)\s+(\w+)\s*[:=]/.exec(line);
        if (v && !/^\s*private\s/.test(line)) decls.push({ kind: 'val', name: v[1] });
      }
      for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    });
    for (const d of decls) {
      symbols.set(`${pkg}.${d.name}`, d.kind);
      if (d.kind === 'fun') (topFunPkg.get(d.name) || topFunPkg.set(d.name, new Set()).get(d.name)).add(pkg);
      else if (d.kind !== 'val') (simpleToPkgs.get(d.name) || simpleToPkgs.set(d.name, new Set()).get(d.name)).add(pkg);
    }
    units.push({ file, rel, src, code, pkg, imports, starImports, decls });
  }
  info.classes = [...symbols.values()].filter((k) => k === 'class' || k === 'object' || k === 'interface').length;

  // ------------------------------------------------------------------------------------------ Kotlin: imports + references
  for (const u of units) {
    for (const [simple, fq] of u.imports) {
      if (fq === `${TOKEN}.R`) continue;
      if (fq.startsWith(OUR_PACKAGE + '.')) {
        if (!symbols.has(fq)) err(`${u.rel}: import ${fq} does not exist`);
        continue;
      }
      const prefix = EXTERNAL_PREFIXES.find((p) => fq.startsWith(p));
      if (!prefix) { err(`${u.rel}: import ${fq} is not from a library the app has (android, androidx, Capacitor, org.json, java, kotlin)`); continue; }
      const closed = Object.keys(EXTERNAL_EXACT).find((p) => fq.startsWith(p));
      if (closed && !EXTERNAL_EXACT[closed].includes(fq.slice(closed.length))) err(`${u.rel}: import ${fq} - unknown name in ${closed}* (typo?)`);
    }
    const imported = new Set(u.imports.keys());
    // our classes used from another package without an import
    const tokens = new Set([...u.code.matchAll(/(?<![.\w@])([A-Z][a-z]\w*)\b/g)].map((m) => m[1]));
    // every class / object / interface declared in this file at ANY depth (nested classes like DailyAyah.Pick count)
    const declaredHere = new Set([...u.decls.map((d) => d.name), ...[...u.code.matchAll(/\b(?:class|object|interface)\s+(\w+)/g)].map((m) => m[1])]);
    for (const t of tokens) {
      if (declaredHere.has(t) || imported.has(t)) continue;
      const pkgs = simpleToPkgs.get(t);
      if (pkgs) {
        if (!pkgs.has(u.pkg) && !u.starImports.some((s) => pkgs.has(s))) err(`${u.rel}: uses ${t} (package ${[...pkgs][0]}) without importing it`);
        continue;
      }
      if (IMPLICIT.has(t)) continue;
      if (u.code.includes(`<${t}>`) || new RegExp(`\\b(?:class|interface|object)\\s+\\w*<[^>]*\\b${t}\\b`).test(u.code)) continue; // a type parameter
      if (new RegExp(`\\.${t}\\b`).test(u.code)) continue;
      err(`${u.rel}: "${t}" is not declared, imported or part of the Kotlin/Java standard library (missing import?)`);
    }
    // our top level (extension) functions used from another package without an import
    for (const [name, pkgs] of topFunPkg) {
      if (pkgs.has(u.pkg) || u.decls.some((d) => d.kind === 'fun' && d.name === name)) continue;
      if (new RegExp(`(?:\\.|\\b)${name}\\s*\\(`).test(u.code) && !imported.has(name)) {
        // only ours when the name is not also a method of a library class: ours are the *OrNull / *OrDefault helpers
        if (/OrNull$|OrDefault$/.test(name)) err(`${u.rel}: uses ${name}() (package ${[...pkgs][0]}) without importing it`);
      }
    }
    if (/\bR\.(layout|id|drawable|string|xml|color|style)\./.test(u.code) && !u.imports.has('R')) err(`${u.rel}: uses R.* without "import ${TOKEN}.R"`);
  }

  // ------------------------------------------------------------------------------------------ resources
  const resNames = { layout: new Set(), xml: new Set(), drawable: new Set(), mipmap: new Set(), raw: new Set(), string: new Set(), color: new Set(), style: new Set(), dimen: new Set(), id: new Set() };
  const layouts = new Map(); // name -> { rel, text, ids:Set }
  // Android Lint treats a resource that exists only in a qualified folder (values-bn, values-night, ...) as FATAL
  // ("MissingDefaultResource": it would crash on devices that match no qualifier) - and fatal checks fail the release build.
  const inDefault = {};
  const qualified = [];
  const markDefault = (type, name) => (inDefault[type] ||= new Set()).add(name);
  const collectRes = (dir, overlay) => {
    for (const f of files(dir)) {
      const rel = posix(path.relative(dir, f));
      const [folder] = rel.split('/');
      const type = folder.replace(/-.*$/, '');
      const base = path.basename(f).replace(/\.[^.]+$/, '');
      if (overlay) info.resFiles++;
      if (!f.endsWith('.xml') && !/\.(png|webp|jpg|json|mp3|ogg)$/i.test(f)) continue;
      if (f.endsWith('.xml')) {
        const text = rd(f);
        if (overlay) { const bad = checkXml(text); if (bad) err(`res/${rel}: not well-formed XML: ${bad}`); }
        if (type === 'values') {
          for (const m of text.matchAll(/<(string|color|style|dimen)\s+name="(\w+)"/g)) {
            resNames[m[1]].add(m[2]);
            if (folder === 'values') markDefault(m[1], m[2]); else if (overlay) qualified.push({ type: m[1], name: m[2], rel });
          }
        } else if (resNames[type]) {
          resNames[type].add(base);
          if (folder === type) markDefault(type, base); else if (overlay) qualified.push({ type, name: base, rel });
        }
        for (const m of text.matchAll(/@\+id\/(\w+)/g)) resNames.id.add(m[1]);
        if (overlay && type === 'layout') layouts.set(base, { rel, text, ids: new Set([...text.matchAll(/@\+id\/(\w+)/g)].map((m) => m[1])) });
      } else if (resNames[type]) resNames[type].add(base);
    }
  };
  collectRes(baseResDir, false);
  collectRes(resDir, true);

  for (const q of qualified) {
    if (!(inDefault[q.type] && inDefault[q.type].has(q.name))) err(`res/${q.rel}: ${q.type} ${q.name} has no default in the unqualified folder - MissingDefaultResource is a fatal lint error that fails the release build`);
  }
  const overlayXml = files(resDir).filter((f) => f.endsWith('.xml'));
  for (const f of overlayXml) {
    const rel = posix(path.relative(resDir, f));
    for (const m of rd(f).matchAll(/@(layout|xml|drawable|string|color|style|mipmap|dimen)\/(\w+)/g)) {
      if (!resNames[m[1]].has(m[2])) err(`res/${rel}: @${m[1]}/${m[2]} is not defined`);
    }
  }
  for (const u of units) {
    for (const m of u.code.matchAll(/\bR\.(layout|id|drawable|string|xml|color|style|mipmap|raw)\.(\w+)/g)) {
      if (!resNames[m[1]].has(m[2])) err(`${u.rel}: R.${m[1]}.${m[2]} is not defined in the overlay or the base resources`);
    }
  }
  // RemoteViews layouts (used by widgets) may only contain views a launcher can inflate
  for (const [name, l] of layouts) {
    if (!name.startsWith('qw_widget_')) continue;
    for (const m of l.text.matchAll(/<([A-Za-z][\w.]*)[\s>/]/g)) {
      if (!REMOTEVIEWS_TAGS.has(m[1])) err(`res/${l.rel}: <${m[1]}> cannot be used in a widget (RemoteViews supports only ${[...REMOTEVIEWS_TAGS].slice(0, 6).join(', ')}, ...)`);
    }
    if (!l.ids.has('qw_root')) err(`res/${l.rel}: the root view needs android:id="@+id/qw_root" (BaseWidgetProvider uses it)`);
  }
  // a widget may only touch view ids of its own layout
  for (const u of units.filter((x) => x.rel.startsWith('com/techverse/quranbangla/widgets/') && /BaseWidgetProvider\(\)/.test(x.code))) {
    const lm = /R\.layout\.(\w+)/.exec(u.code);
    if (!lm) { err(`${u.rel}: a widget must name its layout (R.layout.qw_widget_...)`); continue; }
    const layout = layouts.get(lm[1]);
    if (!layout) continue;
    if (!/override\s+val\s+layoutId/.test(u.code) || !/override\s+fun\s+build\s*\(/.test(u.code)) err(`${u.rel}: a widget must override layoutId and build()`);
    for (const m of u.code.matchAll(/\bR\.id\.(\w+)/g)) {
      if (!layout.ids.has(m[1])) err(`${u.rel}: R.id.${m[1]} is not in ${lm[1]}.xml - RemoteViews would fail at run time`);
    }
  }

  // ------------------------------------------------------------------------------------------ manifest fragment
  const fragmentFile = path.join(nativeDir, 'manifest', 'components.xml');
  if (!fs.existsSync(fragmentFile)) err('native/manifest/components.xml is missing');
  else {
    const fragment = rd(fragmentFile);
    const bad = checkXml(`<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application>${fragment}</application></manifest>`);
    if (bad) err(`native/manifest/components.xml: not well-formed XML: ${bad}`);
    const bases = new Map();
    for (const u of units) for (const m of u.code.matchAll(/\bclass\s+(\w+)[^{=]*?:\s*([\w.]+)\s*\(/g)) bases.set(`${u.pkg}.${m[1]}`, m[2]);
    for (const m of fragment.matchAll(/<(receiver|service|provider|activity)\b[^>]*android:name="([\w.]+)"/g)) {
      const fq = m[2];
      if (!symbols.has(fq)) { err(`manifest fragment: ${m[1]} ${fq} has no Kotlin class`); continue; }
      const base = bases.get(fq) || '';
      const want = { receiver: ['BroadcastReceiver', 'BaseWidgetProvider', 'AppWidgetProvider'], service: ['Service'], provider: ['ContentProvider'], activity: ['Activity'] }[m[1]];
      if (!want.includes(base)) err(`manifest fragment: ${fq} extends ${base || 'nothing'}, a <${m[1]}> must extend ${want.join(' or ')}`);
      if (!/android:exported="(true|false)"/.test(m[0] + fragment.slice(fragment.indexOf(m[0]), fragment.indexOf('>', fragment.indexOf(m[0]))))) err(`manifest fragment: ${fq} must declare android:exported (required since Android 12)`);
    }
    for (const m of fragment.matchAll(/@(layout|xml|drawable|string|color|style|mipmap)\/(\w+)/g)) {
      if (!resNames[m[1]].has(m[2])) err(`manifest fragment: @${m[1]}/${m[2]} is not defined`);
    }
    for (const m of fragment.matchAll(/android:resource="@xml\/(\w+)"/g)) {
      const meta = path.join(resDir, 'xml', m[1] + '.xml');
      if (fs.existsSync(meta)) {
        const lay = /android:initialLayout="@layout\/(\w+)"/.exec(rd(meta));
        if (!lay || !layouts.has(lay[1])) err(`res/xml/${m[1]}.xml: initialLayout does not point at an overlay layout`);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ Capacitor plugin
  for (const u of units) {
    if (!/@CapacitorPlugin\(/.test(u.code)) continue;
    if (!/:\s*Plugin\(\)/.test(u.code)) err(`${u.rel}: a @CapacitorPlugin class must extend Plugin()`);
    for (const m of u.src.matchAll(/@PluginMethod[^\n]*\n\s*(?:\/\*\*[\s\S]*?\*\/\s*)?fun\s+(\w+)\s*\(([^)]*)\)/g)) {
      if (!/^call\s*:\s*PluginCall$/.test(m[2].trim())) err(`${u.rel}: @PluginMethod ${m[1]}(${m[2]}) must take exactly (call: PluginCall)`);
    }
    const annotated = (u.src.match(/@PluginMethod/g) || []).length;
    const funs = [...u.src.matchAll(/@PluginMethod[^\n]*\n(?:\s*\/\*\*[\s\S]*?\*\/\s*)?\s*fun\s+(\w+)/g)].length;
    if (annotated !== funs) err(`${u.rel}: ${annotated} @PluginMethod annotation(s) but ${funs} are directly followed by a fun`);
    if (!/@CapacitorPlugin\(\s*name\s*=\s*"QuranNative"/.test(u.src)) err(`${u.rel}: the plugin must be named QuranNative (the web side calls it by that name)`);
  }
  const mainKt = units.find((u) => u.rel === 'MainActivity.kt');
  if (!mainKt) err('MainActivity.kt is missing');
  else if (!/registerPlugin\(QuranNativePlugin::class\.java\)\s*\n\s*super\.onCreate/.test(mainKt.code)) err('MainActivity.kt must call registerPlugin(QuranNativePlugin::class.java) BEFORE super.onCreate');

  // ------------------------------------------------------------------------------------------ Room
  const entityFile = units.find((u) => u.rel.endsWith('db/Entities.kt'));
  const daoFile = units.find((u) => u.rel.endsWith('db/Daos.kt'));
  const dbFile = units.find((u) => u.rel.endsWith('db/AppDatabase.kt'));
  const tables = new Map(); // table -> { cls, cols:Set }
  if (entityFile) {
    const s = entityFile.code;
    for (const m of s.matchAll(/@Entity\s*\(/g)) {
      const a = matchParen(s, m.index + m[0].length - 1);
      if (!a) { err('Entities.kt: unbalanced @Entity('); continue; }
      const dc = /^\s*data\s+class\s+(\w+)\s*\(/.exec(s.slice(a.end + 1));
      if (!dc) { err('Entities.kt: @Entity must be followed by a data class'); continue; }
      const ctorOpen = a.end + 1 + dc[0].length - 1;
      const ctor = matchParen(s, ctorOpen);
      const tn = /tableName\s*=\s*""/.test(a.inner) ? null : null; // string contents are blanked by stripKotlin; read the original below
      void tn;
      const origS = entityFile.src;
      const origIdx = origS.indexOf(`class ${dc[1]}`);
      const origHead = origS.slice(Math.max(0, origIdx - 400), origIdx);
      const tm = /tableName\s*=\s*"(\w+)"/.exec(origHead.slice(origHead.lastIndexOf('@Entity')));
      if (!tm) { err(`Entities.kt: ${dc[1]} has no tableName`); continue; }
      const cols = new Set();
      let hasPk = false;
      for (const p of splitTop(ctor.inner)) {
        const pm = /(?:@\w+(?:\([^)]*\))?\s+)*val\s+(\w+)\s*:/.exec(p);
        if (!pm) { err(`Entities.kt: ${dc[1]}: parameter "${p.slice(0, 40)}" is not a val`); continue; }
        cols.add(pm[1]);
        if (/@PrimaryKey/.test(p)) hasPk = true;
      }
      if (!hasPk) err(`Entities.kt: ${dc[1]} has no @PrimaryKey`);
      if (tables.has(tm[1])) err(`Entities.kt: table ${tm[1]} is declared twice`);
      tables.set(tm[1], { cls: dc[1], cols });
      for (const im of origHead.slice(origHead.lastIndexOf('@Entity')).matchAll(/Index\(\s*(?:value\s*=\s*\[([^\]]*)\]|"(\w+)")/g)) {
        const list = im[1] ? [...im[1].matchAll(/"(\w+)"/g)].map((x) => x[1]) : [im[2]];
        for (const c of list) if (!cols.has(c)) err(`Entities.kt: ${dc[1]}: index on unknown column ${c}`);
      }
    }
  } else err('db/Entities.kt is missing');
  if (daoFile) {
    const s = daoFile.src;
    const strip = daoFile.code;
    void strip;
    for (const m of s.matchAll(/@Query\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*\n\s*fun\s+(\w+)\s*\(([^)]*)\)/g)) {
      const sql = m[1];
      const params = new Set([...m[3].matchAll(/(\w+)\s*:/g)].map((x) => x[1]));
      const used = new Set();
      for (const t of sql.matchAll(/\b(?:from|update|into|join)\s+(\w+)/gi)) used.add(t[1]);
      for (const t of used) if (!tables.has(t)) err(`Daos.kt: ${m[2]}: query uses unknown table ${t}`);
      const cols = new Set();
      for (const t of used) if (tables.has(t)) for (const c of tables.get(t).cols) cols.add(c);
      for (const p of sql.matchAll(/:(\w+)/g)) if (!params.has(p[1])) err(`Daos.kt: ${m[2]}: :${p[1]} is not a parameter of the function`);
      const noParams = sql.replace(/:\w+/g, ' ').replace(/'[^']*'/g, ' ').replace(/`/g, '');
      for (const t of noParams.matchAll(/[A-Za-z_]\w*/g)) {
        const w = t[0];
        if (SQL_WORDS.has(w.toLowerCase()) || used.has(w) || cols.has(w)) continue;
        err(`Daos.kt: ${m[2]}: "${w}" in the query is neither an SQL word, a table nor a column of ${[...used].join(', ')}`);
      }
    }
    const daos = [...s.matchAll(/@Dao\s*\n\s*interface\s+(\w+)/g)].map((x) => x[1]);
    if (dbFile) {
      const d = dbFile.code;
      for (const dao of daos) if (!new RegExp(`abstract\\s+fun\\s+\\w+\\(\\)\\s*:\\s*${dao}\\b`).test(d)) err(`AppDatabase.kt: no accessor for ${dao}`);
      const listed = [...(/entities\s*=\s*\[([^\]]*)\]/.exec(d) || ['', ''])[1].matchAll(/(\w+)::class/g)].map((x) => x[1]);
      const declared = [...tables.values()].map((t) => t.cls);
      for (const c of declared) if (!listed.includes(c)) err(`AppDatabase.kt: entity ${c} is not listed in @Database(entities = ...)`);
      for (const c of listed) if (!declared.includes(c)) err(`AppDatabase.kt: @Database lists ${c}, which is not an @Entity`);
      if (!/version\s*=\s*\d+/.test(d)) err('AppDatabase.kt: @Database needs version = <number>');
      if (!/exportSchema\s*=\s*true/.test(d)) warn('AppDatabase.kt: exportSchema should be true (migrations are checked against the exported schemas)');
    } else err('db/AppDatabase.kt is missing');
  } else err('db/Daos.kt is missing');

  // ------------------------------------------------------------------------------------------ generated data
  try {
    const committed = path.join(kotlinDir, 'com', 'techverse', 'quranbangla', 'core', 'SurahData.kt');
    if (!fs.existsSync(committed) || rd(committed) !== generateSurahData(path.resolve(buildDir, '..'))) err('core/SurahData.kt is out of date - run: node android-build/native/generate-data.mjs');
  } catch (e) { err('core/SurahData.kt could not be checked: ' + e.message); }

  return { errors, warnings, info };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = lintNative();
  for (const w of r.warnings) console.log('WARNING:', w);
  for (const e of r.errors) console.log('ERROR:', e);
  console.log(`native-lint: ${r.info.kotlinFiles} Kotlin file(s), ${r.info.classes} classes/objects, ${r.info.resFiles} resource file(s) - ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
  process.exit(r.errors.length ? 1 : 0);
}
