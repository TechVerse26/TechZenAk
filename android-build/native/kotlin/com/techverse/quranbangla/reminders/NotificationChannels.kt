package com.techverse.quranbangla.reminders

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import com.techverse.quranbangla.widgets.Labels

/**
 * Notification channels: category x mode. Android 8+ keeps sound and vibration on the CHANNEL, so "sound / vibration only /
 * silent" per reminder means one channel for each combination. Channels are created once; their ids never change.
 */
object NotificationChannels {
    private val CATEGORIES = listOf("prayer", "reading", "azkar", "general")
    private val MODES = listOf("sound", "vibrate", "silent")

    fun id(category: String, mode: String): String = "qb_${category}_$mode"

    private fun categoryName(category: String, l: Labels): String = when (category) {
        "prayer" -> if (l.bangla) "নামাজের রিমাইন্ডার" else "Prayer reminders"
        "reading" -> if (l.bangla) "পড়ার রিমাইন্ডার" else "Reading reminders"
        "azkar" -> if (l.bangla) "আযকার ও আয়াত" else "Azkar and ayah"
        else -> if (l.bangla) "অন্যান্য রিমাইন্ডার" else "Other reminders"
    }

    private fun modeName(mode: String, l: Labels): String = when (mode) {
        "sound" -> if (l.bangla) "শব্দসহ" else "With sound"
        "vibrate" -> if (l.bangla) "শুধু ভাইব্রেশন" else "Vibration only"
        else -> if (l.bangla) "নীরব" else "Silent"
    }

    fun ensure(context: Context, labels: Labels) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        for (category in CATEGORIES) {
            for (mode in MODES) {
                val importance = when {
                    mode == "silent" -> NotificationManager.IMPORTANCE_LOW
                    category == "prayer" -> NotificationManager.IMPORTANCE_HIGH
                    else -> NotificationManager.IMPORTANCE_DEFAULT
                }
                val channel = NotificationChannel(id(category, mode), categoryName(category, labels) + " • " + modeName(mode, labels), importance)
                when (mode) {
                    "sound" -> channel.enableVibration(true)
                    "vibrate" -> {
                        channel.setSound(null, null)
                        channel.enableVibration(true)
                        channel.vibrationPattern = longArrayOf(0, 250, 150, 250)
                    }
                    else -> {
                        channel.setSound(null, null)
                        channel.enableVibration(false)
                    }
                }
                nm.createNotificationChannel(channel)
            }
        }
    }
}
