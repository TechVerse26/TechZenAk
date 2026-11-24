package com.techverse.quranbangla.widgets

import android.content.Context
import com.techverse.quranbangla.prayer.Prayer
import org.json.JSONObject
import java.util.Date

/** Texts and number formatting of widgets and notifications. They follow the APP language (bn, otherwise en), not the phone's. */
class Labels private constructor(val bangla: Boolean) {
    companion object {
        fun of(state: JSONObject): Labels = Labels(state.optString("language", "bn") != "en")
        private const val BN_DIGITS = "০১২৩৪৫৬৭৮৯"
    }

    private fun t(bn: String, en: String): String = if (bangla) bn else en

    fun prayer(p: Prayer): String = when (p) {
        Prayer.FAJR -> t("ফজর", "Fajr")
        Prayer.SUNRISE -> t("সূর্যোদয়", "Sunrise")
        Prayer.DHUHR -> t("যোহর", "Dhuhr")
        Prayer.ASR -> t("আসর", "Asr")
        Prayer.MAGHRIB -> t("মাগরিব", "Maghrib")
        Prayer.ISHA -> t("এশা", "Isha")
    }

    val nextPrayer: String get() = t("পরবর্তী নামাজ", "Next prayer")
    val now: String get() = t("এখন", "Now")
    val setLocation: String get() = t("লোকেশন সেট করুন", "Set your location")
    val openAppHint: String get() = t("অ্যাপ খুলে নামাজের লোকেশন ঠিক করুন", "Open the app and choose your prayer location")
    val dailyAyah: String get() = t("আজকের আয়াত", "Ayah of the day")
    val surah: String get() = t("সূরা", "Surah")
    val openApp: String get() = t("অ্যাপ খুলুন", "Open the app")
    val continueReading: String get() = t("পড়া চালিয়ে যান", "Continue reading")
    val startReading: String get() = t("কুরআন পড়া শুরু করুন", "Start reading the Quran")
    val resume: String get() = t("চালিয়ে যান", "Continue")
    val ayah: String get() = t("আয়াত", "Ayah")
    val ofQuran: String get() = t("কুরআনের", "of the Quran")
    val readingPlan: String get() = t("পড়ার পরিকল্পনা", "Reading plan")
    val noGoal: String get() = t("পড়ার পরিকল্পনা ঠিক করুন", "Set a reading plan")
    val daysUnit: String get() = t("দিন", "days")
    val doneToday: String get() = t("আজ সম্পন্ন ✓", "Done today ✓")
    val notDoneToday: String get() = t("আজ বাকি আছে", "Not done today")
    val streak: String get() = t("ধারাবাহিক দিন", "Day streak")
    val nextReminder: String get() = t("পরবর্তী রিমাইন্ডার", "Next reminder")
    val remindersOff: String get() = t("রিমাইন্ডার বন্ধ আছে", "Reminders are off")
    val quran: String get() = t("কুরআন", "Quran")
    val search: String get() = t("সার্চ", "Search")
    val qibla: String get() = t("কিবলা", "Qibla")
    val tasbih: String get() = t("তাসবিহ", "Tasbih")

    /** ASCII digits -> Bengali digits when the app language is Bengali. */
    fun digits(text: String): String {
        if (!bangla) return text
        val sb = StringBuilder(text.length)
        for (ch in text) sb.append(if (ch in '0'..'9') BN_DIGITS[ch - '0'] else ch)
        return sb.toString()
    }

    fun time(context: Context, millis: Long): String =
        digits(android.text.format.DateFormat.getTimeFormat(context).format(Date(millis)))
}
