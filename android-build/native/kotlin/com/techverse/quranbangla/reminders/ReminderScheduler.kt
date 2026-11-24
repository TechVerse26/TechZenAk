package com.techverse.quranbangla.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.prayer.Hijri
import com.techverse.quranbangla.prayer.PrayerSchedule
import com.techverse.quranbangla.prayer.PrayerSettings
import org.json.JSONArray
import java.util.Calendar
import java.util.TimeZone

/**
 * Plans and schedules the reminders with AlarmManager.
 *  - An exact alarm is used when Android allows it (the user can grant "alarms & reminders" in system settings);
 *    otherwise the alarm is "inexact but still delivered in Doze" - the best compliant fallback, never a silent failure.
 *  - One alarm per reminder, rescheduled to its NEXT occurrence every time it fires and after a reboot, an app update,
 *    a time or time zone change (BootReceiver) and whenever the web app pushes new settings.
 *  - Prayer based reminders use the calculation on the device (js/prayer-calc.js twin), so they work with no network.
 */
object ReminderScheduler {
    const val ACTION_FIRE = "com.techverse.quranbangla.REMINDER_FIRE"
    const val EXTRA_ID = "reminder_id"
    private const val KEY_SCHEDULED = "scheduled_ids"
    private const val LOOKAHEAD_DAYS = 14

    class Planned(val reminder: Reminder, val triggerAt: Long)

    fun load(context: Context): List<Reminder> = Reminder.parseAll(NativeStore.of(context).remindersJson()).first

    fun save(context: Context, reminders: List<Reminder>) {
        val arr = JSONArray()
        for (r in reminders) arr.put(r.toJson())
        NativeStore.of(context).saveRemindersJson(arr)
    }

    fun find(context: Context, id: String): Reminder? = load(context).firstOrNull { it.id == id }

    fun canScheduleExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return am.canScheduleExactAlarms()
    }

    /** The next moment this reminder should fire after `nowMillis`, or null (disabled day mask, Ramadan only, no prayer location ...). */
    fun nextTrigger(r: Reminder, settings: PrayerSettings?, nowMillis: Long, tz: TimeZone): Long? {
        for (offset in 0..LOOKAHEAD_DAYS) {
            val c = Calendar.getInstance(tz)
            c.timeInMillis = nowMillis
            c.add(Calendar.DAY_OF_MONTH, offset)
            val year = c.get(Calendar.YEAR)
            val month = c.get(Calendar.MONTH) + 1
            val day = c.get(Calendar.DAY_OF_MONTH)
            val bit = 1 shl (c.get(Calendar.DAY_OF_WEEK) - 1)
            if ((r.days and bit) == 0) continue
            if (r.ramadanOnly && Hijri.month(year, month, day) != 9) continue
            val at = momentOn(r, settings, year, month, day, tz) ?: continue
            if (at > nowMillis + 1_000L) return at
        }
        return null
    }

    private fun momentOn(r: Reminder, settings: PrayerSettings?, year: Int, month: Int, day: Int, tz: TimeZone): Long? {
        val key = r.prayer
        if (key != null) {
            val s = settings ?: return null
            val base = PrayerSchedule.timeOf(s, key, year, month, day, tz) ?: return null
            return base + r.offsetMinutes * 60_000L
        }
        val c = Calendar.getInstance(tz)
        c.clear()
        c.set(year, month - 1, day, r.timeMinutes / 60, r.timeMinutes % 60, 0)
        return c.timeInMillis
    }

    fun plan(context: Context, nowMillis: Long = System.currentTimeMillis()): List<Planned> {
        val settings = PrayerSettings.from(NativeStore.of(context).state())
        val tz = TimeZone.getDefault()
        val out = ArrayList<Planned>()
        for (r in load(context)) {
            if (!r.enabled) continue
            val at = nextTrigger(r, settings, nowMillis, tz) ?: continue
            out.add(Planned(r, at))
        }
        out.sortBy { it.triggerAt }
        return out
    }

    fun nextPlanned(context: Context, nowMillis: Long = System.currentTimeMillis()): Planned? = plan(context, nowMillis).firstOrNull()

    private fun pendingFor(context: Context, id: String, create: Boolean): PendingIntent? {
        val intent = Intent(context, ReminderReceiver::class.java)
            .setAction(ACTION_FIRE)
            .setData(Uri.parse("quranbangla-reminder://$id"))
            .putExtra(EXTRA_ID, id)
        val flags = PendingIntent.FLAG_IMMUTABLE or (if (create) PendingIntent.FLAG_UPDATE_CURRENT else PendingIntent.FLAG_NO_CREATE)
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, flags)
    }

    private fun setAlarm(context: Context, am: AlarmManager, triggerAt: Long, pi: PendingIntent) {
        if (canScheduleExact(context)) {
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
                return
            } catch (e: SecurityException) {
                // the permission was withdrawn a moment ago: fall through to the inexact alarm
            }
        }
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
    }

    private fun previouslyScheduled(context: Context): Set<String> {
        val raw = NativeStore.of(context).getString(KEY_SCHEDULED) ?: return emptySet()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { arr.getString(it) }.toSet()
        } catch (e: Exception) {
            emptySet()
        }
    }

    /** Schedules the next occurrence of every enabled reminder and cancels the alarms of removed or disabled ones. */
    fun scheduleAll(context: Context, nowMillis: Long = System.currentTimeMillis()): List<Planned> {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val planned = plan(context, nowMillis)
        val keep = planned.map { it.reminder.id }.toSet()
        for (id in previouslyScheduled(context)) {
            if (id in keep) continue
            val old = pendingFor(context, id, false) ?: continue
            am.cancel(old)
            old.cancel()
        }
        for (p in planned) {
            val pi = pendingFor(context, p.reminder.id, true) ?: continue
            setAlarm(context, am, p.triggerAt, pi)
        }
        val ids = JSONArray()
        for (id in keep) ids.put(id)
        NativeStore.of(context).putString(KEY_SCHEDULED, ids.toString())
        return planned
    }
}
