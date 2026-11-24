package com.techverse.quranbangla.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.techverse.quranbangla.widgets.WidgetUpdater

/** An alarm fired: show the notification, then schedule the NEXT occurrence of every reminder and refresh the widgets. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ReminderScheduler.ACTION_FIRE) return
        val id = intent.getStringExtra(ReminderScheduler.EXTRA_ID) ?: return
        val pending = goAsync()
        Thread {
            try {
                val reminder = ReminderScheduler.find(context, id)
                if (reminder != null && reminder.enabled) ReminderNotifier.show(context, reminder)
                ReminderScheduler.scheduleAll(context)
                WidgetUpdater.updateAll(context)
                WidgetUpdater.scheduleNextTick(context)
            } finally {
                pending.finish()
            }
        }.start()
    }
}
