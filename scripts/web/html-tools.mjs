// Tiny dependency-free helpers to find and rewrite <script> / <link> tags in an HTML page.
// Inline <script> / <style> bodies are masked first, so text inside them is never mistaken for a tag.

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

export function maskInline(html) {
  return html.replace(/<(script|style)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>/gi,
    (_m, name, attrs, body) => `<${name}${attrs}>${' '.repeat(body.length)}</${name}>`);
}

export function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function parseAttrs(inner) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(inner))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// [{ name:'script'|'link', start, end, text, attrs }] for every opening tag outside inline script/style bodies
export function findTags(html) {
  const masked = maskInline(html);
  const re = /<(script|link)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  const out = [];
  let m;
  while ((m = re.exec(masked))) {
    out.push({ name: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length, text: html.slice(m.index, m.index + m[0].length), attrs: parseAttrs(m[2]) });
  }
  return out;
}

export const isExternal = (u) => /^(?:https?:)?\/\//i.test(String(u || '').trim());
export const relTokens = (attrs) => String(attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);

export function removeAttr(tagText, name) {
  return tagText.replace(new RegExp(`\\s+${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?(?=[\\s>/])`, 'i'), '');
}

export function setAttr(tagText, name, value) {
  const esc = String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i');
  if (re.test(tagText)) return tagText.replace(re, (_m, pre) => `${pre}"${esc}"`);
  return tagText.replace(/\/?>$/, (end) => ` ${name}="${esc}"${end}`);
}

// edits: [{ start, end, text }] against the ORIGINAL html; applied back to front
export function applyEdits(html, edits) {
  let out = html;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

// Inserts `text` right after the first tag that matches `re` (a RegExp against the original html). Returns { html, ok }.
export function insertAfter(html, re, text) {
  const m = re.exec(html);
  if (!m) return { html, ok: false };
  const at = m.index + m[0].length;
  return { html: html.slice(0, at) + text + html.slice(at), ok: true };
}
