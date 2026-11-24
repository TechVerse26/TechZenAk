package com.techverse.quranbangla.widgets

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import com.techverse.quranbangla.core.Deeplinks
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.prayer.PrayerSchedule
import com.techverse.quranbangla.prayer.PrayerSettings
import java.util.TimeZone
import __APP_ID__.R

/** Widget A - next prayer: name, time and a live countdown (a Chronometer, ticked by the launcher; no wake-ups from us). */
class NextPrayerWidget : BaseWidgetProvider() {
    override val layoutId: Int get() = R.layout.qw_widget_next_prayer

    override fun build(context: Context, widgetId: Int, options: Bundle): RemoteViews {
        val views = RemoteViews(context.packageName, layoutId)
        val state = NativeStore.of(context).state()
        val labels = Labels.of(state)
        views.setOnClickPendingIntent(R.id.qw_root, Deeplinks.pending(context, Deeplinks.screen("prayer")))
        views.setTextViewText(R.id.qw_title, labels.nextPrayer)

        val settings = PrayerSettings.from(state)
        val now = System.currentTimeMillis()
        val next = if (settings != null) PrayerSchedule.next(settings, now, TimeZone.getDefault()) else null
        if (settings == null || next == null) {
            views.setTextViewText(R.id.qw_next_name, labels.setLocation)
            views.setTextViewText(R.id.qw_next_time, "")
            views.setViewVisibility(R.id.qw_countdown, View.GONE)
            views.setTextViewText(R.id.qw_current, labels.openAppHint)
            return views
        }

        views.setTextViewText(R.id.qw_next_name, labels.prayer(next.next))
        views.setTextViewText(R.id.qw_next_time, labels.time(context, next.nextMillis))
        views.setViewVisibility(R.id.qw_countdown, View.VISIBLE)
        views.setChronometerCountDown(R.id.qw_countdown, true)
        views.setChronometer(R.id.qw_countdown, SystemClock.elapsedRealtime() + (next.nextMillis - now), null, true)

        val current = next.current
        val currentAt = next.currentMillis
        val line = if (current != null && currentAt != null) "${labels.now}: ${labels.prayer(current)} • ${labels.time(context, currentAt)}" else (settings.label ?: "")
        views.setTextViewText(R.id.qw_current, line)
        return views
    }
}
