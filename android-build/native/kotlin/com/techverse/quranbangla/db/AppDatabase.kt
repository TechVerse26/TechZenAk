package com.techverse.quranbangla.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * The native Room (SQLite) database. Version 1 holds everything the native features need now - including the tables of the
 * download manager and the listening history, so those features arrive without a schema change.
 *
 * Changing a table: bump `version`, add a Migration to Migrations.ALL (never destructive: user data must survive an update),
 * and commit the new schemas/<n>.json that the build exports (the workflow uploads them as an artifact).
 */
@Database(
    entities = [
        ReadingHistoryEntity::class, BookmarkEntity::class, NoteEntity::class, ListeningHistoryEntity::class,
        DownloadEntity::class, LearningProgressEntity::class, KeyValueEntity::class
    ],
    version = 1,
    exportSchema = true
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun readingHistory(): ReadingHistoryDao
    abstract fun bookmarks(): BookmarkDao
    abstract fun notes(): NoteDao
    abstract fun listeningHistory(): ListeningHistoryDao
    abstract fun downloads(): DownloadDao
    abstract fun learningProgress(): LearningProgressDao
    abstract fun keyValue(): KeyValueDao

    companion object {
        const val FILE_NAME = "quranbangla.db"

        @Volatile
        private var instance: AppDatabase? = null

        /** Room refuses main-thread queries: call the DAOs from a background thread (the bridge already runs there). */
        fun get(context: Context): AppDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, FILE_NAME)
                    .addMigrations(*Migrations.ALL)
                    .build()
                    .also { instance = it }
            }
    }
}
