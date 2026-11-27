package com.techverse.quranbangla.bridge

import android.Manifest
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
import com.getcapacitor.PermissionState
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.core.QuranAssets
import com.techverse.quranbangla.db.AppDatabase
import com.techverse.quranbangla.reminders.Reminder
import com.techverse.quranbangla.reminders.ReminderScheduler
import com.techverse.quranbangla.widgets.WidgetUpdater
import java.io.File

/** Capacitor permission alias of POST_NOTIFICATIONS (a top-level constant: annotation arguments must be compile-time constants). */
private const val NOTIFICATIONS = "notifications"

/**
 * The typed bridge between the web app (TypeScript: js/quran-native.js, src/native/quran-native.ts) and Kotlin.
 * The contract is declared once, in src/native/quran-native.ts, and tests/native-bridge.test.js checks that every method
 * declared there exists here under the same name.
 *
 * Capacitor runs plugin methods on a background thread, so Room (which refuses main-thread queries) can be used directly.
 */
@CapacitorPlugin(
    name = "QuranNative",
    // Android 13+ (API 33): notifications need a run-time permission. The alias is what requestPermissionForAlias() asks for.
    permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = NOTIFICATIONS)]
)
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

    // ------------------------------------------------------------------------------------------------ notification permission
    /** The notification permission as the phone sees it right now (it can change while the app is open, in the system settings). */
    @PluginMethod
    fun getNotificationPermission(call: PluginCall) {
        call.resolve(notificationState())
    }

    /**
     * Android 13+ shows the system dialog (the system shows it at most twice; after that the answer is "denied" at once and only
     * the system settings can help - the web app then opens them with openSettings("notifications")). Older Android allows
     * notifications by default, so the answer comes back immediately.
     */
    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            call.resolve(notificationState())
            return
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionResult")
    }

    /** Called by Capacitor after the system dialog was answered. Public on purpose: Capacitor finds it by name. */
    @PermissionCallback
    fun notificationPermissionResult(call: PluginCall) {
        call.resolve(notificationState())
    }

    private fun notificationState(): JSObject {
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val needsRuntime = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        val runtime = if (needsRuntime) (getPermissionState(NOTIFICATIONS)?.toString() ?: "prompt") else "granted"
        // "granted" means notifications really can be shown: the permission AND the switch in the system settings
        val state = if (enabled) "granted" else if (runtime == "granted") "denied" else runtime
        return JSObject().put("granted", enabled).put("state", state).put("needsRuntimePermission", needsRuntime)
    }

    // ------------------------------------------------------------------------------------------------ system settings
    /**
     * screen: exact-alarms | notifications | battery | app. Opens the matching Android settings page; when this phone has no such
     * page the app's own settings page is opened instead, so the person is never left with a button that does nothing.
     */
    @PluginMethod
    fun openSettings(call: PluginCall) {
        val screen = call.getString("screen") ?: ""
        val pkg = context.packageName
        val packageUri = Uri.parse("package:$pkg")
        val appDetails = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri)
        val candidates = ArrayList<Intent>()
        when (screen) {
            "exact-alarms" -> {
                // "Alarms & reminders" of this app (Android 12+; the permission SCHEDULE_EXACT_ALARM must be in the manifest)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) candidates.add(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, packageUri))
                candidates.add(appDetails)
            }
            "notifications" -> {
                candidates.add(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg))
                candidates.add(appDetails)
            }
            "battery" -> {
                candidates.add(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                candidates.add(appDetails)
            }
            "app" -> candidates.add(appDetails)
        }
        for (intent in candidates) {
            if (startSettings(intent)) {
                call.resolve(JSObject().put("opened", true))
                return
            }
        }
        call.resolve(JSObject().put("opened", false))
    }

    /** Starts a settings page inside the app's own task (the back button returns to the app). */
    private fun startSettings(intent: Intent): Boolean {
        return try {
            val host = activity
            if (host != null) {
                host.startActivity(intent)
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
            true
        } catch (e: Exception) {
            false
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
