'use strict';
// js/prayer-calc.js against an INDEPENDENT, more exact solar model (Meeus, "Astronomical Algorithms", ch. 25 + 28), not against
// itself. If the simple PrayTimes-style model or its use ever drifts by more than a minute and a half, these tests fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/prayer-calc.js');

// ---------- the oracle ----------
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
const fix360 = (a) => a - 360 * Math.floor(a / 360);
function meeusSun(jd) {
  const T = (jd - 2451545.0) / 36525;
  const L0 = fix360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = fix360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(rad(M)) + (0.019993 - 0.000101 * T) * Math.sin(rad(2 * M)) + 0.000289 * Math.sin(rad(3 * M));
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps = 23 + (26 + (21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps) / 2) ** 2, l0 = rad(L0), m = rad(M);
  const E = y * Math.sin(2 * l0) - 2 * e * Math.sin(m) + 4 * e * y * Math.sin(m) * Math.cos(2 * l0) - 0.5 * y * y * Math.sin(4 * l0) - 1.25 * e * e * Math.sin(2 * m);
  return { decl, eotMin: deg(E) * 4 };
}
function oracle(o) {
  const jd0 = P.julian(o.year, o.month, o.day);                       // 0h UT of the day
  const lat = o.latitude;
  const noonMin = (guess) => 720 - 4 * o.longitude - meeusSun(jd0 + guess / 1440).eotMin;
  const noon = noonMin(720);
  const at = (altDeg, afterNoon, altFn) => {                         // clock time (hours, local) at which the sun reaches an altitude
    let t = noon + (afterNoon ? 1 : -1) * 360;
    for (let i = 0; i < 4; i++) {
      const decl = meeusSun(jd0 + t / 1440).decl;
      const h = altFn ? altFn(decl) : altDeg;
      const c = (Math.sin(rad(h)) - Math.sin(rad(lat)) * Math.sin(rad(decl))) / (Math.cos(rad(lat)) * Math.cos(rad(decl)));
      if (c < -1 || c > 1) return NaN;
      t = noonMin(t) + (afterNoon ? 1 : -1) * 4 * deg(Math.acos(c));
    }
    return t / 60 + o.timezone;
  };
  const m = P.METHODS[o.method];
  const factor = o.school === 1 ? 2 : 1;
  const asrAlt = (decl) => deg(Math.atan(1 / (factor + Math.tan(rad(Math.abs(lat - decl))))));
  const sunset = at(-0.833, true);
  return {
    fajr: at(-m.fajr, false), sunrise: at(-0.833, false), dhuhr: noonMin(noon) / 60 + o.timezone, asr: at(0, true, asrAlt), sunset,
    isha: m.ishaMinutes ? sunset + m.ishaMinutes / 60 : at(-m.isha, true)
  };
}
const diffMin = (a, b) => { let d = (a - b) * 60; d -= 1440 * Math.round(d / 1440); return Math.abs(d); };

const PLACES = [
  ['Dhaka', 23.8103, 90.4125, [6, 6, 6, 6, 6, 6]], ['Makkah', 21.4225, 39.8262, [3, 3, 3, 3, 3, 3]], ['Jakarta', -6.2088, 106.8456, [7, 7, 7, 7, 7, 7]],
  ['Cairo', 30.0444, 31.2357, [2, 2, 3, 3, 2, 2]], ['Istanbul', 41.0082, 28.9784, [3, 3, 3, 3, 3, 3]], ['London', 51.5074, -0.1278, [0, 0, 1, 0, 0, 0]],
  ['New York', 40.7128, -74.006, [-5, -5, -4, -4, -4, -5]], ['Sydney', -33.8688, 151.2093, [11, 11, 10, 10, 11, 11]], ['Nairobi', -1.2921, 36.8219, [3, 3, 3, 3, 3, 3]]
];
const DATES = [[2026, 1, 15], [2026, 3, 20], [2026, 6, 21], [2026, 9, 23], [2026, 11, 16], [2026, 12, 21]];

