package com.techverse.quranbangla.widgets

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.prayer.PrayerSchedule
import com.techverse.quranbangla.prayer.PrayerSettings
import java.util.Calendar
import java.util.TimeZone

/** Refreshes all widgets and keeps ONE inexact alarm for the next moment their content changes (prayer time or midnight). */
object WidgetUpdater {
    const val ACTION_TICK = "com.techverse.quranbangla.WIDGET_TICK"
    private const val TICK_REQUEST_CODE = 7701

    private class Entry(val key: String, val cls: Class<out BaseWidgetProvider>, val create: () -> BaseWidgetProvider)

    private val ENTRIES: List<Entry> = listOf(
        Entry("next_prayer", NextPrayerWidget::class.java) { NextPrayerWidget() },
        Entry("daily_ayah", DailyAyahWidget::class.java) { DailyAyahWidget() },
        Entry("continue_reading", ContinueReadingWidget::class.java) { ContinueReadingWidget() },
        Entry("quick_actions", QuickActionsWidget::class.java) { QuickActionsWidget() },
        Entry("reminder_status", ReminderStatusWidget::class.java) { ReminderStatusWidget() }
    )

    val KEYS: List<String> get() = ENTRIES.map { it.key }

    fun classFor(key: String): Class<out BaseWidgetProvider>? = ENTRIES.firstOrNull { it.key == key }?.cls

    /** Redraws every placed widget. Returns how many widget instances were updated. */
    fun updateAll(context: Context): Int {
        val manager = AppWidgetManager.getInstance(context)
        var updated = 0
        for (e in ENTRIES) {
            val ids = manager.getAppWidgetIds(ComponentName(context, e.cls))
            if (ids.isNotEmpty()) {
                e.create().update(context, manager, ids)
                updated += ids.size
            }
        }
        return updated
    }

    /** key -> number of placed instances */
    fun installed(context: Context): Map<String, Int> {
        val manager = AppWidgetManager.getInstance(context)
        return ENTRIES.associate { it.key to manager.getAppWidgetIds(ComponentName(context, it.cls)).size }
    }

    private fun tickIntent(context: Context, create: Boolean): PendingIntent? {
        val intent = Intent(context, WidgetTickReceiver::class.java).setAction(ACTION_TICK)
        val flags = PendingIntent.FLAG_IMMUTABLE or (if (create) PendingIntent.FLAG_UPDATE_CURRENT else PendingIntent.FLAG_NO_CREATE)
        return PendingIntent.getBroadcast(context, TICK_REQUEST_CODE, intent, flags)
    }

    private fun nextMidnight(nowMillis: Long): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = nowMillis
        c.add(Calendar.DAY_OF_MONTH, 1)
        c.set(Calendar.HOUR_OF_DAY, 0)
        c.set(Calendar.MINUTE, 0)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    /**
     * One alarm, not a loop: the next prayer time or midnight, whichever is first. RTC (not RTC_WAKEUP): a sleeping phone is not
     * woken just to redraw a widget - it is redrawn when the phone wakes. The countdown itself is a Chronometer the launcher ticks.
     */
    fun scheduleNextTick(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        if (installed(context).values.sum() == 0) {
            val existing = tickIntent(context, false)
            if (existing != null) {
                am.cancel(existing)
                existing.cancel()
            }
            return
        }
        val now = System.currentTimeMillis()
        var at = nextMidnight(now) + 5_000L
        val settings = PrayerSettings.from(NativeStore.of(context).state())
        if (settings != null) {
            val next = PrayerSchedule.next(settings, now, TimeZone.getDefault())
            if (next != null && next.nextMillis + 5_000L < at) at = next.nextMillis + 5_000L
        }
        val pi = tickIntent(context, true) ?: return
        am.setAndAllowWhileIdle(AlarmManager.RTC, at, pi)
    }
}
