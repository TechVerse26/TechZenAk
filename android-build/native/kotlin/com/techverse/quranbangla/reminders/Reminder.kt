package com.techverse.quranbangla.reminders

import com.techverse.quranbangla.core.Deeplinks
import com.techverse.quranbangla.core.boolOrDefault
import com.techverse.quranbangla.core.intOrDefault
import com.techverse.quranbangla.core.stringOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * One reminder. The web app owns the list (it knows the user's language and settings) and pushes it through the bridge;
 * native code only schedules and shows it. A reminder fires either at a fixed time of day (timeMinutes) or relative to a
 * prayer time (prayer + offsetMinutes), on the days of the week in `days`.
 */
data class Reminder(
    val id: String,
    val kind: String,
    val enabled: Boolean,
    val title: String,
    val body: String,
    val timeMinutes: Int,
    val prayer: String?,
    val offsetMinutes: Int,
    val days: Int,
    val mode: String,
    val priority: String,
    val ramadanOnly: Boolean,
    val link: String
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("kind", kind)
        .put("enabled", enabled)
        .put("title", title)
        .put("body", body)
        .put("timeMinutes", timeMinutes)
        .put("prayer", prayer ?: JSONObject.NULL)
        .put("offsetMinutes", offsetMinutes)
        .put("days", days)
        .put("mode", mode)
        .put("priority", priority)
        .put("ramadanOnly", ramadanOnly)
        .put("link", link)

    val category: String get() = categoryOf(kind)

    companion object {
        const val ALL_DAYS = 127 // bit 0 = Sunday ... bit 6 = Saturday
        const val MAX_REMINDERS = 64

        private val ID = Regex("^[a-z0-9_.-]{1,48}$")
        private val PRAYER_KEYS = setOf("fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha", "imsak", "lastthird")
        val MODES = setOf("sound", "vibrate", "silent")
        val PRIORITIES = setOf("high", "default", "low")
        val KINDS = setOf(
            "prayer", "daily_quran", "azkar_morning", "azkar_evening", "daily_ayah", "goal", "streak", "course", "custom",
            "ramadan_suhoor", "ramadan_iftar", "taraweeh", "tahajjud", "jumuah"
        )

        fun categoryOf(kind: String): String = when (kind) {
            "prayer", "ramadan_suhoor", "ramadan_iftar", "taraweeh", "tahajjud", "jumuah" -> "prayer"
            "daily_quran", "goal", "streak", "course" -> "reading"
            "azkar_morning", "azkar_evening", "daily_ayah" -> "azkar"
            else -> "general"
        }

        /** A reminder, or null when anything about it is not acceptable (nothing is repaired or guessed). */
        fun fromJson(o: JSONObject): Reminder? {
            val id = o.stringOrNull("id") ?: return null
            if (!ID.matches(id)) return null
            val kind = o.stringOrNull("kind") ?: "custom"
            if (kind !in KINDS) return null
            val title = o.stringOrNull("title") ?: return null
            if (title.length > 120) return null
            val body = o.optString("body", "")
            if (body.length > 300) return null
            val prayer = o.stringOrNull("prayer")
            if (prayer != null && prayer !in PRAYER_KEYS) return null
            val timeMinutes = o.intOrDefault("timeMinutes", 0)
            if (timeMinutes < 0 || timeMinutes > 1439) return null
            val offset = o.intOrDefault("offsetMinutes", 0)
            if (offset < -720 || offset > 720) return null
            val days = o.intOrDefault("days", ALL_DAYS)
            if (days < 1 || days > ALL_DAYS) return null
            val mode = o.stringOrNull("mode") ?: "sound"
            if (mode !in MODES) return null
            val priority = o.stringOrNull("priority") ?: "default"
            if (priority !in PRIORITIES) return null
            val link = o.stringOrNull("link") ?: Deeplinks.screen("home")
            if (!Deeplinks.isOurs(link)) return null
            return Reminder(id, kind, o.boolOrDefault("enabled", true), title, body, timeMinutes, prayer, offset, days, mode, priority, o.boolOrDefault("ramadanOnly", false), link)
        }

        /** (accepted reminders, indexes of the entries that were refused). Duplicated ids and more than MAX_REMINDERS are refused. */
        fun parseAll(array: JSONArray): Pair<List<Reminder>, List<Int>> {
            val accepted = ArrayList<Reminder>()
            val refused = ArrayList<Int>()
            val seen = HashSet<String>()
            for (i in 0 until array.length()) {
                val r = array.optJSONObject(i)?.let { fromJson(it) }
                if (r == null || r.id in seen || accepted.size >= MAX_REMINDERS) refused.add(i) else {
                    seen.add(r.id)
                    accepted.add(r)
                }
            }
            return Pair(accepted, refused)
        }
    }
}