test('the calculator agrees with the independent Meeus model within 1.5 minutes (8 methods, 9 cities, 6 dates, both Asr schools)', () => {
  let worst = { d: 0 }, compared = 0;
  for (const method of Object.keys(P.METHODS).map(Number)) {
    for (const [city, latitude, longitude, tzs] of PLACES) {
      DATES.forEach(([year, month, day], i) => {
        for (const school of [0, 1]) {
          const o = { year, month, day, latitude, longitude, timezone: tzs[i], method, school };
          const got = P.computeTimes(o), want = oracle(o);
          for (const k of ['fajr', 'sunrise', 'dhuhr', 'asr', 'sunset', 'isha']) {
            if (Number.isNaN(want[k])) continue;                       // no such time at this place and date (twilight never ends)
            // above ~48 degrees the usual convention limits Fajr / Isha to a share of the night instead of the astronomical
            // angle - that rule is tested on its own below, so those two times are not compared with the oracle there
            if ((k === 'fajr' || k === 'isha') && Math.abs(latitude) > 48) continue;
            const d = diffMin(got[k], want[k]);
            compared++;
            if (d > worst.d) worst = { d, k, city, method, date: `${year}-${month}-${day}`, school };
            assert.ok(d <= 1.5, `${k} differs by ${d.toFixed(2)} min (${city}, method ${method}, ${year}-${month}-${day}, school ${school}): got ${P.format(got[k])}, oracle ${P.format(want[k])}`);
          }
        }
      });
    }
  }
  assert.ok(compared > 4000, 'compared ' + compared);
  console.log(`# prayer-calc: ${compared} times compared with the oracle, worst difference ${worst.d.toFixed(2)} min (${worst.k}, ${worst.city}, method ${worst.method}, ${worst.date})`);
});

test('Dhaka, 16 Nov 2026, Karachi method: plausible and ordered', () => {
  const t = P.computeTimes({ year: 2026, month: 11, day: 16, latitude: 23.8103, longitude: 90.4125, timezone: 6, method: 1, school: 0 });
  const f = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, P.format(v)]));
  const within = (s, lo, hi) => { const [h, m] = s.split(':').map(Number); const x = h * 60 + m; return x >= lo[0] * 60 + lo[1] && x <= hi[0] * 60 + hi[1]; };
  assert.ok(within(f.fajr, [4, 45], [5, 5]), f.fajr);
  assert.ok(within(f.sunrise, [6, 5], [6, 20]), f.sunrise);
  assert.ok(within(f.dhuhr, [11, 35], [11, 50]), f.dhuhr);
  assert.ok(within(f.asr, [14, 40], [15, 0]), f.asr);
  assert.ok(within(f.maghrib, [17, 0], [17, 20]), f.maghrib);
  assert.ok(within(f.isha, [18, 20], [18, 40]), f.isha);
  assert.equal(f.maghrib, f.sunset);
  assert.equal(f.imsak, P.format(t.fajr - 10 / 60), 'Imsak is 10 minutes before Fajr');
  for (const v of Object.values(f)) assert.match(v, /^\d\d:\d\d$/);
});

test('every day of a year, many places: the five prayers are in order and the day has a sensible length', () => {
  let n = 0;
  for (const [, latitude, longitude, tzs] of PLACES.filter((p) => Math.abs(p[1]) < 45)) {
    for (let doy = 0; doy < 365; doy += 7) {
      const d = new Date(Date.UTC(2026, 0, 1 + doy));
      const t = P.computeTimes({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), latitude, longitude, timezone: tzs[0], method: 3, school: 0 });
      assert.ok(t.fajr < t.sunrise && t.sunrise < t.dhuhr && t.dhuhr < t.asr && t.asr < t.maghrib && t.maghrib < t.isha, JSON.stringify({ latitude, longitude, doy, t }));
      const dayLength = t.sunset - t.sunrise;
      assert.ok(dayLength > 8.4 && dayLength < 15.8, 'day length ' + dayLength.toFixed(2) + ' h');   // below 45 degrees of latitude
      n++;
    }
  }
  assert.ok(n > 300);
});

