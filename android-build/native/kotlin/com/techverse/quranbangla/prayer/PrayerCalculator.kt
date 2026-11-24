package com.techverse.quranbangla.prayer

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

data class CalcMethod(
    val id: Int,
    val name: String,
    val fajrAngle: Double,
    val ishaAngle: Double,
    val ishaMinutes: Int,
    val ishaMinutesRamadan: Int
)

/** Local clock times in hours (0..24, may leave that range by a little); NaN when the sun never reaches that angle. */
data class PrayerTimes(
    val fajr: Double,
    val sunrise: Double,
    val dhuhr: Double,
    val asr: Double,
    val sunset: Double,
    val maghrib: Double,
    val isha: Double,
    val imsak: Double,
    val midnight: Double,
    val firstThird: Double,
    val lastThird: Double
)

/**
 * Prayer times calculated on the device (no network). This is a line-by-line port of js/prayer-calc.js, which
 * tests/prayer-calc.test.js proves against an independent solar model (worst difference 0.22 minutes over 4992 times).
 * Keep both files identical in behaviour: the web app and the widgets / alarms must show the same times.
 *
 * Only the methods the app offers are implemented (1 Karachi, 2 ISNA, 3 MWL, 4 Umm al-Qura, 5 Egypt, 8 Gulf, 13 Diyanet,
 * 20 Kemenag). For any other method compute() returns null - it never guesses.
 */
object PrayerCalculator {
    val METHODS: Map<Int, CalcMethod> = listOf(
        CalcMethod(1, "University of Islamic Sciences, Karachi", 18.0, 18.0, 0, 0),
        CalcMethod(2, "Islamic Society of North America (ISNA)", 15.0, 15.0, 0, 0),
        CalcMethod(3, "Muslim World League", 18.0, 17.0, 0, 0),
        CalcMethod(4, "Umm Al-Qura University, Makkah", 18.5, 0.0, 90, 120),
        CalcMethod(5, "Egyptian General Authority of Survey", 19.5, 17.5, 0, 0),
        CalcMethod(8, "Gulf Region", 19.5, 0.0, 90, 0),
        CalcMethod(13, "Diyanet Isleri Baskanligi, Turkey", 18.0, 17.0, 0, 0),
        CalcMethod(20, "Kementerian Agama Republik Indonesia", 20.0, 18.0, 0, 0)
    ).associateBy { it.id }

    private const val D2R = Math.PI / 180.0
    private const val R2D = 180.0 / Math.PI

    private fun dsin(d: Double) = sin(d * D2R)
    private fun dcos(d: Double) = cos(d * D2R)
    private fun dtan(d: Double) = tan(d * D2R)
    private fun darcsin(x: Double) = asin(x) * R2D
    private fun darccos(x: Double) = acos(x) * R2D
    private fun darctan2(y: Double, x: Double) = atan2(y, x) * R2D
    private fun darccot(x: Double) = atan(1.0 / x) * R2D
    private fun fix(a: Double, m: Double) = a - m * floor(a / m)
    private fun fixAngle(a: Double) = fix(a, 360.0)
    private fun fixHour(a: Double) = fix(a, 24.0)

    fun julian(year: Int, month: Int, day: Int): Double {
        var y = year
        var m = month
        if (m <= 2) {
            y -= 1
            m += 12
        }
        val a = floor(y / 100.0)
        val b = 2 - a + floor(a / 4.0)
        return floor(365.25 * (y + 4716)) + floor(30.6001 * (m + 1)) + day + b - 1524.5
    }

    /** (declination in degrees, equation of time in hours) */
    private fun sunPosition(jd: Double): Pair<Double, Double> {
        val d = jd - 2451545.0
        val g = fixAngle(357.529 + 0.98560028 * d)
        val q = fixAngle(280.459 + 0.98564736 * d)
        val l = fixAngle(q + 1.915 * dsin(g) + 0.020 * dsin(2 * g))
        val e = 23.439 - 0.00000036 * d
        val ra = darctan2(dcos(e) * dsin(l), dcos(l)) / 15.0
        return Pair(darcsin(dsin(e) * dsin(l)), q / 15.0 - fixHour(ra))
    }

