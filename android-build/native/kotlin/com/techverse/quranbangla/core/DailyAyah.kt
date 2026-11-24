package com.techverse.quranbangla.core

import android.content.Context
import com.techverse.quranbangla.prayer.PrayerSchedule

/**
 * The "Ayah of the Day": the SAME ayah the app shows on its home card. js/data.js picks AYAH_OF_DAY_POOL[dayNumber % size]
 * with dayNumber = whole days since 1970-01-01 of the LOCAL calendar date; this does exactly that with the same pool
 * (SurahData.kt is generated from js/data.js, so the two cannot differ).
 */
object DailyAyah {
    class Pick(val surah: Int, val ayah: Int, val arabic: String, val translation: String?)

    fun dayNumber(year: Int, month: Int, day: Int): Long = Math.floorDiv(PrayerSchedule.utcMidnight(year, month, day), 86_400_000L)

    fun pairFor(year: Int, month: Int, day: Int): IntArray {
        val pool = SurahData.AYAH_OF_DAY
        return pool[(dayNumber(year, month, day) % pool.size).toInt()]
    }

    /** @param edition translation edition (bn.bengali ...) - null when the translation is not bundled */
    fun pick(context: Context, edition: String, year: Int, month: Int, day: Int): Pick? {
        val pair = pairFor(year, month, day)
        val global = QuranAssets.globalNumber(context, pair[0], pair[1]) ?: return null
        var arabic = QuranAssets.ayahText(context, "quran-uthmani", global) ?: return null
        // The first ayah of a surah is stored with the Bismillah in front of it; the app shows the Bismillah separately.
        // Remove it only when the text really starts with the bundled text of 1:1 (never an approximation).
        if (pair[1] == 1 && pair[0] != 1 && pair[0] != 9) {
            val bismillah = QuranAssets.ayahText(context, "quran-uthmani", 1)
            if (bismillah != null && arabic.startsWith(bismillah) && arabic.length > bismillah.length) arabic = arabic.substring(bismillah.length).trim()
        }
        val translation = if (edition.isNotEmpty()) QuranAssets.ayahText(context, edition, global) else null
        return Pick(pair[0], pair[1], arabic, translation)
    }
}
