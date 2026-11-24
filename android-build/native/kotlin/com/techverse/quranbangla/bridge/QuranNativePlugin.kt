package com.techverse.quranbangla.bridge

import android.app.AlarmManager
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.core.QuranAssets
import com.techverse.quranbangla.db.AppDatabase
import com.techverse.quranbangla.reminders.Reminder
import com.techverse.quranbangla.reminders.ReminderScheduler
import com.techverse.quranbangla.widgets.WidgetUpdater
import java.io.File

/**
 * The typed bridge between the web app (TypeScript: js/quran-native.js, src/native/quran-native.ts) and Kotlin.
 * The contract is declared once, in src/native/quran-native.ts, and tests/native-bridge.test.js checks that every method
 * declared there exists here under the same name.
 *
 * Capacitor runs plugin methods on a background thread, so Room (which refuses main-thread queries) can be used directly.
 */
@CapacitorPlugin(name = "QuranNative")
class QuranNativePlugin : Plugin() {
    private companion object {
        const val BRIDGE_VERSION = 1
        const val MAX_STATE_CHARS = 100_000
    }

    // ------------------------------------------------------------------------------------------------ capabilities
    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        val ctx = context
        val power = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        val installed = JSObject()
        for ((key, count) in WidgetUpdater.installed(ctx)) installed.put(key, count)
        val modules = JSObject()
            .put("widgets", true)
            .put("reminders", true)
            .put("prayer", true)
            .put("database", true)
            .put("downloads", false)
            .put("audio", false)
        call.resolve(
            JSObject()
                .put("version", BRIDGE_VERSION)
                .put("sdk", Build.VERSION.SDK_INT)
                .put("modules", modules)
                .put("exactAlarms", ReminderScheduler.canScheduleExact(ctx))
                .put("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
                .put("ignoringBatteryOptimizations", power.isIgnoringBatteryOptimizations(ctx.packageName))
                .put("quranDataBundled", QuranAssets.hasEdition(ctx, "quran-uthmani"))
                .put("pinWidgetSupported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && AppWidgetManager.getInstance(ctx).isRequestPinAppWidgetSupported)
                .put("widgetsInstalled", installed)
        )
    }

    // ------------------------------------------------------------------------------------------------ app state
    /** The web app pushes a small snapshot (last read, prayer location, goals, language). Widgets and alarms read it. */
    @PluginMethod
    fun syncState(call: PluginCall) {
        val state = call.getObject("state")
        if (state == null) {
            call.reject("state is required")
            return
        }
        if (state.toString().length > MAX_STATE_CHARS) {
            call.reject("state is too large")
            return
        }
        val ctx = context
        NativeStore.of(ctx).saveState(state)
        ReminderScheduler.scheduleAll(ctx) // the prayer location or method may have changed
        val updated = WidgetUpdater.updateAll(ctx)
        WidgetUpdater.scheduleNextTick(ctx)
        call.resolve(JSObject().put("ok", true).put("widgetsUpdated", updated))
    }

    // ------------------------------------------------------------------------------------------------ reminders
    @PluginMethod
    fun getReminders(call: PluginCall) {
        val arr = JSArray()
        for (r in ReminderScheduler.load(context)) arr.put(r.toJson())
        call.resolve(JSObject().put("reminders", arr))
    }

    @PluginMethod
    fun setReminders(call: PluginCall) {
        val list = call.getArray("reminders")
        if (list == null) {
            call.reject("reminders is required")
            return
        }
        val ctx = context
        val parsed = Reminder.parseAll(list)
        ReminderScheduler.save(ctx, parsed.first)
        val planned = ReminderScheduler.scheduleAll(ctx)
        WidgetUpdater.updateAll(ctx)
        WidgetUpdater.scheduleNextTick(ctx)
        call.resolve(report(planned, parsed.second))
    }

    @PluginMethod
    fun describeSchedule(call: PluginCall) {
        call.resolve(report(ReminderScheduler.plan(context), emptyList()))
    }

    private fun report(planned: List<ReminderScheduler.Planned>, refused: List<Int>): JSObject {
        val next = JSArray()
        for (p in planned) next.put(JSObject().put("id", p.reminder.id).put("at", p.triggerAt))
        val refusedArray = JSArray()
        for (i in refused) refusedArray.put(i)
        return JSObject()
            .put("scheduled", planned.size)
            .put("next", next)
            .put("refused", refusedArray)
            .put("exactAlarms", ReminderScheduler.canScheduleExact(context))
    }

    // ------------------------------------------------------------------------------------------------ widgets
    @PluginMethod
    fun refreshWidgets(call: PluginCall) {
        val updated = WidgetUpdater.updateAll(context)
        WidgetUpdater.scheduleNextTick(context)
        call.resolve(JSObject().put("updated", updated))
    }

    /** Asks the launcher to add a widget (Android 8+); the user confirms in a system dialog. */
    @PluginMethod
    fun requestPinWidget(call: PluginCall) {
        val key = call.getString("widget") ?: ""
        val cls = WidgetUpdater.classFor(key)
        if (cls == null) {
            call.reject("unknown widget: $key")
            return
        }
        var supported = false
        var requested = false
        // pinning needs Android 8+; the checks are written as plain if-blocks so Android Lint sees the API level guard
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = AppWidgetManager.getInstance(context)
            if (manager.isRequestPinAppWidgetSupported) {
                supported = true
                requested = manager.requestPinAppWidget(ComponentName(context, cls), null, null)
            }
        }
        call.resolve(JSObject().put("supported", supported).put("requested", requested))
    }

