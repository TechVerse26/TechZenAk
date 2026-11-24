package com.techverse.quranbangla.widgets

import android.content.Context
import android.os.Bundle
import android.widget.RemoteViews
import com.techverse.quranbangla.core.Deeplinks
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.core.QuranAssets
import com.techverse.quranbangla.core.SurahData
import com.techverse.quranbangla.core.intOrDefault
import com.techverse.quranbangla.core.objectOrNull
import __APP_ID__.R

/** Widget C - continue reading: last read surah and ayah, how much of the Quran has been read, and a Continue button. */
class ContinueReadingWidget : BaseWidgetProvider() {
    override val layoutId: Int get() = R.layout.qw_widget_continue

    override fun build(context: Context, widgetId: Int, options: Bundle): RemoteViews {
        val views = RemoteViews(context.packageName, layoutId)
        val state = NativeStore.of(context).state()
        val labels = Labels.of(state)
        views.setTextViewText(R.id.qw_label, labels.continueReading)
        views.setTextViewText(R.id.qw_action, labels.resume)

        val last = state.objectOrNull("lastRead")
        val surah = last?.intOrDefault("surah", 0) ?: 0
        val ayah = last?.intOrDefault("ayah", 0) ?: 0
        val read = (state.objectOrNull("goals")?.intOrDefault("ayahsRead", 0) ?: 0).coerceIn(0, TOTAL_AYAHS)
        val percent = read * 100 / TOTAL_AYAHS

        if (surah in 1..114 && ayah >= 1) {
            val name = if (labels.bangla) SurahData.NAMES_BN[surah - 1] else (QuranAssets.surahName(context, surah)?.second ?: "")
            views.setTextViewText(R.id.qw_surah, "${labels.surah} $name")
            views.setTextViewText(R.id.qw_detail, labels.digits("${labels.ayah} $ayah • $surah:$ayah"))
            views.setOnClickPendingIntent(R.id.qw_root, Deeplinks.pending(context, Deeplinks.screen("continue")))
            views.setOnClickPendingIntent(R.id.qw_action, Deeplinks.pending(context, Deeplinks.screen("continue")))
        } else {
            views.setTextViewText(R.id.qw_surah, labels.startReading)
            views.setTextViewText(R.id.qw_detail, "")
            views.setOnClickPendingIntent(R.id.qw_root, Deeplinks.pending(context, Deeplinks.screen("quran")))
            views.setOnClickPendingIntent(R.id.qw_action, Deeplinks.pending(context, Deeplinks.screen("quran")))
        }
        views.setProgressBar(R.id.qw_progress, 100, percent, false)
        views.setTextViewText(R.id.qw_percent, labels.digits("$percent% ${labels.ofQuran} ($read/$TOTAL_AYAHS)"))
        return views
    }

    private companion object {
        const val TOTAL_AYAHS = 6236
    }
}
