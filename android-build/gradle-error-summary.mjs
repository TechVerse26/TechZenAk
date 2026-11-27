#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/gradle-error-summary.mjs <gradle-or-create-project.log> [--annotations]
//
// Reads the log of a failed Android build and prints what a person needs to see - instead of the last 60 lines of a
// Gradle stack trace, in which the real cause is never visible:
//   default        Markdown for $GITHUB_STEP_SUMMARY: failed task, "What went wrong", the first compiler / resource / manifest
//                  errors, and a plain-language hint when the error is a known one
//   --annotations  GitHub workflow commands (::error::) so the first errors also appear at the top of the run page
//
// Only Node.js built-ins are used. It never fails: an unreadable log just produces a short note.
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_ERRORS = 12;

/** Known failures: [pattern, what it means, what to do]. The first matching entry is shown. */
export const HINTS = [
  [/Provided Metadata instance has version [\d.]+, while maximum supported version is [\d.]+/i,
    'Room is too old for this Kotlin version (Room 2.6.x cannot read the metadata of Kotlin 2.1 or newer).',
    'Raise "gradle.room" in android-build/native/modules.json to 2.7.0 or newer (2.8.4 is the tested value).'],
  [/Module was compiled with an incompatible version of Kotlin|incompatible version of Kotlin\. The binary version of its metadata is/i,
    'A library was built with a newer Kotlin than the Kotlin compiler of this project.',
    'Raise "gradle.kotlin" in android-build/native/modules.json (Capacitor 8 itself recommends 2.2.20).'],
  [/Manifest merger failed/i,
    'Two AndroidManifest.xml files (the app and a library) disagree.',
    'Read the line after "Manifest merger failed" - it names the element and the library; add tools:replace / tools:node there.'],
  [/AAPT: error|aapt2.*error|resource .* not found|Android resource linking failed/i,
    'An Android resource (layout, drawable, string, colour) is wrong or missing.',
    'The error line names the file; check android-build/res and android-build/native/res.'],
  [/Duplicate class /i,
    'The same class is in two libraries (usually two Kotlin standard library versions).',
    'The line after "Duplicate class" names both libraries; align their versions.'],
  [/Unresolved reference|Type mismatch|None of the following candidates|Cannot access|Overload resolution ambiguity/i,
    'A Kotlin file does not compile.',
    'The "e: file:///..." lines below name the file and line.'],
  [/Could not resolve|Could not GET|Could not HEAD|Connection (timed out|reset)|Read timed out/i,
    'A dependency could not be downloaded (a network or repository problem, or a version that does not exist).',
    'Run the workflow again; if it repeats, check the version named in the error.'],
  [/OutOfMemoryError|Java heap space|GC overhead limit|Metaspace/i,
    'Gradle or the Kotlin compiler ran out of memory.',
    'Raise -Xmx in org.gradle.jvmargs (android-build/create-project.sh and apply-native-patches.mjs).'],
  [/kapt|annotation processor|Room/i,
    'The annotation processing step (Room, through kapt) failed.',
    'See the first error below. Room and Kotlin versions are in android-build/native/modules.json.'],
  [/Inconsistent JVM-target compatibility/i,
    'Java and Kotlin are compiled for different JVM levels.',
    'The jvmTarget block that apply-native-patches.mjs adds must match the Java level of capacitor.build.gradle.'],
  [/SDK location not found|ANDROID_HOME|Failed to find Build Tools|platform;android-/i,
    'The Android SDK is missing or incomplete on the runner.',
    'Run the workflow again; GitHub-hosted runners normally ship the SDK.']
];

export function analyse(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = { failedTasks: [], whatWentWrong: [], errors: [], causedBy: [], hint: null };
  const seen = new Set();
  const add = (line) => {
    const t = line.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    if (out.errors.length < MAX_ERRORS) out.errors.push(t);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^> Task (\S+) FAILED/.exec(l))) { if (!out.failedTasks.includes(m[1])) out.failedTasks.push(m[1]); continue; }
    if (/^\* What went wrong:/.test(l)) {
      const block = [];
      for (let j = i + 1; j < lines.length && block.length < 12; j++) {
        if (/^\* Try:/.test(lines[j]) || /^\* Exception is:/.test(lines[j])) break;
        if (lines[j].trim()) block.push(lines[j].trim());
      }
      if (!out.whatWentWrong.length) out.whatWentWrong = block;
      continue;
    }
    if (/^e: /.test(l) || /\berror: /.test(l) || /^ERROR: /.test(l) || /^AAPT: error/.test(l) || /Manifest merger failed/.test(l) || /^error:/.test(l)) { add(l); continue; }
    if (/^Caused by: /.test(l) && out.causedBy.length < 4) out.causedBy.push(l.trim());
  }

  const haystack = [out.whatWentWrong.join('\n'), out.errors.join('\n'), out.causedBy.join('\n'), String(text || '').slice(-60000)].join('\n');
  for (const [re, meaning, fix] of HINTS) {
    if (re.test(haystack)) { out.hint = { meaning, fix }; break; }
  }
  return out;
}

const fence = '```';

export function markdown(text, { logName = 'the log', found = true } = {}) {
  if (!found) {
    return ['### The full build failed', '', `No log was found (${logName}). The failure happened before Gradle started - open the red step "Create the Android project" above.`, ''].join('\n');
  }
  const a = analyse(text);
  const md = ['### Why the full build failed', ''];
  if (a.hint) md.push(`**Probable cause:** ${a.hint.meaning}`, '', `**What to do:** ${a.hint.fix}`, '');
  if (a.failedTasks.length) md.push(`**Failed task:** \`${a.failedTasks.join('`, `')}\``, '');
  if (a.whatWentWrong.length) md.push('**What went wrong (Gradle):**', '', fence, ...a.whatWentWrong, fence, '');
  if (a.errors.length) md.push(`**First error lines (${a.errors.length}):**`, '', fence, ...a.errors, fence, '');
  if (a.causedBy.length) md.push('**Caused by:**', '', fence, ...a.causedBy, fence, '');
  if (!a.hint && !a.failedTasks.length && !a.whatWentWrong.length && !a.errors.length) {
    md.push('No error line could be recognised. The last lines of the log:', '', fence, ...String(text || '').split(/\r?\n/).filter(Boolean).slice(-40), fence, '');
  }
  md.push('The complete log is in the artifact `build-reports` (file `gradle-debug-full.log`).', '');
  return md.join('\n');
}

export function annotations(text) {
  const a = analyse(text);
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const out = [];
  if (a.hint) out.push(`::error title=Full build failed - probable cause::${esc(a.hint.meaning + ' ' + a.hint.fix)}`);
  for (const e of a.errors.slice(0, 5)) out.push(`::error title=Gradle::${esc(e.slice(0, 400))}`);
  if (!out.length && a.whatWentWrong.length) out.push(`::error title=Gradle::${esc(a.whatWentWrong.join(' ').slice(0, 400))}`);
  return out.join('\n');
}

function main(argv) {
  const file = argv.find((x) => !x.startsWith('--')) || '';
  const wantAnnotations = argv.includes('--annotations');
  let text = '';
  let found = false;
  try { if (file) { text = fs.readFileSync(file, 'utf8'); found = true; } } catch (e) { found = false; }
  const result = wantAnnotations ? annotations(text) : markdown(text, { logName: file || 'no file given', found });
  if (result) process.stdout.write(result + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
