package com.techverse.quranbangla.widgets

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.os.Bundle
import android.widget.RemoteViews
import com.techverse.quranbangla.core.Deeplinks
import __APP_ID__.R

/**
 * Common behaviour of the five home screen widgets. Widgets are drawn by the launcher from RemoteViews, so they cannot run
 * code of their own; they are refreshed (never polled) by: the system on add / resize, an alarm at the next prayer time and
 * at midnight (WidgetTickReceiver), and the app after it pushed new data (QuranNativePlugin). Everything is read from local
 * storage - no network is needed.
 */
abstract class BaseWidgetProvider : AppWidgetProvider() {
    protected abstract val layoutId: Int

    /** The content of one widget instance. Sizes are in options (AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH / MIN_HEIGHT, dp). */
    protected abstract fun build(context: Context, widgetId: Int, options: Bundle): RemoteViews

    fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) {
            val views = try {
                build(context, id, manager.getAppWidgetOptions(id))
            } catch (e: Exception) {
                fallback(context)
            }
            manager.updateAppWidget(id, views)
        }
    }

    /** Never a blank or crashing widget: an empty card that still opens the app. */
    private fun fallback(context: Context): RemoteViews {
        val views = RemoteViews(context.packageName, layoutId)
        views.setOnClickPendingIntent(R.id.qw_root, Deeplinks.pending(context, Deeplinks.screen("home")))
        return views
    }

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        update(context, appWidgetManager, appWidgetIds)
        WidgetUpdater.scheduleNextTick(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle) {
        update(context, appWidgetManager, intArrayOf(appWidgetId))
    }

    override fun onEnabled(context: Context) {
        WidgetUpdater.scheduleNextTick(context)
    }

    override fun onDisabled(context: Context) {
        WidgetUpdater.scheduleNextTick(context) // cancels the tick when no widget of any kind is left
    }

    protected fun heightDp(options: Bundle): Int = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110)
    protected fun widthDp(options: Bundle): Int = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180)
}
