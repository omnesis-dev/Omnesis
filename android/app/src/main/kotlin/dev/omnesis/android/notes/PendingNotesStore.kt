// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.time.Duration
import java.time.Instant
import java.util.UUID

/**
 * One captured note waiting for a reachable gateway. [capturedAt] is the
 * original capture time (ISO 8601). [noteId] is the client-generated UUID sent
 * as the gateway's idempotency key — persisted with the row so a drain retried
 * after process death reuses it and can't create a duplicate entry.
 */
data class PendingNote(
    val id: Long,
    val noteId: String,
    val text: String,
    val capturedAt: String,
    val surface: String,
    /** Last failed gateway delivery attempt, or null when captured while unpaired. */
    val lastAttemptAt: String? = null,
    /** Sanitized, user-safe reason for the most recent delivery failure. */
    val lastFailure: String? = null,
    /** Failed redelivery attempts after the note first entered the queue. */
    val retryCount: Int = 0,
    /**
     * The audio the note was dictated from, delivered with it for the gateway to
     * transcribe; null for a typed note. [text] is then the phone's transcript, possibly
     * empty.
     */
    val audio: VoiceNoteAudio? = null,
    /** The device language tag recorded with a voice note, for the transcriber's hint. */
    val language: String? = null,
)

/** A queued note warrants operator attention after one failed retry or five minutes. */
internal fun pendingNoteNeedsAttention(note: PendingNote, now: Instant = Instant.now()): Boolean {
    if (note.retryCount > 0) return true
    val captured = runCatching { Instant.parse(note.capturedAt) }.getOrNull() ?: return true
    return !captured.isAfter(now) && Duration.between(captured, now) >= PENDING_WARNING_AGE
}

internal const val PENDING_WARNING_AGE_MS = 300_000L // PARITY:tell-omnesis-pending-warning-ms
internal val PENDING_WARNING_AGE: Duration = Duration.ofMillis(PENDING_WARNING_AGE_MS)

/**
 * Durable local buffer for quick-capture notes that couldn't reach the gateway
 * (offline, gateway down). Hand-rolled `SQLiteOpenHelper`, matching
 * `ActivityTransitionBuffer` — this codebase has zero Room/DataStore usage, and
 * a captured thought must survive a process kill, so an in-memory queue or a
 * prefs blob is the wrong shape. Rows keep the original `capturedAt`, so a note
 * drained hours later still lands on the day/time it was spoken.
 *
 * `_id` (`AUTOINCREMENT`) is the drain order: oldest first, never reused.
 */
class PendingNotesStore(context: Context) {

