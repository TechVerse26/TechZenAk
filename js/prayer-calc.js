// ---------- Offline prayer times (standalone Android app) ----------
//
// The website asks https://api.aladhan.com for prayer times. A standalone app must still show times with no network, so this
// file calculates them on the device with the standard astronomical method (sun position -> hour angles for the Fajr / Isha
// twilight angles, sunrise / sunset, Asr shadow length). It is used as the FALLBACK of js/standalone-net.js: when Al-Adhan can
// be reached its answer is used as before; only when it cannot (no network, no earlier answer) these times are shown.
//
// Honest limits - read before changing anything
//   * It implements only the calculation methods the app offers (ids 1 Karachi, 2 ISNA, 3 MWL, 4 Umm al-Qura, 5 Egypt, 8 Gulf,
//     13 Diyanet, 20 Kemenag). For any other method it refuses (returns null) instead of guessing.
//   * The solar model is the simple one of the well-known PrayTimes library (accuracy about +-1 minute). tests/prayer-calc.test.js
//     compares it with an independent, more exact model (Meeus) and fails if they ever differ by more than 1.5 minutes.
//   * Times are given as local clock times for a timezone offset you pass in. Al-Adhan's Asr is the Shafi'i/standard one
//     (school 0) unless school=1 (Hanafi) is asked - the same default as the website.
//   * It is a calculation aid, not a fatwa: local mosques may publish slightly different times (the app already says
//     which method is used).
//
// computeTimes({ year, month (1-12), day, latitude, longitude, timezone (hours east of UTC), method, school, elevation, ramadan })
//   -> { fajr, sunrise, dhuhr, asr, sunset, maghrib, isha, imsak, midnight, firstthird, lastthird } in hours (NaN when the sun
//      never reaches the angle, e.g. polar summer), or null for an unsupported method.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QR_PRAYER_CALC = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // fajr / isha are sun angles below the horizon (degrees); ishaMinutes = minutes after Maghrib instead of an angle
  var METHODS = {
    1: { name: 'University of Islamic Sciences, Karachi', fajr: 18, isha: 18 },
    2: { name: 'Islamic Society of North America (ISNA)', fajr: 15, isha: 15 },
    3: { name: 'Muslim World League', fajr: 18, isha: 17 },
    4: { name: 'Umm Al-Qura University, Makkah', fajr: 18.5, ishaMinutes: 90, ishaMinutesRamadan: 120 },
    5: { name: 'Egyptian General Authority of Survey', fajr: 19.5, isha: 17.5 },
    8: { name: 'Gulf Region', fajr: 19.5, ishaMinutes: 90 },
    13: { name: 'Diyanet \u0130\u015fleri Ba\u015fkanl\u0131\u011f\u0131, Turkey', fajr: 18, isha: 17 },
    20: { name: 'Kementerian Agama Republik Indonesia', fajr: 20, isha: 18 }
  };

  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var dsin = function (d) { return Math.sin(d * D2R); };
  var dcos = function (d) { return Math.cos(d * D2R); };
  var dtan = function (d) { return Math.tan(d * D2R); };
  var darcsin = function (x) { return Math.asin(x) * R2D; };
  var darccos = function (x) { return Math.acos(x) * R2D; };
  var darctan2 = function (y, x) { return Math.atan2(y, x) * R2D; };
  var darccot = function (x) { return Math.atan(1 / x) * R2D; };
  var fix = function (a, m) { return a - m * Math.floor(a / m); };
  var fixAngle = function (a) { return fix(a, 360); };
  var fixHour = function (a) { return fix(a, 24); };

  function julian(year, month, day) {
    if (month <= 2) { year -= 1; month += 12; }
    var A = Math.floor(year / 100);
    var B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
  }

  // declination (degrees) and equation of time (hours) of the sun at a Julian date
  function sunPosition(jd) {
    var D = jd - 2451545.0;
    var g = fixAngle(357.529 + 0.98560028 * D);
    var q = fixAngle(280.459 + 0.98564736 * D);
    var L = fixAngle(q + 1.915 * dsin(g) + 0.020 * dsin(2 * g));
    var e = 23.439 - 0.00000036 * D;
    var RA = darctan2(dcos(e) * dsin(L), dcos(L)) / 15;
    return { declination: darcsin(dsin(e) * dsin(L)), equation: q / 15 - fixHour(RA) };
  }

  function validate(o) {
    var ok = function (v, lo, hi) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi; };
    return ok(o.latitude, -90, 90) && ok(o.longitude, -180, 180) && ok(o.timezone, -14, 14) &&
      Math.floor(o.year) === o.year && Math.floor(o.month) === o.month && Math.floor(o.day) === o.day &&
      o.month >= 1 && o.month <= 12 && o.day >= 1 && o.day <= 31 && o.year >= 1900 && o.year <= 2200;
  }

  function computeTimes(o) {
    var m = METHODS[o.method];
    if (!m || !validate(o)) return null;
    var lat = o.latitude, lng = o.longitude, tz = o.timezone;
    var jDate = julian(o.year, o.month, o.day) - lng / (15 * 24);
    var asrFactor = o.school === 1 ? 2 : 1;                       // 1 = Shafi'i / standard, 2 = Hanafi
    var riseSetAngle = 0.0347 * Math.sqrt(Math.max(0, o.elevation || 0)) + 0.833;

    var midDay = function (t) { return fixHour(12 - sunPosition(jDate + t).equation); };
    var sunAngleTime = function (angle, t, ccw) {
      var decl = sunPosition(jDate + t).declination;
      var h = 1 / 15 * darccos((-dsin(angle) - dsin(decl) * dsin(lat)) / (dcos(decl) * dcos(lat)));
      return midDay(t) + (ccw ? -h : h);
    };
    var asrTime = function (factor, t) {
      var decl = sunPosition(jDate + t).declination;
      return sunAngleTime(-darccot(factor + dtan(Math.abs(lat - decl))), t, false);
    };

    // one pass from the usual first guesses (this is what the PrayTimes library does with its default of 1 iteration)
    var t = { fajr: 5 / 24, sunrise: 6 / 24, dhuhr: 12 / 24, asr: 13 / 24, sunset: 18 / 24, maghrib: 18 / 24, isha: 18 / 24 };
    var r = {
      fajr: sunAngleTime(m.fajr, t.fajr, true),
      sunrise: sunAngleTime(riseSetAngle, t.sunrise, true),
      dhuhr: midDay(t.dhuhr),
      asr: asrTime(asrFactor, t.asr),
      sunset: sunAngleTime(riseSetAngle, t.sunset, false),
      isha: m.ishaMinutes ? 0 : sunAngleTime(m.isha, t.isha, false)
    };

    // local clock time; Maghrib is the sunset for every method the app offers
    r.maghrib = r.sunset;
    Object.keys(r).forEach(function (k) { r[k] += tz - lng / 15; });

    // high latitudes: when the twilight never ends or never starts, limit Fajr / Isha by a share of the night (angle based)
    var night = fixHour(r.sunrise - r.sunset);
    var portion = function (angle) { return angle / 60 * night; };
    var limited = function (time, base, angle, ccw) {
      var p = portion(angle);
      var diff = ccw ? fixHour(base - time) : fixHour(time - base);
      return (isNaN(time) || diff > p) ? base + (ccw ? -p : p) : time;
    };
    if (isFinite(night)) {
      r.fajr = limited(r.fajr, r.sunrise, m.fajr, true);
      if (!m.ishaMinutes) r.isha = limited(r.isha, r.sunset, m.isha, false);
    }
    if (m.ishaMinutes) r.isha = r.maghrib + (o.ramadan && m.ishaMinutesRamadan ? m.ishaMinutesRamadan : m.ishaMinutes) / 60;

    r.imsak = r.fajr - 10 / 60;
    var span = fixHour(r.sunrise - r.sunset);
    r.midnight = r.sunset + span / 2;
    r.firstthird = r.sunset + span / 3;
    r.lastthird = r.sunset + span * 2 / 3;
    return r;
  }

  // 'HH:MM' (24 h, rounded to the nearest minute like the PrayTimes library); '--:--' when there is no such time
  function format(time) {
    if (typeof time !== 'number' || isNaN(time)) return '--:--';
    time = fixHour(time + 0.5 / 60);
    var h = Math.floor(time), mi = Math.floor((time - h) * 60);
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }

  // ---- Hijri date (Umm al-Qura, the calendar Al-Adhan uses) from the platform's own Intl data - works offline ----
  var HIJRI_EN = ['Mu\u1e25arram', '\u1e62afar', 'Rab\u012b\u02bf al-awwal', 'Rab\u012b\u02bf al-th\u0101n\u012b', 'Jum\u0101d\u00e1 al-\u016bl\u00e1', 'Jum\u0101d\u00e1 al-\u0101khirah', 'Rajab', 'Sha\u02bfb\u0101n', 'Rama\u1e0d\u0101n', 'Shaww\u0101l', 'Dh\u016b al-Qa\u02bfdah', 'Dh\u016b al-\u1e24ijjah'];
  var HIJRI_AR = ['\u0645\u064f\u062d\u064e\u0631\u0651\u064e\u0645', '\u0635\u064e\u0641\u064e\u0631', '\u0631\u064e\u0628\u0650\u064a\u0639 \u0671\u0644\u0623\u064e\u0648\u0651\u064e\u0644', '\u0631\u064e\u0628\u0650\u064a\u0639 \u0671\u0644\u062b\u0651\u064e\u0627\u0646\u0650\u064a', '\u062c\u064f\u0645\u064e\u0627\u062f\u064e\u0649\u0670 \u0671\u0644\u0623\u064f\u0648\u0644\u064e\u0649\u0670', '\u062c\u064f\u0645\u064e\u0627\u062f\u064e\u0649\u0670 \u0671\u0644\u062b\u0651\u064e\u0627\u0646\u0650\u064a\u064e\u0629', '\u0631\u064e\u062c\u064e\u0628', '\u0634\u064e\u0639\u0652\u0628\u064e\u0627\u0646', '\u0631\u064e\u0645\u064e\u0636\u064e\u0627\u0646', '\u0634\u064e\u0648\u0651\u064e\u0627\u0644', '\u0630\u064f\u0648 \u0671\u0644\u0642\u064e\u0639\u0652\u062f\u064e\u0629', '\u0630\u064f\u0648 \u0671\u0644\u062d\u0650\u062c\u0651\u064e\u0629'];

  // -> { day, month (1-12), year } or null when the platform has no Islamic calendar
  function hijriOf(year, month, day) {
    try {
      var fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
      var out = {};
      fmt.formatToParts(new Date(Date.UTC(year, month - 1, day, 12))).forEach(function (p) { if (p.type === 'day' || p.type === 'month' || p.type === 'year') out[p.type] = parseInt(p.value, 10); });
      return out.day && out.month && out.year ? out : null;
    } catch (e) { return null; }
  }

  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function dateBlock(year, month, day) {
    var jsDate = new Date(Date.UTC(year, month - 1, day));
    var h = hijriOf(year, month, day);
    var out = {
      readable: pad2(day) + ' ' + MONTHS[month - 1].slice(0, 3) + ' ' + year,
      timestamp: String(Math.floor(jsDate.getTime() / 1000)),
      gregorian: {
        date: pad2(day) + '-' + pad2(month) + '-' + year, format: 'DD-MM-YYYY', day: pad2(day),
        weekday: { en: WEEKDAYS[jsDate.getUTCDay()] }, month: { number: month, en: MONTHS[month - 1] }, year: String(year),
        designation: { abbreviated: 'AD', expanded: 'Anno Domini' }
      }
    };
    if (h) {
      out.hijri = {
        date: pad2(h.day) + '-' + pad2(h.month) + '-' + h.year, format: 'DD-MM-YYYY', day: String(h.day),
        month: { number: h.month, en: HIJRI_EN[h.month - 1], ar: HIJRI_AR[h.month - 1] }, year: String(h.year),
        designation: { abbreviated: 'AH', expanded: 'Anno Hegirae' }, holidays: []
      };
    }
    return out;
  }

  // Al-Adhan shaped answer for GET /timings?latitude=&longitude=&method=[&school=] - or null (unsupported method / bad input)
  function toAladhanResponse(o) {
    // Ramadan (Hijri month 9) is detected from the date unless the caller says otherwise; the SAME decision is used for the
    // times and for the description of the method below
    var ramadan = o.ramadan == null ? (hijriOf(o.year, o.month, o.day) || {}).month === 9 : !!o.ramadan;
    var t = computeTimes(Object.assign({}, o, { ramadan: ramadan }));
    if (!t) return null;
    var m = METHODS[o.method];
    var timings = { Fajr: format(t.fajr), Sunrise: format(t.sunrise), Dhuhr: format(t.dhuhr), Asr: format(t.asr), Sunset: format(t.sunset), Maghrib: format(t.maghrib), Isha: format(t.isha), Imsak: format(t.imsak), Midnight: format(t.midnight), Firstthird: format(t.firstthird), Lastthird: format(t.lastthird) };
    var params = {};
    if (m.fajr != null) params.Fajr = m.fajr;
    params.Isha = m.ishaMinutes ? (ramadan && m.ishaMinutesRamadan ? m.ishaMinutesRamadan : m.ishaMinutes) + ' min' : m.isha;
    return {
      code: 200, status: 'OK',
      data: {
        timings: timings,
        date: dateBlock(o.year, o.month, o.day),
        meta: {
          latitude: o.latitude, longitude: o.longitude, timezone: o.timezoneName || ('UTC' + (o.timezone >= 0 ? '+' : '') + o.timezone),
          method: { id: o.method, name: m.name, params: params }, school: o.school === 1 ? 'HANAFI' : 'STANDARD',
          latitudeAdjustmentMethod: 'ANGLE_BASED', source: 'calculated on this device (offline)', offline: true
        }
      }
    };
  }

  // Al-Adhan shaped answer for GET /gToH/DD-MM-YYYY, or null
  function hijriResponse(year, month, day) {
    if (!(Math.floor(year) === year && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
    var d = dateBlock(year, month, day);
    return d.hijri ? { code: 200, status: 'OK', data: { hijri: d.hijri, gregorian: d.gregorian } } : null;
  }

  return { METHODS: METHODS, computeTimes: computeTimes, format: format, hijriOf: hijriOf, toAladhanResponse: toAladhanResponse, hijriResponse: hijriResponse, julian: julian, sunPosition: sunPosition };
});
