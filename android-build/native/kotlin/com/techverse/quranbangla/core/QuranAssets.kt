package com.techverse.quranbangla.core

import android.content.Context
import android.util.JsonReader
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Reads the Quran data that ships INSIDE the APK (assets/public/data/quran/, written by tools/quran-data/quran_data.py and
 * verified at build time and again on the finished APK) - for the widgets, which cannot ask the WebView.
 * The text is returned exactly as bundled; nothing is edited, merged or generated here.
 */
object QuranAssets {
    private const val BASE = "public/data/quran"
    private const val TOTAL_AYAHS = 6236
    private const val SURAHS = 114
    private val EDITION = Regex("^(?:[a-z]{2,3}\\.[a-z0-9_]{2,40}|quran-[a-z]+(?:-[a-z]+){0,3})$")

    @Volatile private var surahStart: IntArray? = null
    @Volatile private var ayahCounts: IntArray? = null

    private fun loadStructure(context: Context): Boolean {
        if (surahStart != null && ayahCounts != null) return true
        return try {
            val text = context.assets.open("$BASE/structure.json").use { it.readBytes().toString(Charsets.UTF_8) }
            val o = JSONObject(text)
            val starts = o.getJSONArray("surahStart")
            val counts = o.getJSONArray("ayahCounts")
            if (starts.length() != SURAHS || counts.length() != SURAHS) return false
            surahStart = IntArray(SURAHS) { starts.getInt(it) }
            ayahCounts = IntArray(SURAHS) { counts.getInt(it) }
            true
        } catch (e: Exception) {
            false
        }
    }

    @Volatile private var surahNames: Array<Pair<String, String>>? = null

    /** (Arabic name, English name) of a surah (1..114) from the bundled surahs.json, or null. */
    fun surahName(context: Context, surah: Int): Pair<String, String>? {
        if (surah < 1 || surah > SURAHS) return null
        if (surahNames == null) {
            surahNames = try {
                val text = context.assets.open("$BASE/surahs.json").use { it.readBytes().toString(Charsets.UTF_8) }
                val arr = org.json.JSONArray(text)
                if (arr.length() != SURAHS) null
                else Array(SURAHS) { i -> Pair(arr.getJSONObject(i).optString("name"), arr.getJSONObject(i).optString("englishName")) }
            } catch (e: Exception) {
                null
            }
        }
        return surahNames?.get(surah - 1)
    }

    /** Number of ayahs in a surah (1..114), or null when the data is not available. */
    fun ayahCount(context: Context, surah: Int): Int? {
        if (surah < 1 || surah > SURAHS || !loadStructure(context)) return null
        return ayahCounts?.get(surah - 1)
    }

    /** Global ayah number 1..6236 of surah:ayah, or null when it does not exist. */
    fun globalNumber(context: Context, surah: Int, ayah: Int): Int? {
        val count = ayahCount(context, surah) ?: return null
        if (ayah < 1 || ayah > count) return null
        val start = surahStart?.get(surah - 1) ?: return null
        val global = start + ayah - 1
        return if (global in 1..TOTAL_AYAHS) global else null
    }

    /** Text of one ayah in an edition (for example quran-uthmani, bn.bengali), or null when the edition is not bundled. */
    fun ayahText(context: Context, edition: String, global: Int): String? {
        if (!EDITION.matches(edition) || global < 1 || global > TOTAL_AYAHS) return null
        return try {
            context.assets.open("$BASE/text/$edition.json").use { stream ->
                JsonReader(BufferedReader(InputStreamReader(stream, Charsets.UTF_8))).use { reader ->
                    reader.beginArray()
                    var index = 1
                    var found: String? = null
                    while (reader.hasNext()) {
                        if (index == global) {
                            found = reader.nextString()
                            break
                        }
                        reader.skipValue()
                        index++
                    }
                    found
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    fun hasEdition(context: Context, edition: String): Boolean {
        if (!EDITION.matches(edition)) return false
        return try {
            context.assets.open("$BASE/text/$edition.json").close()
            true
        } catch (e: Exception) {
            false
        }
    }
}