test('methods behave as defined: angles, Hanafi Asr, Umm al-Qura Isha = Maghrib + 90 (120 in Ramadan)', () => {
  const base = { year: 2026, month: 11, day: 16, latitude: 23.8103, longitude: 90.4125, timezone: 6, school: 0 };
  const T = (method, extra) => P.computeTimes({ ...base, method, ...extra });
  assert.ok(T(5).fajr < T(1).fajr && T(1).fajr < T(2).fajr, 'Fajr: Egypt 19.5 < Karachi 18 < ISNA 15 (a larger angle is earlier)');
  assert.ok(T(20).fajr < T(1).fajr, 'Kemenag 20 degrees is earlier than Karachi 18');
  assert.ok(T(1).isha > T(3).isha && T(3).isha > T(2).isha, 'Isha: Karachi 18 > MWL 17 > ISNA 15');
  assert.equal(T(1).fajr, T(3).fajr, 'Karachi and MWL share the 18 degree Fajr');
  const shafii = T(1).asr, hanafi = T(1, { school: 1 }).asr;
  assert.ok((hanafi - shafii) * 60 > 30 && (hanafi - shafii) * 60 < 60, 'Hanafi Asr is 30-60 minutes later in Dhaka: ' + ((hanafi - shafii) * 60).toFixed(0));
  assert.ok(Math.abs((T(4).isha - T(4).maghrib) * 60 - 90) < 1e-6);
  assert.ok(Math.abs((T(4, { ramadan: true }).isha - T(4).maghrib) * 60 - 120) < 1e-6);
  assert.ok(Math.abs((T(8).isha - T(8).maghrib) * 60 - 90) < 1e-6, 'Gulf: 90 minutes after Maghrib');
  assert.equal(T(8, { ramadan: true }).isha, T(8).isha, 'only Umm al-Qura lengthens Isha in Ramadan');
  assert.equal(T(13).isha, T(3).isha, 'Diyanet 18/17 = MWL 18/17');
});

test('equator at the March equinox: sunrise about 06:00 and sunset about 18:00 local solar time (sanity of the whole chain)', () => {
  const t = P.computeTimes({ year: 2026, month: 3, day: 20, latitude: 0, longitude: 0, timezone: 0, method: 3, school: 0 });
  assert.ok(Math.abs(t.sunrise - 6.07) < 0.1, P.format(t.sunrise));
  assert.ok(Math.abs(t.sunset - 18.18) < 0.1, P.format(t.sunset));
  assert.ok(Math.abs(t.dhuhr - 12.12) < 0.05, 'solar noon is delayed by the equation of time (-7 min in March): ' + P.format(t.dhuhr));
});

test('the longitude moves the clock times by 4 minutes per degree, the timezone shifts them 1:1', () => {
  const a = P.computeTimes({ year: 2026, month: 5, day: 1, latitude: 30, longitude: 40, timezone: 3, method: 1 });
  const b = P.computeTimes({ year: 2026, month: 5, day: 1, latitude: 30, longitude: 41, timezone: 3, method: 1 });
  assert.ok(Math.abs((a.dhuhr - b.dhuhr) * 60 - 4) < 0.05, 'one degree east is 4 minutes earlier');
  const c = P.computeTimes({ year: 2026, month: 5, day: 1, latitude: 30, longitude: 40, timezone: 4, method: 1 });
  assert.ok(Math.abs((c.dhuhr - a.dhuhr) - 1) < 1e-9);
});

test('high latitudes: when the twilight angle is not reached sensibly, Fajr / Isha use a share of the night (angle based)', () => {
  // London, 21 June, MWL (Fajr 18, Isha 17): the sun never gets 18 degrees below the horizon
  const t = P.computeTimes({ year: 2026, month: 6, day: 21, latitude: 51.5074, longitude: -0.1278, timezone: 1, method: 3 });
  const night = ((t.sunrise - t.sunset) % 24 + 24) % 24;
  assert.ok(night > 6 && night < 9, 'a short summer night: ' + night.toFixed(2) + ' h');
  assert.ok(Math.abs(t.fajr - (t.sunrise - 18 / 60 * night)) < 1e-9, 'Fajr = sunrise - 18/60 of the night');
  assert.ok(Math.abs(t.isha - (t.sunset + 17 / 60 * night)) < 1e-9, 'Isha = sunset + 17/60 of the night');
  assert.ok(t.fajr < t.sunrise && t.sunset < t.isha);
  // the same place in December needs no limit: the plain astronomical angle is used
  const w = P.computeTimes({ year: 2026, month: 12, day: 21, latitude: 51.5074, longitude: -0.1278, timezone: 0, method: 3 });
  const o = oracle({ year: 2026, month: 12, day: 21, latitude: 51.5074, longitude: -0.1278, timezone: 0, method: 3, school: 0 });
  assert.ok(diffMin(w.fajr, o.fajr) <= 1.5 && diffMin(w.isha, o.isha) <= 1.5, 'December: the astronomical angle');
});

