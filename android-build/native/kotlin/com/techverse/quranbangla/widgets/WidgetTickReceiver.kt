package com.techverse.quranbangla.widgets

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** The widget alarm fired (a prayer time or midnight passed): redraw and plan the next one. */
class WidgetTickReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != WidgetUpdater.ACTION_TICK) return
        WidgetUpdater.updateAll(context)
        WidgetUpdater.scheduleNextTick(context)
    }
}
