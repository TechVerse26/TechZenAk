package com.techverse.quranbangla.db

import androidx.room.migration.Migration

/**
 * Schema migrations, oldest first. Empty while the database is at version 1.
 *
 * Example for the day version 2 is needed (a new nullable column):
 *   val MIGRATION_1_2 = object : Migration(1, 2) {
 *       override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
 *           db.execSQL("ALTER TABLE bookmarks ADD COLUMN color TEXT")
 *       }
 *   }
 * ... then list it in ALL, raise @Database(version) and keep the exported schemas/1.json and schemas/2.json.
 */
object Migrations {
    val ALL: Array<Migration> = arrayOf()
}
