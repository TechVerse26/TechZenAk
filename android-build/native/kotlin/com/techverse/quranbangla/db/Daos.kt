package com.techverse.quranbangla.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update

@Dao
interface ReadingHistoryDao {
    @Insert
    fun insert(entry: ReadingHistoryEntity): Long

    @Query("SELECT * FROM reading_history ORDER BY openedAt DESC LIMIT :limit")
    fun latest(limit: Int): List<ReadingHistoryEntity>

    @Query("SELECT COUNT(*) FROM reading_history")
    fun count(): Int

    @Query("DELETE FROM reading_history WHERE openedAt < :before")
    fun deleteOlderThan(before: Long): Int
}

@Dao
interface BookmarkDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(bookmark: BookmarkEntity): Long

    @Query("SELECT * FROM bookmarks ORDER BY updatedAt DESC")
    fun all(): List<BookmarkEntity>

    @Query("SELECT * FROM bookmarks WHERE syncState = 1")
    fun pending(): List<BookmarkEntity>

    @Query("DELETE FROM bookmarks WHERE surah = :surah AND ayah = :ayah")
    fun delete(surah: Int, ayah: Int): Int

    @Query("SELECT COUNT(*) FROM bookmarks")
    fun count(): Int
}

@Dao
interface NoteDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(note: NoteEntity): Long

    @Query("SELECT * FROM notes WHERE surah = :surah AND ayah = :ayah ORDER BY updatedAt DESC")
    fun forAyah(surah: Int, ayah: Int): List<NoteEntity>

    @Query("SELECT * FROM notes WHERE syncState = 1")
    fun pending(): List<NoteEntity>

    @Query("SELECT COUNT(*) FROM notes")
    fun count(): Int
}

@Dao
interface ListeningHistoryDao {
    @Insert
    fun insert(entry: ListeningHistoryEntity): Long

    @Query("SELECT * FROM listening_history ORDER BY playedAt DESC LIMIT :limit")
    fun latest(limit: Int): List<ListeningHistoryEntity>

    @Query("SELECT COALESCE(SUM(durationMs), 0) FROM listening_history")
    fun totalListenedMs(): Long

    @Query("SELECT COUNT(*) FROM listening_history")
    fun count(): Int
}

@Dao
interface DownloadDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(item: DownloadEntity)

    @Update
    fun update(item: DownloadEntity): Int

    @Query("SELECT * FROM downloads WHERE id = :id")
    fun find(id: String): DownloadEntity?

    @Query("SELECT * FROM downloads ORDER BY priority DESC, createdAt ASC")
    fun all(): List<DownloadEntity>

    @Query("SELECT * FROM downloads WHERE state = :state ORDER BY priority DESC, createdAt ASC")
    fun withState(state: String): List<DownloadEntity>

    @Query("UPDATE downloads SET bytesDone = :done, bytesTotal = :total, state = :state, error = :error, updatedAt = :now WHERE id = :id")
    fun progress(id: String, done: Long, total: Long, state: String, error: String?, now: Long): Int

    @Query("DELETE FROM downloads WHERE id = :id")
    fun delete(id: String): Int

    @Query("SELECT COALESCE(SUM(bytesDone), 0) FROM downloads WHERE state = 'COMPLETED'")
    fun completedBytes(): Long

    @Query("SELECT COUNT(*) FROM downloads")
    fun count(): Int
}

@Dao
interface LearningProgressDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(progress: LearningProgressEntity)

    @Query("SELECT * FROM learning_progress")
    fun all(): List<LearningProgressEntity>

    @Query("SELECT COUNT(*) FROM learning_progress")
    fun count(): Int
}

@Dao
interface KeyValueDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(entry: KeyValueEntity)

    @Query("SELECT value FROM key_value WHERE `key` = :key")
    fun get(key: String): String?

    @Query("SELECT COUNT(*) FROM key_value")
    fun count(): Int
}
