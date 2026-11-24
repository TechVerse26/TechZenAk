package com.techverse.quranbangla.core

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The small, synchronous store shared by the web app (through the bridge) and the Android components that cannot wait for
 * the WebView: alarms, widgets, the boot receiver.
 *
 * Why SharedPreferences and not the Room database for this: an alarm or a boot receiver must work instantly and reliably,
 * without opening a database on a background thread first. These values are tiny (a few hundred bytes of JSON); everything
 * that is large or relational (downloads, history, bookmarks) lives in Room (see the db package).
 */
class NativeStore private constructor(private val prefs: SharedPreferences) {

    /** The snapshot the web app pushes (last read, prayer location, goals, language ...), see js/native-sync.js. */
    fun state(): JSONObject = readObject(KEY_STATE)

    fun saveState(state: JSONObject) {
        prefs.edit().putString(KEY_STATE, state.toString()).apply()
    }

    fun remindersJson(): JSONArray = readArray(KEY_REMINDERS)

    fun saveRemindersJson(list: JSONArray) {
        prefs.edit().putString(KEY_REMINDERS, list.toString()).apply()
    }

    fun getString(key: String): String? = prefs.getString(key, null)

    fun putString(key: String, value: String?) {
        prefs.edit().putString(key, value).apply()
    }

    private fun readObject(key: String): JSONObject =
        try { JSONObject(prefs.getString(key, null) ?: "{}") } catch (e: JSONException) { JSONObject() }

    private fun readArray(key: String): JSONArray =
        try { JSONArray(prefs.getString(key, null) ?: "[]") } catch (e: JSONException) { JSONArray() }

    companion object {
        private const val FILE = "qb_native_store"
        private const val KEY_STATE = "state"
        private const val KEY_REMINDERS = "reminders"

        @Volatile
        private var instance: NativeStore? = null

        fun of(context: Context): NativeStore =
            instance ?: synchronized(this) {
                instance ?: NativeStore(context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)).also { instance = it }
            }
    }
}
