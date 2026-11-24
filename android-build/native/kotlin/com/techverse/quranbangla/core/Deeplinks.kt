package com.techverse.quranbangla.core

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * quranbangla:// links. The app already routes them (app/js/notifications.js, QRApp.deeplink): a screen name
 * (home, quran, search, qibla, prayer, continue, planner, ...) or ?surah=&ayah= to open the reader at an ayah.
 */
object Deeplinks {
    const val SCHEME = "quranbangla"

    fun screen(name: String): String = "$SCHEME://$name"

    fun ayah(surah: Int, ayah: Int): String = "$SCHEME://ayah?surah=$surah&ayah=$ayah"

    /** Only links of our own scheme are ever opened from a widget, a notification or the bridge. */
    fun isOurs(link: String?): Boolean = link != null && link.startsWith("$SCHEME://") && link.length <= 200

    fun pending(context: Context, link: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(if (isOurs(link)) link else screen("home")))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, link.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
