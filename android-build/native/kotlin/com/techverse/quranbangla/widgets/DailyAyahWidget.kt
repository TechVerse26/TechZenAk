package com.techverse.quranbangla.widgets

import android.content.Context
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import com.techverse.quranbangla.core.DailyAyah
import com.techverse.quranbangla.core.Deeplinks
import com.techverse.quranbangla.core.NativeStore
import com.techverse.quranbangla.core.QuranAssets
import com.techverse.quranbangla.core.SurahData
import com.techverse.quranbangla.core.stringOrNull
import java.util.Calendar
import __APP_ID__.R

/** Widget B - the ayah of the day (the same one the app shows on its home card), Arabic + translation + reference. */
class DailyAyahWidget : BaseWidgetProvider() {
    override val layoutId: Int get() = R.layout.qw_widget_daily_ayah

    override fun build(context: Context, widgetId: Int, options: Bundle): RemoteViews {
        val views = RemoteViews(context.packageName, layoutId)
        val state = NativeStore.of(context).state()
        val labels = Labels.of(state)
        views.setTextViewText(R.id.qw_label, labels.dailyAyah)

        val c = Calendar.getInstance()
        val edition = state.stringOrNull("translationEdition") ?: "bn.bengali"
        val pick = DailyAyah.pick(context, edition, c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
        if (pick == null) {
            views.setTextViewText(R.id.qw_arabic, "")
            views.setTextViewText(R.id.qw_translation, labels.openApp)
            views.setTextViewText(R.id.qw_reference, "")
            views.setOnClickPendingIntent(R.id.qw_root, Deeplinks.pending(context, Deeplinks.screen("home")))
            return views
        }

        views.setTextViewText(R.id.qw_arabic, pick.arabic)
        val translation = pick.translation
        views.setTextViewText(R.id.qw_translation, translation ?: "")
        // the default size (4x3) shows Arabic + translation + reference; a widget made shorter than ~130dp keeps only the Arabic
        views.setViewVisibility(R.id.qw_translation, if (translation == null || heightDp(options) < 130) View.GONE else View.VISIBLE)

        val surahName = if (labels.bangla) SurahData.NAMES_BN[pick.surah - 1] else (QuranAssets.surahName(context, pick.surah)?.second ?: "")
        views.setTextViewText(R.id.qw_reference, labels.digits("${labels.surah} $surahName • ${pick.surah}:${pick.ayah}"))
        views.setOnClickPendingIntent(R.id.qw_root, Deeplinks.pending(context, Deeplinks.ayah(pick.surah, pick.ayah)))
        return views
    }
}
