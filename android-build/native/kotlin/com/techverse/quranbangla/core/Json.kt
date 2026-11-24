package com.techverse.quranbangla.core

import org.json.JSONArray
import org.json.JSONObject

// Small null-safe helpers: org.json returns "" / 0 / false for missing keys, which hides mistakes.

internal fun JSONObject.stringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) optString(name).takeIf { it.isNotEmpty() } else null

internal fun JSONObject.doubleOrNull(name: String): Double? {
    if (!has(name) || isNull(name)) return null
    val v = optDouble(name, Double.NaN)
    return if (v.isNaN() || v.isInfinite()) null else v
}

internal fun JSONObject.intOrDefault(name: String, default: Int): Int =
    if (has(name) && !isNull(name)) optInt(name, default) else default

internal fun JSONObject.boolOrDefault(name: String, default: Boolean): Boolean =
    if (has(name) && !isNull(name)) optBoolean(name, default) else default

internal fun JSONObject.objectOrNull(name: String): JSONObject? =
    if (has(name) && !isNull(name)) optJSONObject(name) else null

internal fun JSONObject.arrayOrNull(name: String): JSONArray? =
    if (has(name) && !isNull(name)) optJSONArray(name) else null
