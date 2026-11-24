package com.techverse.quranbangla.widgets

import android.content.Context
import android.os.Bundle
import android.widget.RemoteViews
import com.techverse.quranbangla.core.Deeplinks
import com.techverse.quranbangla.core.NativeStore
import __APP_ID__.R

/** Widget D - quick actions: Quran, Search, Qibla, Tasbih. Each button is a quranbangla:// deep link into the right screen. */
class QuickActionsWidget : BaseWidgetProvider() {
    override val layoutId: Int get() = R.layout.qw_widget_quick

    override fun build(context: Context, widgetId: Int, options: Bundle): RemoteViews {
        val views = RemoteViews(context.packageName, layoutId)
        val labels = Labels.of(NativeStore.of(context).state())
        views.setTextViewText(R.id.qw_quick_quran_label, labels.quran)
        views.setTextViewText(R.id.qw_quick_search_label, labels.search)
        views.setTextViewText(R.id.qw_quick_qibla_label, labels.qibla)
        views.setTextViewText(R.id.qw_quick_tasbih_label, labels.tasbih)
        views.setOnClickPendingIntent(R.id.qw_quick_quran, Deeplinks.pending(context, Deeplinks.screen("quran")))
        views.setOnClickPendingIntent(R.id.qw_quick_search, Deeplinks.pending(context, Deeplinks.screen("search")))
        views.setOnClickPendingIntent(R.id.qw_quick_qibla, Deeplinks.pending(context, Deeplinks.screen("qibla")))
        views.setOnClickPendingIntent(R.id.qw_quick_tasbih, Deeplinks.pending(context, Deeplinks.screen("tasbih")))
        return views
    }
}