    /**
     * @param timezone hours east of UTC for that date (for example 6.0 for Bangladesh)
     * @param school 0 = standard (Shafi'i) Asr, 1 = Hanafi
     * @param ramadan Umm al-Qura only: Isha is 120 instead of 90 minutes after Maghrib
     */
    fun compute(
        year: Int, month: Int, day: Int,
        latitude: Double, longitude: Double, timezone: Double,
        methodId: Int, school: Int = 0, elevation: Double = 0.0, ramadan: Boolean = false
    ): PrayerTimes? {
        val method = METHODS[methodId] ?: return null
        if (latitude.isNaN() || latitude < -90.0 || latitude > 90.0) return null
        if (longitude.isNaN() || longitude < -180.0 || longitude > 180.0) return null
        if (timezone.isNaN() || timezone < -14.0 || timezone > 14.0) return null
        if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null

        val jDate = julian(year, month, day) - longitude / (15.0 * 24.0)
        val asrFactor = if (school == 1) 2.0 else 1.0
        val riseSetAngle = 0.0347 * sqrt(if (elevation > 0.0) elevation else 0.0) + 0.833

        fun midDay(t: Double): Double = fixHour(12.0 - sunPosition(jDate + t).second)

        fun sunAngleTime(angle: Double, t: Double, ccw: Boolean): Double {
            val decl = sunPosition(jDate + t).first
            val h = 1.0 / 15.0 * darccos((-dsin(angle) - dsin(decl) * dsin(latitude)) / (dcos(decl) * dcos(latitude)))
            return midDay(t) + (if (ccw) -h else h)
        }

        fun asrTime(factor: Double, t: Double): Double {
            val decl = sunPosition(jDate + t).first
            return sunAngleTime(-darccot(factor + dtan(abs(latitude - decl))), t, false)
        }

        var fajr = sunAngleTime(method.fajrAngle, 5.0 / 24.0, true)
        var sunrise = sunAngleTime(riseSetAngle, 6.0 / 24.0, true)
        var dhuhr = midDay(12.0 / 24.0)
        var asr = asrTime(asrFactor, 13.0 / 24.0)
        var sunset = sunAngleTime(riseSetAngle, 18.0 / 24.0, false)
        var isha = if (method.ishaMinutes > 0) 0.0 else sunAngleTime(method.ishaAngle, 18.0 / 24.0, false)

        // local clock time; Maghrib is the sunset for every method the app offers
        val shift = timezone - longitude / 15.0
        fajr += shift
        sunrise += shift
        dhuhr += shift
        asr += shift
        sunset += shift
        isha += shift
        val maghrib = sunset

        // high latitudes: when the twilight never ends or never starts, limit Fajr / Isha to a share of the night (angle based)
        val night = fixHour(sunrise - sunset)
        if (!night.isNaN()) {
            fajr = limited(fajr, sunrise, method.fajrAngle, true, night)
            if (method.ishaMinutes == 0) isha = limited(isha, sunset, method.ishaAngle, false, night)
        }
        if (method.ishaMinutes > 0) {
            val minutes = if (ramadan && method.ishaMinutesRamadan > 0) method.ishaMinutesRamadan else method.ishaMinutes
            isha = maghrib + minutes / 60.0
        }

        val imsak = fajr - 10.0 / 60.0
        val span = fixHour(sunrise - sunset)
        return PrayerTimes(
            fajr = fajr, sunrise = sunrise, dhuhr = dhuhr, asr = asr, sunset = sunset, maghrib = maghrib, isha = isha,
            imsak = imsak, midnight = sunset + span / 2.0, firstThird = sunset + span / 3.0, lastThird = sunset + span * 2.0 / 3.0
        )
    }

    private fun limited(time: Double, base: Double, angle: Double, ccw: Boolean, night: Double): Double {
        val portion = angle / 60.0 * night
        val diff = if (ccw) fixHour(base - time) else fixHour(time - base)
        return if (time.isNaN() || diff > portion) base + (if (ccw) -portion else portion) else time
    }
}
