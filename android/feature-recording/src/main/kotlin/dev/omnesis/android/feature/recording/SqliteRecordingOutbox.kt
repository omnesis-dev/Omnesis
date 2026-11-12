// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * [RecordingOutbox] over a small SQLite database, so a recording survives a
 * process kill. Chunk audio lives in files next to it ([RecordingFiles]); a
 * row names its file, and the file is deleted after the row leaves; a file
 * a kill leaves behind goes when its session's directory is swept or removed.
 */
class SqliteRecordingOutbox(context: Context, name: String? = DB_NAME) : RecordingOutbox {

    private val helper: SQLiteOpenHelper = object : SQLiteOpenHelper(context, name, null, 1) {
        override fun onConfigure(db: SQLiteDatabase) {
            db.setForeignKeyConstraintsEnabled(true)
        }

        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    started_at TEXT NOT NULL,
                    started_time_zone_id TEXT,
                    started_utc_offset_seconds INTEGER,
                    language TEXT,
                    chunk_count INTEGER,
                    ended_at TEXT,
                    created INTEGER NOT NULL DEFAULT 0,
                    finished INTEGER NOT NULL DEFAULT 0,
                    refusal TEXT,
                    chunks_filed INTEGER NOT NULL DEFAULT 0,
                    filed_until TEXT
                )""",
            )
            db.execSQL(
                """CREATE TABLE chunks (
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    seq INTEGER NOT NULL,
                    started_at TEXT NOT NULL,
                    duration_ms INTEGER NOT NULL,
                    silent INTEGER NOT NULL,
                    interrupted INTEGER NOT NULL,
                    path TEXT,
                    mime_type TEXT,
                    PRIMARY KEY (session_id, seq)
                )""",
            )
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    override suspend fun addSession(session: OutboxSession) = io {
        helper.writableDatabase.insertWithOnConflict(
            "sessions",
            null,
            ContentValues().apply {
                put("id", session.id)
                put("title", session.title)
                put("started_at", session.startedAt)
                put("started_time_zone_id", session.startedTimeZoneId)
                session.startedUtcOffsetSeconds?.let { put("started_utc_offset_seconds", it) }
                put("language", session.language)
                session.chunkCount?.let { put("chunk_count", it) }
                put("ended_at", session.endedAt)
                put("created", if (session.created) 1 else 0)
                put("finished", if (session.finished) 1 else 0)
                put("refusal", session.refusal)
                put("chunks_filed", session.chunksFiled)
                put("filed_until", session.filedUntil)
            },
            SQLiteDatabase.CONFLICT_IGNORE,
        )
        Unit
    }

    override suspend fun addChunk(chunk: OutboxChunk) = io {
        val db = helper.writableDatabase
        val endsAt = Instant.parse(chunk.startedAt).plusMillis(chunk.durationMs).toString()
        db.beginTransaction()
        try {
            insertChunk(db, chunk)
            db.execSQL(
                "UPDATE sessions SET chunks_filed = ?, filed_until = ? WHERE id = ? AND chunks_filed <= ?",
                arrayOf<Any>(chunk.seq + 1, endsAt, chunk.sessionId, chunk.seq),
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun insertChunk(db: SQLiteDatabase, chunk: OutboxChunk) {
        db.insertWithOnConflict(
            "chunks",
            null,
            ContentValues().apply {
                put("session_id", chunk.sessionId)
                put("seq", chunk.seq)
                put("started_at", chunk.startedAt)
                put("duration_ms", chunk.durationMs)
                put("silent", if (chunk.silent) 1 else 0)
                put("interrupted", if (chunk.interrupted) 1 else 0)
                put("path", chunk.file?.absolutePath)
                put("mime_type", chunk.mimeType)
            },
            SQLiteDatabase.CONFLICT_IGNORE,
        )
    }

    override suspend fun markStopped(sessionId: String, chunkCount: Int, endedAt: String) = io {
        update(sessionId, ContentValues().apply {
            put("chunk_count", chunkCount)
            put("ended_at", endedAt)
        })
    }

    override suspend fun sessions(): List<OutboxSession> = io {
        helper.readableDatabase.rawQuery("SELECT * FROM sessions ORDER BY started_at", null).use { c ->
            buildList { while (c.moveToNext()) add(c.toSession()) }
        }
    }

    override suspend fun pendingChunks(sessionId: String): List<OutboxChunk> = io {
        helper.readableDatabase
            .rawQuery("SELECT * FROM chunks WHERE session_id = ? ORDER BY seq", arrayOf(sessionId))
            .use { c -> buildList { while (c.moveToNext()) add(c.toChunk()) } }
    }

    override suspend fun setCreated(sessionId: String, created: Boolean) = io {
        update(sessionId, ContentValues().apply { put("created", if (created) 1 else 0) })
    }

    override suspend fun ackChunk(sessionId: String, seq: Int) = io {
        val db = helper.writableDatabase
        val args = arrayOf(sessionId, seq.toString())
        val paths = chunkPaths(db, "session_id = ? AND seq = ?", args)
        db.delete("chunks", "session_id = ? AND seq = ?", args)
        paths.forEach { File(it).delete() }
    }

    override suspend fun markFinished(sessionId: String) = io {
        update(sessionId, ContentValues().apply { put("finished", 1) })
    }

    override suspend fun markRefused(sessionId: String, reason: String) = io {
        update(sessionId, ContentValues().apply { put("refusal", reason) })
    }

    override suspend fun remove(sessionId: String) = io {
        val db = helper.writableDatabase
        val paths = chunkPaths(db, "session_id = ?", arrayOf(sessionId))
        db.delete("sessions", "id = ?", arrayOf(sessionId))
        paths.forEach { File(it).delete() }
    }

    fun close() = helper.close()

    private fun update(sessionId: String, values: ContentValues) {
        helper.writableDatabase.update("sessions", values, "id = ?", arrayOf(sessionId))
    }

    private fun chunkPaths(db: SQLiteDatabase, where: String, args: Array<String>): List<String> =
        db.query("chunks", arrayOf("path"), "$where AND path IS NOT NULL", args, null, null, null).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    private fun Cursor.str(name: String): String? = getColumnIndexOrThrow(name).let { if (isNull(it)) null else getString(it) }
    private fun Cursor.int(name: String): Int? = getColumnIndexOrThrow(name).let { if (isNull(it)) null else getInt(it) }

    private fun Cursor.toSession() = OutboxSession(
        id = str("id")!!,
        title = str("title"),
        startedAt = str("started_at")!!,
        startedTimeZoneId = str("started_time_zone_id"),
        startedUtcOffsetSeconds = int("started_utc_offset_seconds"),
        language = str("language"),
        chunkCount = int("chunk_count"),
        endedAt = str("ended_at"),
        created = int("created") == 1,
        finished = int("finished") == 1,
        refusal = str("refusal"),
        chunksFiled = int("chunks_filed") ?: 0,
        filedUntil = str("filed_until"),
    )

    private fun Cursor.toChunk() = OutboxChunk(
        sessionId = str("session_id")!!,
        seq = int("seq")!!,
        startedAt = str("started_at")!!,
        durationMs = getLong(getColumnIndexOrThrow("duration_ms")),
        silent = int("silent") == 1,
        interrupted = int("interrupted") == 1,
        file = str("path")?.let(::File),
        mimeType = str("mime_type"),
    )

    companion object {
        const val DB_NAME = "omnesis-recordings.db"
    }
}
