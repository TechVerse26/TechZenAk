package com.techverse.quranbangla.prayer

import com.techverse.quranbangla.core.doubleOrNull
import com.techverse.quranbangla.core.intOrDefault
import com.techverse.quranbangla.core.objectOrNull
import com.techverse.quranbangla.core.stringOrNull
import org.json.JSONObject
import java.util.Calendar
import java.util.TimeZone

enum class Prayer(val key: String) {
    FAJR("fajr"), SUNRISE("sunrise"), DHUHR("dhuhr"), ASR("asr"), MAGHRIB("maghrib"), ISHA("isha");

    companion object {
        fun fromKey(key: String?): Prayer? = values().firstOrNull { it.key == key }
    }
}

/** Where and how times are calculated. The web app pushes it (js/native-sync.js); without a location nothing is scheduled. */
data class PrayerSettings(
    val latitude: Double,
    val longitude: Double,
    val method: Int,
    val school: Int,
    val label: String?
) {
    companion object {
        fun from(state: JSONObject): PrayerSettings? {
            val p = state.objectOrNull("prayer") ?: return null
            val lat = p.doubleOrNull("lat") ?: return null
            val lon = p.doubleOrNull("lon") ?: return null
            if (lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) return null
            val method = p.intOrDefault("method", 1)
            if (!PrayerCalculator.METHODS.containsKey(method)) return null
            return PrayerSettings(lat, lon, method, if (p.intOrDefault("school", 0) == 1) 1 else 0, p.stringOrNull("label"))
        }
    }
}

/** The times of one calendar day as moments in time. */
class DayTimes(
    val year: Int,
    val month: Int,
    val day: Int,
    private val times: PrayerTimes,
    private val tzHours: Double
) {
    private fun at(hours: Double): Long? =
        if (hours.isNaN()) null else PrayerSchedule.utcMidnight(year, month, day) + Math.round((hours - tzHours) * 3_600_000.0)

    fun millis(prayer: Prayer): Long? = when (prayer) {
        Prayer.FAJR -> at(times.fajr)
        Prayer.SUNRISE -> at(times.sunrise)
        Prayer.DHUHR -> at(times.dhuhr)
        Prayer.ASR -> at(times.asr)
        Prayer.MAGHRIB -> at(times.maghrib)
        Prayer.ISHA -> at(times.isha)
    }

    fun imsak(): Long? = at(times.imsak)
    fun lastThird(): Long? = at(times.lastThird)
}

class NextPrayer(val current: Prayer?, val currentMillis: Long?, val next: Prayer, val nextMillis: Long)

object PrayerSchedule {
    /** The five obligatory prayers (sunrise is shown by the app but is not a prayer time). */
    val OBLIGATORY: List<Prayer> = listOf(Prayer.FAJR, Prayer.DHUHR, Prayer.ASR, Prayer.MAGHRIB, Prayer.ISHA)

    fun utcMidnight(year: Int, month: Int, day: Int): Long {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        c.clear()
        c.set(year, month - 1, day, 0, 0, 0)
        return c.timeInMillis
    }

    fun computeDay(settings: PrayerSettings, year: Int, month: Int, day: Int, tz: TimeZone): DayTimes? {
        val noon = Calendar.getInstance(tz)
        noon.clear()
        noon.set(year, month - 1, day, 12, 0, 0)
        val tzHours = tz.getOffset(noon.timeInMillis) / 3_600_000.0
        val ramadan = Hijri.month(year, month, day) == 9
        val t = PrayerCalculator.compute(year, month, day, settings.latitude, settings.longitude, tzHours, settings.method, settings.school, 0.0, ramadan)
            ?: return null
        return DayTimes(year, month, day, t, tzHours)
    }

    /** The prayer that has just begun and the next one (tomorrow's Fajr after Isha). */
    fun next(settings: PrayerSettings, nowMillis: Long, tz: TimeZone): NextPrayer? {
        val events = ArrayList<Pair<Prayer, Long>>()
        for (offset in -1..1) {
            val d = Calendar.getInstance(tz)
            d.timeInMillis = nowMillis
            d.add(Calendar.DAY_OF_MONTH, offset)
            val day = computeDay(settings, d.get(Calendar.YEAR), d.get(Calendar.MONTH) + 1, d.get(Calendar.DAY_OF_MONTH), tz) ?: continue
            for (p in OBLIGATORY) {
                val t = day.millis(p)
                if (t != null) events.add(Pair(p, t))
            }
        }
        events.sortBy { it.second }
        val next = events.firstOrNull { it.second > nowMillis } ?: return null
        val current = events.lastOrNull { it.second <= nowMillis }
        return NextPrayer(current?.first, current?.second, next.first, next.second)
    }

    /** One named moment of a day: fajr, sunrise, dhuhr, asr, maghrib, isha, imsak or lastthird (start of the last third of the night). */
    fun timeOf(settings: PrayerSettings, key: String, year: Int, month: Int, day: Int, tz: TimeZone): Long? {
        val d = computeDay(settings, year, month, day, tz) ?: return null
        return when (key) {
            "imsak" -> d.imsak()
            "lastthird" -> d.lastThird()
            else -> Prayer.fromKey(key)?.let { d.millis(it) }
        }
    }
}

object Hijri {
    /** Hijri (Umm al-Qura) month 1..12 of a Gregorian date, or 0 when the platform cannot tell (Ramadan is month 9). */
    fun month(year: Int, month: Int, day: Int): Int {
        return try {
            val cal = android.icu.util.IslamicCalendar(android.icu.util.TimeZone.getTimeZone("UTC"), android.icu.util.ULocale.ENGLISH)
            cal.setCalculationType(android.icu.util.IslamicCalendar.CalculationType.ISLAMIC_UMALQURA)
            cal.timeInMillis = PrayerSchedule.utcMidnight(year, month, day) + 12L * 3_600_000L
            cal.get(android.icu.util.Calendar.MONTH) + 1
        } catch (e: Throwable) {
            0
        }
    }
}
