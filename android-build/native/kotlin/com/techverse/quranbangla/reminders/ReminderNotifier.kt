package com.techverse.quranbangla.reminders

import android.annotation.SuppressLint
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.techverse.quranbangla.core.Deeplinks
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.widgets.Labels
import __APP_ID__.R

/** Shows the notification of a reminder. Tapping it opens the reminder's quranbangla:// link inside the app. */
object ReminderNotifier {
    @SuppressLint("MissingPermission") // POST_NOTIFICATIONS is checked with areNotificationsEnabled() and a SecurityException is caught
    fun show(context: Context, r: Reminder) {
        NotificationChannels.ensure(context, Labels.of(NativeStore.of(context).state()))
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return
        val priority = when (r.priority) {
            "high" -> NotificationCompat.PRIORITY_HIGH
            "low" -> NotificationCompat.PRIORITY_LOW
            else -> NotificationCompat.PRIORITY_DEFAULT
        }
        val notification = NotificationCompat.Builder(context, NotificationChannels.id(r.category, r.mode))
            .setSmallIcon(R.drawable.ic_stat_quran)
            .setContentTitle(r.title)
            .setContentText(r.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(r.body))
            .setContentIntent(Deeplinks.pending(context, r.link))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(priority)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        try {
            manager.notify(r.id.hashCode(), notification)
        } catch (e: SecurityException) {
            // notifications were switched off between the check and the call
        }
    }
}
