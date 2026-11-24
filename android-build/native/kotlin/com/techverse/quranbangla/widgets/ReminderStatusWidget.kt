package com.techverse.quranbangla.widgets

import android.content.Context
import android.os.Bundle
import android.widget.RemoteViews
import com.techverse.quranbangla.core.Deeplinks
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.core.boolOrDefault
import com.techverse.quranbangla.core.intOrDefault
import com.techverse.quranbangla.core.objectOrNull
import com.techverse.quranbangla.core.stringOrNull
import com.techverse.quranbangla.reminders.ReminderScheduler
import __APP_ID__.R

/**
 * Widget E - Islamic reminder: the reading plan (the app's "planner": title, completed days of days), whether today is marked,
 * the reading streak, and when the next reminder will fire. The data comes from the app through the bridge (js/native-sync.js).
 */
class ReminderStatusWidget : BaseWidgetProvider() {
    override val layoutId: Int get() = R.layout.qw_widget_reminder

    override fun build(context: Context, widgetId: Int, options: Bundle): RemoteViews {
        val views = RemoteViews(context.packageName, layoutId)
        val state = NativeStore.of(context).state()
        val labels = Labels.of(state)
        val goals = state.objectOrNull("goals")
        val plan = goals?.objectOrNull("plan")
        val days = plan?.intOrDefault("days", 0) ?: 0
        val done = plan?.intOrDefault("completedDays", 0) ?: 0
        val streak = goals?.intOrDefault("streak", 0) ?: 0
        val markedToday = plan?.boolOrDefault("markedToday", false) ?: false

        views.setTextViewText(R.id.qw_label, labels.readingPlan)
        if (plan != null && days > 0) {
            val title = plan.stringOrNull("title") ?: labels.readingPlan
            views.setTextViewText(R.id.qw_goal_text, labels.digits("$title • $done/$days ${labels.daysUnit}"))
            views.setProgressBar(R.id.qw_goal_progress, 100, (done * 100 / days).coerceIn(0, 100), false)
        } else {
            views.setTextViewText(R.id.qw_goal_text, labels.noGoal)
            views.setProgressBar(R.id.qw_goal_progress, 100, 0, false)
        }
        val today = if (plan != null && days > 0) " • " + (if (markedToday) labels.doneToday else labels.notDoneToday) else ""
        views.setTextViewText(R.id.qw_streak, labels.digits("${labels.streak}: $streak") + today)

        val next = ReminderScheduler.nextPlanned(context)
        views.setTextViewText(R.id.qw_reminder, if (next != null) "${labels.nextReminder}: ${next.reminder.title} • ${labels.time(context, next.triggerAt)}" else labels.remindersOff)
        views.setOnClickPendingIntent(R.id.qw_root, Deeplinks.pending(context, Deeplinks.screen("planner")))
        return views
    }
}