test('polar summer: no sunset -> times are NaN, formatted as --:--, nothing crashes', () => {
  const t = P.computeTimes({ year: 2026, month: 6, day: 21, latitude: 78.2, longitude: 15.6, timezone: 2, method: 3 });
  assert.ok(Number.isNaN(t.sunrise) && Number.isNaN(t.sunset));
  assert.equal(P.format(t.sunrise), '--:--');
  const high = P.computeTimes({ year: 2026, month: 6, day: 21, latitude: 60, longitude: 10, timezone: 2, method: 3 });
  assert.ok(Number.isFinite(high.fajr) && Number.isFinite(high.isha), 'at 60 N in June the twilight limit keeps Fajr and Isha defined');
});

test('unsupported methods and bad input are refused, never guessed', () => {
  const ok = { year: 2026, month: 11, day: 16, latitude: 23.8, longitude: 90.4, timezone: 6, method: 1 };
  assert.ok(P.computeTimes(ok));
  for (const bad of [{ method: 15 }, { method: 0 }, { method: 99 }, { method: undefined }, { latitude: 91 }, { latitude: NaN }, { longitude: -181 }, { timezone: 20 }, { month: 13 }, { day: 0 }, { year: 1800 }, { year: 2026.5 }]) {
    assert.equal(P.computeTimes({ ...ok, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(P.toAladhanResponse({ ...ok, method: 15 }), null);
});

test('format(): rounds to the nearest minute, wraps midnight, handles NaN', () => {
  assert.equal(P.format(4.9), '04:54'); assert.equal(P.format(11.7), '11:42');
  assert.equal(P.format(6 + 29.5 / 60), '06:30', '29.5 minutes rounds up');
  assert.equal(P.format(6 + 29.4 / 60), '06:29');
  assert.equal(P.format(24.25), '00:15'); assert.equal(P.format(-0.5), '23:30');
  assert.equal(P.format(NaN), '--:--'); assert.equal(P.format(undefined), '--:--');
});

test('Al-Adhan shaped answer: the fields the app reads (data.timings.<Prayer> as "HH:MM", meta, date)', () => {
  const r = P.toAladhanResponse({ year: 2026, month: 11, day: 16, latitude: 23.8103, longitude: 90.4125, timezone: 6, timezoneName: 'Asia/Dhaka', method: 1 });
  assert.equal(r.code, 200); assert.equal(r.status, 'OK');
  for (const k of ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Sunset', 'Maghrib', 'Isha', 'Imsak', 'Midnight', 'Firstthird', 'Lastthird']) assert.match(r.data.timings[k], /^\d\d:\d\d$/, k);
  assert.equal(r.data.meta.method.id, 1); assert.deepEqual(r.data.meta.method.params, { Fajr: 18, Isha: 18 });
  assert.equal(r.data.meta.timezone, 'Asia/Dhaka'); assert.equal(r.data.meta.offline, true); assert.equal(r.data.meta.school, 'STANDARD');
  assert.equal(r.data.date.gregorian.date, '16-11-2026'); assert.equal(r.data.date.gregorian.weekday.en, 'Monday');
  assert.equal(r.data.date.readable, '16 Nov 2026');
  assert.equal(P.toAladhanResponse({ year: 2026, month: 11, day: 16, latitude: 23.8, longitude: 90.4, timezone: 6, method: 4 }).data.meta.method.params.Isha, '90 min');
  assert.equal(P.toAladhanResponse({ year: 2026, month: 11, day: 16, latitude: 23.8, longitude: 90.4, timezone: 6, method: 1, school: 1 }).data.meta.school, 'HANAFI');
});

test('Hijri date (Umm al-Qura through Intl): month number as js/ramadan.js reads it', () => {
  assert.deepEqual(P.hijriOf(2026, 11, 16), { day: 6, month: 6, year: 1448 });
  const r = P.hijriResponse(2026, 11, 16);
  assert.equal(r.data.hijri.month.number, 6); assert.equal(r.data.hijri.year, '1448'); assert.equal(r.data.hijri.designation.abbreviated, 'AH');
  assert.equal(P.hijriResponse(2026, 13, 1), null);
  // Ramadan 1447 started on 19 Feb 2026 (Umm al-Qura): month 9 on 20 Feb, month 8 the day before
  assert.equal(P.hijriOf(2026, 2, 20).month, 9); assert.equal(P.hijriOf(2026, 2, 17).month, 8);
  const ramadan = P.toAladhanResponse({ year: 2026, month: 3, day: 1, latitude: 21.4225, longitude: 39.8262, timezone: 3, method: 4 });
  assert.equal(ramadan.data.meta.method.params.Isha, '120 min', 'Umm al-Qura Isha is 120 minutes in Ramadan - detected from the Hijri month');
});
