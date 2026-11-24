package com.techverse.quranbangla.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

// Local, offline-first copies of the user's data and the metadata of downloaded files. The web app (IndexedDB / Firestore)
// stays the owner of bookmarks and notes; syncState tells the sync layer what still has to be sent (0 = synced, 1 = pending).

@Entity(tableName = "reading_history", indices = [Index("openedAt")])
data class ReadingHistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val surah: Int,
    val ayah: Int,
    val openedAt: Long,
    val durationSec: Int = 0
)

@Entity(tableName = "bookmarks", indices = [Index(value = ["surah", "ayah"], unique = true)])
data class BookmarkEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val surah: Int,
    val ayah: Int,
    val label: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
    val syncState: Int = 1
)

@Entity(tableName = "notes", indices = [Index(value = ["surah", "ayah"])])
data class NoteEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val surah: Int,
    val ayah: Int,
    val text: String,
    val createdAt: Long,
    val updatedAt: Long,
    val syncState: Int = 1
)

@Entity(tableName = "listening_history", indices = [Index("playedAt")])
data class ListeningHistoryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val reciterId: String,
    val surah: Int,
    val ayah: Int = 0,
    val positionMs: Long = 0,
    val durationMs: Long = 0,
    val playedAt: Long
)

/** One file in the download manager. `state` is one of QUEUED, RUNNING, PAUSED, COMPLETED, FAILED, CANCELLED. */
@Entity(tableName = "downloads", indices = [Index("state"), Index("kind")])
data class DownloadEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val title: String,
    val url: String,
    val relativePath: String,
    val bytesTotal: Long = 0,
    val bytesDone: Long = 0,
    val state: String = "QUEUED",
    val sha256: String? = null,
    val priority: Int = 0,
    val error: String? = null,
    val createdAt: Long,
    val updatedAt: Long
)

@Entity(tableName = "learning_progress")
data class LearningProgressEntity(
    @PrimaryKey val courseId: String,
    val lessonId: String? = null,
    val percent: Int = 0,
    val updatedAt: Long
)

@Entity(tableName = "key_value")
data class KeyValueEntity(
    @PrimaryKey val key: String,
    val value: String,
    val updatedAt: Long
)
