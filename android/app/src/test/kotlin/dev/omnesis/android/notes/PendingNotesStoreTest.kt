// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notes

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.time.Instant

/** Durability contract of the offline quick-capture queue (real SQLite via Robolectric). */
@RunWith(RobolectricTestRunner::class)
class PendingNotesStoreTest {

    private fun store() = PendingNotesStore(ApplicationProvider.getApplicationContext())

    @Test
    fun insert_then_read_returns_notes_oldest_first_with_original_capture_time() = runTest {
        val s = store()
        s.insert("key-1", "Buy espresso beans", "2026-07-13T08:00:00.000Z", "android-tile")
        s.insert("key-2", "Ask Maya Reeves about the demo", "2026-07-13T09:30:00.000Z", "android-app")

        val notes = s.readAll()
        assertEquals(2, notes.size)
        assertEquals("Buy espresso beans", notes[0].text)
        assertEquals("2026-07-13T08:00:00.000Z", notes[0].capturedAt)
        assertEquals("android-tile", notes[0].surface)
        assertEquals("key-1", notes[0].noteId)
        assertNull(notes[0].lastAttemptAt)
        assertNull(notes[0].lastFailure)
        assertEquals(0, notes[0].retryCount)
        assertEquals("Ask Maya Reeves about the demo", notes[1].text)
        assertEquals("key-2", notes[1].noteId)
        assertTrue(notes[0].id < notes[1].id)
    }

    @Test
    fun failure_metadata_round_trips_and_retry_updates_atomically() = runTest {
        val s = store()
        s.insert(
            "key-1",
            "Check the train timetable",
            "2026-07-13T08:00:00.000Z",
            "android-app",
            lastAttemptAt = "2026-07-13T08:00:01.000Z",
            lastFailure = "Gateway unreachable",
        )
        val row = s.readAll().single()
        assertEquals("2026-07-13T08:00:01.000Z", row.lastAttemptAt)
        assertEquals("Gateway unreachable", row.lastFailure)
        assertEquals(0, row.retryCount)

        s.recordRetryFailure(row.id, "2026-07-13T08:02:00.000Z", "Gateway returned HTTP 503")

        val retried = s.readAll().single()
        assertEquals("2026-07-13T08:02:00.000Z", retried.lastAttemptAt)
        assertEquals("Gateway returned HTTP 503", retried.lastFailure)
        assertEquals(1, retried.retryCount)
    }

    @Test
    fun warning_starts_at_five_minutes_or_after_a_failed_retry() {
        val capturedAt = "2026-07-13T08:00:00Z"
        val fresh = PendingNote(1, "key", "text", capturedAt, "android-app")
        assertFalse(pendingNoteNeedsAttention(fresh, Instant.parse("2026-07-13T08:04:59Z")))
        assertTrue(pendingNoteNeedsAttention(fresh, Instant.parse("2026-07-13T08:05:00Z")))
        assertTrue(
            pendingNoteNeedsAttention(
                fresh.copy(retryCount = 1),
                Instant.parse("2026-07-13T08:00:01Z"),
            ),
        )
        assertTrue(pendingNoteNeedsAttention(fresh.copy(capturedAt = "legacy-invalid"), Instant.EPOCH))
    }

    @Test
    fun delete_removes_only_the_drained_row() = runTest {
        val s = store()
        s.insert("key-1", "first", "2026-07-13T08:00:00.000Z", "android-app")
        s.insert("key-2", "second", "2026-07-13T08:01:00.000Z", "android-app")
        val first = s.readAll().first()

        s.delete(first.id)

        val remaining = s.readAll()
        assertEquals(1, remaining.size)
        assertEquals("second", remaining[0].text)
    }

    @Test
    fun a_second_store_instance_sees_previously_buffered_notes() = runTest {
        // The queue must survive process death; a fresh helper over the same DB
        // file is the JVM-testable proxy for that. The idempotency key must
        // survive too — a drain retried after a restart reuses it.
        store().insert("key-durable", "survives restarts", "2026-07-13T08:00:00.000Z", "android-shortcut")

        val reopened = store().readAll()
        assertEquals(1, reopened.size)
        assertEquals("survives restarts", reopened[0].text)
        assertEquals("key-durable", reopened[0].noteId)
    }

    @Test
    fun upgrading_a_v1_database_backfills_idempotency_keys() = runTest {
        // Seed a v1 database (no note_id column) with two rows, the way an
        // install that predates the idempotency key would have left it.
        val context = ApplicationProvider.getApplicationContext<Context>()
        val v1 = object : SQLiteOpenHelper(context, "omnesis_pending_notes.db", null, 1) {
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE pending_notes (
                        _id INTEGER PRIMARY KEY AUTOINCREMENT,
                        text TEXT NOT NULL,
                        captured_at TEXT NOT NULL,
                        surface TEXT NOT NULL
                    )""",
                )
            }

            override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
        }
        for (text in listOf("legacy one", "legacy two")) {
            v1.writableDatabase.insert(
                "pending_notes",
                null,
                ContentValues().apply {
                    put("text", text)
                    put("captured_at", "2026-07-13T07:00:00.000Z")
                    put("surface", "android-app")
                },
            )
        }
        v1.close()

        val upgraded = store().readAll()

        assertEquals(listOf("legacy one", "legacy two"), upgraded.map { it.text })
        // Every legacy row got a fresh, distinct UUID it keeps from here on.
        upgraded.forEach { assertEquals(36, it.noteId.length) }
        assertNotEquals(upgraded[0].noteId, upgraded[1].noteId)
        upgraded.forEach {
            assertNull(it.lastAttemptAt)
            assertNull(it.lastFailure)
            assertEquals(0, it.retryCount)
        }
    }

    @Test
    fun upgrading_a_v2_database_preserves_rows_and_adds_diagnostic_defaults() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val v2 = object : SQLiteOpenHelper(context, "omnesis_pending_notes.db", null, 2) {
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE pending_notes (
                        _id INTEGER PRIMARY KEY AUTOINCREMENT,
                        note_id TEXT NOT NULL,
                        text TEXT NOT NULL,
                        captured_at TEXT NOT NULL,
                        surface TEXT NOT NULL
                    )""",
                )
            }

            override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
        }
        v2.writableDatabase.insert(
            "pending_notes",
            null,
            ContentValues().apply {
                put("note_id", "legacy-key")
                put("text", "Legacy queued thought")
                put("captured_at", "2026-07-13T07:00:00.000Z")
                put("surface", "android-app")
            },
        )
        v2.close()

        val upgraded = store().readAll().single()
        assertEquals("legacy-key", upgraded.noteId)
        assertEquals("Legacy queued thought", upgraded.text)
        assertNull(upgraded.lastAttemptAt)
        assertNull(upgraded.lastFailure)
        assertEquals(0, upgraded.retryCount)
    }
}