    private val helper: SQLiteOpenHelper = object : SQLiteOpenHelper(context, DB_NAME, null, 4) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """CREATE TABLE $TABLE (
                    $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
                    $COL_NOTE_ID TEXT NOT NULL,
                    $COL_TEXT TEXT NOT NULL,
                    $COL_CAPTURED_AT TEXT NOT NULL,
                    $COL_SURFACE TEXT NOT NULL,
                    $COL_LAST_ATTEMPT_AT TEXT,
                    $COL_LAST_FAILURE TEXT,
                    $COL_RETRY_COUNT INTEGER NOT NULL DEFAULT 0,
                    $COL_AUDIO_PATH TEXT,
                    $COL_AUDIO_MIME TEXT,
                    $COL_LANGUAGE TEXT
                )""",
            )
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) {
                // v1 rows predate the idempotency key: add the column and
                // backfill each row with a fresh UUID (stable from here on).
                db.execSQL("ALTER TABLE $TABLE ADD COLUMN $COL_NOTE_ID TEXT NOT NULL DEFAULT ''")
                db.query(TABLE, arrayOf(COL_ID), "$COL_NOTE_ID = ''", null, null, null, null).use { cursor ->
                    while (cursor.moveToNext()) {
                        val rowId = cursor.getLong(0)
                        db.execSQL(
                            "UPDATE $TABLE SET $COL_NOTE_ID = ? WHERE $COL_ID = ?",
                            arrayOf(UUID.randomUUID().toString(), rowId.toString()),
                        )
                    }
                }
            }
            if (oldVersion < 3) {
                db.execSQL("ALTER TABLE $TABLE ADD COLUMN $COL_LAST_ATTEMPT_AT TEXT")
                db.execSQL("ALTER TABLE $TABLE ADD COLUMN $COL_LAST_FAILURE TEXT")
                db.execSQL("ALTER TABLE $TABLE ADD COLUMN $COL_RETRY_COUNT INTEGER NOT NULL DEFAULT 0")
            }
            if (oldVersion < 4) {
                db.execSQL("ALTER TABLE $TABLE ADD COLUMN $COL_AUDIO_PATH TEXT")
                db.execSQL("ALTER TABLE $TABLE ADD COLUMN $COL_AUDIO_MIME TEXT")
                db.execSQL("ALTER TABLE $TABLE ADD COLUMN $COL_LANGUAGE TEXT")
            }
        }
    }

    suspend fun insert(
        noteId: String,
        text: String,
        capturedAt: String,
        surface: String,
        lastAttemptAt: String? = null,
        lastFailure: String? = null,
        audio: VoiceNoteAudio? = null,
        language: String? = null,
    ): Unit =
        withContext(Dispatchers.IO) {
            val values = ContentValues().apply {
                put(COL_NOTE_ID, noteId)
                put(COL_TEXT, text)
                put(COL_CAPTURED_AT, capturedAt)
                put(COL_SURFACE, surface)
                put(COL_LAST_ATTEMPT_AT, lastAttemptAt)
                put(COL_LAST_FAILURE, lastFailure)
                put(COL_AUDIO_PATH, audio?.file?.absolutePath)
                put(COL_AUDIO_MIME, audio?.mimeType)
                put(COL_LANGUAGE, language)
            }
            helper.writableDatabase.insertOrThrow(TABLE, null, values)
            Unit
        }

    /** Every buffered note, oldest first. */
    suspend fun readAll(): List<PendingNote> = withContext(Dispatchers.IO) {
        val rows = mutableListOf<PendingNote>()
        helper.readableDatabase.query(
            TABLE,
            arrayOf(
                COL_ID,
                COL_NOTE_ID,
                COL_TEXT,
                COL_CAPTURED_AT,
                COL_SURFACE,
                COL_LAST_ATTEMPT_AT,
                COL_LAST_FAILURE,
                COL_RETRY_COUNT,
                COL_AUDIO_PATH,
                COL_AUDIO_MIME,
                COL_LANGUAGE,
            ),
            null,
            null,
            null,
            null,
            "$COL_ID ASC",
        ).use { cursor ->
            val idIdx = cursor.getColumnIndexOrThrow(COL_ID)
            val noteIdIdx = cursor.getColumnIndexOrThrow(COL_NOTE_ID)
            val textIdx = cursor.getColumnIndexOrThrow(COL_TEXT)
            val capturedIdx = cursor.getColumnIndexOrThrow(COL_CAPTURED_AT)
            val surfaceIdx = cursor.getColumnIndexOrThrow(COL_SURFACE)
            val attemptIdx = cursor.getColumnIndexOrThrow(COL_LAST_ATTEMPT_AT)
            val failureIdx = cursor.getColumnIndexOrThrow(COL_LAST_FAILURE)
            val retryIdx = cursor.getColumnIndexOrThrow(COL_RETRY_COUNT)
            val audioIdx = cursor.getColumnIndexOrThrow(COL_AUDIO_PATH)
            val mimeIdx = cursor.getColumnIndexOrThrow(COL_AUDIO_MIME)
            val languageIdx = cursor.getColumnIndexOrThrow(COL_LANGUAGE)
            while (cursor.moveToNext()) {
                rows += PendingNote(
                    id = cursor.getLong(idIdx),
                    noteId = cursor.getString(noteIdIdx),
                    text = cursor.getString(textIdx),
                    capturedAt = cursor.getString(capturedIdx),
                    surface = cursor.getString(surfaceIdx),
                    lastAttemptAt = if (cursor.isNull(attemptIdx)) null else cursor.getString(attemptIdx),
                    lastFailure = if (cursor.isNull(failureIdx)) null else cursor.getString(failureIdx),
                    retryCount = cursor.getInt(retryIdx),
                    audio = if (cursor.isNull(audioIdx) || cursor.isNull(mimeIdx)) {
                        null
                    } else {
                        VoiceNoteAudio(File(cursor.getString(audioIdx)), cursor.getString(mimeIdx))
                    },
                    language = if (cursor.isNull(languageIdx)) null else cursor.getString(languageIdx),
                )
            }
        }
        rows
    }

    /** Records a failed redelivery without exposing transport details or response bodies. */
    suspend fun recordRetryFailure(id: Long, attemptedAt: String, reason: String): Unit =
        withContext(Dispatchers.IO) {
            helper.writableDatabase.execSQL(
                """UPDATE $TABLE
                   SET $COL_LAST_ATTEMPT_AT = ?, $COL_LAST_FAILURE = ?,
                       $COL_RETRY_COUNT = $COL_RETRY_COUNT + 1
                   WHERE $COL_ID = ?""",
                arrayOf<Any>(attemptedAt, reason, id),
            )
        }

    /**
     * Keeps a voice note as a plain text note: its audio was refused (the gateway cannot
     * transcribe voice notes) and has been deleted, so later drains send the text alone.
     */
    suspend fun dropAudio(id: Long): Unit = withContext(Dispatchers.IO) {
        helper.writableDatabase.execSQL(
            "UPDATE $TABLE SET $COL_AUDIO_PATH = NULL, $COL_AUDIO_MIME = NULL WHERE $COL_ID = ?",
            arrayOf<Any>(id),
        )
    }

    /** Deletes one drained (or user-discarded) note. */
    suspend fun delete(id: Long): Unit = withContext(Dispatchers.IO) {
        helper.writableDatabase.delete(TABLE, "$COL_ID = ?", arrayOf(id.toString()))
        Unit
    }

    private companion object {
        const val DB_NAME = "omnesis_pending_notes.db"
        const val TABLE = "pending_notes"
        const val COL_ID = "_id"
        const val COL_NOTE_ID = "note_id"
        const val COL_TEXT = "text"
        const val COL_CAPTURED_AT = "captured_at"
        const val COL_SURFACE = "surface"
        const val COL_LAST_ATTEMPT_AT = "last_attempt_at"
        const val COL_LAST_FAILURE = "last_failure"
        const val COL_RETRY_COUNT = "retry_count"
        const val COL_AUDIO_PATH = "audio_path"
        const val COL_AUDIO_MIME = "audio_mime"
        const val COL_LANGUAGE = "language"
    }
}
