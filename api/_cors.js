'use strict';
// ---------------------------------------------------------------------------------------------------------------------
// CORS for the standalone Android app.
//
// The app no longer shows the website: it runs from its own bundle at https://localhost (Capacitor) and calls this backend
// (AI Tafsir, story submit / moderation) across origins. Browsers only allow that when the server says so.
//
//   * Only the app's own origins are allowed (never "*"): https://localhost, http://localhost, capacitor://localhost.
//     More can be added with the environment variable CORS_ALLOWED_ORIGINS (comma separated, exact origins).
//   * No cookies are involved - callers authenticate with a Firebase ID token - so credentials are not allowed.
//   * Same-origin calls from the website have no Origin header handling change at all.
//
// applyCors(req, res, { methods }) -> true when the request was a preflight (OPTIONS) and has been answered: stop there.
// The file name starts with "_" so Vercel does not expose it as an endpoint.
// ---------------------------------------------------------------------------------------------------------------------
const APP_ORIGINS = ['https://localhost', 'http://localhost', 'capacitor://localhost'];

function allowedOrigins(env = process.env) {
  const extra = String(env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^(?:https?|capacitor):\/\/[^\s/*]+$/i.test(s)); // exact origins only: no wildcards, no paths
  return new Set([...APP_ORIGINS, ...extra]);
}

function applyCors(req, res, { methods = 'POST, OPTIONS', env = process.env } = {}) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  res.setHeader('Vary', 'Origin'); // the answer depends on the caller's origin
  if (origin && allowedOrigins(env).has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req && req.method === 'OPTIONS') {
    res.setHeader('Allow', methods);
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { applyCors, allowedOrigins, APP_ORIGINS };
