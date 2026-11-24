package com.techverse.quranbangla.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.techverse.quranbangla.widgets.WidgetUpdater

/**
 * Alarms do not survive a reboot, and prayer times move with the clock: after a reboot, an app update, a time or time zone
 * change, or a change of the "alarms & reminders" permission every reminder is planned again and the widgets are refreshed.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in HANDLED) return
        val pending = goAsync()
        Thread {
            try {
                ReminderScheduler.scheduleAll(context)
                WidgetUpdater.updateAll(context)
                WidgetUpdater.scheduleNextTick(context)
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        private val HANDLED = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_DATE_CHANGED,
            "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED"
        )
    }
}