    // ------------------------------------------------------------------------------------------------ system settings
    /** screen: exact-alarms | notifications | battery | app. Opens the matching Android settings page. */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        val screen = call.getString("screen") ?: ""
        val pkg = context.packageName
        val intent: Intent? = when (screen) {
            "exact-alarms" ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$pkg")) else null
            "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "app" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
            else -> null
        }
        if (intent == null) {
            call.resolve(JSObject().put("opened", false))
            return
        }
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve(JSObject().put("opened", true))
        } catch (e: Exception) {
            call.resolve(JSObject().put("opened", false))
        }
    }

    // ------------------------------------------------------------------------------------------------ storage + database
    @PluginMethod
    fun getStorageInfo(call: PluginCall) {
        val ctx = context
        val stat = StatFs(ctx.filesDir.path)
        val dirs = ArrayList<File>()
        dirs.add(ctx.filesDir)
        dirs.add(ctx.cacheDir)
        ctx.getExternalFilesDir(null)?.let { dirs.add(it) }
        var used = 0L
        for (d in dirs) used += sizeOf(d)
        call.resolve(
            JSObject()
                .put("appBytes", used)
                .put("freeBytes", stat.availableBytes)
                .put("totalBytes", stat.totalBytes)
        )
    }

    private fun sizeOf(file: File): Long {
        if (file.isFile) return file.length()
        var sum = 0L
        file.listFiles()?.forEach { sum += sizeOf(it) }
        return sum
    }

    /** Opens the Room database and reports its version and row counts - a quick proof that it works on this device. */
    @PluginMethod
    fun getDatabaseInfo(call: PluginCall) {
        try {
            val db = AppDatabase.get(context)
            val version = db.openHelper.readableDatabase.version
            call.resolve(
                JSObject()
                    .put("version", version)
                    .put("counts", JSObject()
                        .put("readingHistory", db.readingHistory().count())
                        .put("bookmarks", db.bookmarks().count())
                        .put("notes", db.notes().count())
                        .put("listeningHistory", db.listeningHistory().count())
                        .put("downloads", db.downloads().count())
                        .put("learningProgress", db.learningProgress().count())
                        .put("keyValue", db.keyValue().count()))
            )
        } catch (e: Exception) {
            call.reject("database error: " + (e.message ?: e.javaClass.simpleName))
        }
    }
}
