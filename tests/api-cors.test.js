'use strict';
// api/_cors.js - the standalone Android app (origin https://localhost) calls the hosted backend across origins.
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCors, allowedOrigins, APP_ORIGINS } = require('../api/_cors.js');

function fakeRes() {
  const r = { headers: {}, code: 0, ended: false, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = String(v); };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
const req = (method, origin, extra = {}) => ({ method, headers: origin ? { origin } : {}, ...extra });

test('the app origins are allowed: https://localhost, http://localhost, capacitor://localhost', () => {
  for (const origin of APP_ORIGINS) {
    const res = fakeRes();
    assert.equal(applyCors(req('POST', origin), res), false, 'a normal request continues');
    assert.equal(res.headers['access-control-allow-origin'], origin, 'the origin is echoed, never "*"');
    assert.equal(res.headers['access-control-allow-headers'], 'Content-Type, Authorization');
    assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS');
    assert.equal(res.headers['vary'], 'Origin');
    assert.equal(res.headers['access-control-allow-credentials'], undefined, 'no cookies are involved');
  }
});

test('a preflight from the app is answered with 204 and Allow, and the handler stops', () => {
  const res = fakeRes();
  assert.equal(applyCors(req('OPTIONS', 'https://localhost'), res), true);
  assert.equal(res.code, 204); assert.equal(res.ended, true);
  assert.equal(res.headers['allow'], 'POST, OPTIONS');
  assert.equal(res.headers['access-control-allow-origin'], 'https://localhost');
  assert.equal(res.headers['access-control-max-age'], '86400');
});

test('any other origin gets no CORS permission (the browser blocks the call), preflight included', () => {
  for (const origin of ['https://evil.example', 'https://localhost.evil.example', 'http://localhost:3000', 'null', 'https://quranbangla.vercel.app.evil.example']) {
    const res = fakeRes();
    assert.equal(applyCors(req('POST', origin), res), false);
    assert.equal(res.headers['access-control-allow-origin'], undefined, origin);
    assert.equal(res.headers['vary'], 'Origin');
    const pre = fakeRes();
    assert.equal(applyCors(req('OPTIONS', origin), pre), true);
    assert.equal(pre.code, 204); assert.equal(pre.headers['access-control-allow-origin'], undefined, origin + ' preflight');
  }
});

test('no Origin header (the website itself, curl, server to server): nothing is added, the request continues', () => {
  const res = fakeRes();
  assert.equal(applyCors(req('POST'), res), false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(applyCors({ method: 'POST' }, fakeRes()), false, 'a request without headers does not crash');
});

test('CORS_ALLOWED_ORIGINS adds exact origins only: no wildcards, no paths, no junk', () => {
  const env = { CORS_ALLOWED_ORIGINS: ' https://staging.example , https://*.example, https://x.example/path, ftp://x.example, , capacitor://other ' };
  const set = allowedOrigins(env);
  assert.ok(set.has('https://staging.example') && set.has('capacitor://other'));
  assert.ok(!set.has('https://*.example') && !set.has('https://x.example/path') && !set.has('ftp://x.example'));
  const res = fakeRes();
  applyCors(req('POST', 'https://staging.example'), res, { env });
  assert.equal(res.headers['access-control-allow-origin'], 'https://staging.example');
  assert.ok([...allowedOrigins({})].every((o) => o !== '*'));
});

test('the endpoints answer the preflight of the app and never run their logic for it', async (t) => {
  for (const file of ['story-submit.js', 'story-admin.js', 'ai-tafsir.js']) {
    let handler;
    try { handler = require('../api/' + file); } catch (e) { if (e.code === 'MODULE_NOT_FOUND') { t.diagnostic(`${file}: dependency not installed here, skipped`); continue; } throw e; }
    const res = fakeRes();
    await handler(req('OPTIONS', 'https://localhost'), res);
    assert.equal(res.code, 204, file); assert.equal(res.headers['access-control-allow-origin'], 'https://localhost', file);
    assert.equal(res.headers['allow'], 'POST, OPTIONS', file);
  }
});

test('error answers carry the CORS headers too (so the app can read the error instead of a network failure)', async () => {
  const handler = require('../api/story-submit.js');
  const res = fakeRes();
  await handler(req('GET', 'https://localhost'), res);
  assert.equal(res.code, 405);
  assert.equal(res.headers['access-control-allow-origin'], 'https://localhost');
});
