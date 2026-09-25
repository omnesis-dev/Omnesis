// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A durable local buffer for GMS `ActivityTransitionEvent`s, meeting the
 * push-based [ActivityTransitionReceiver] half of this feature with the
 * pull-based [ActivitySegmentsSyncCoordinator] half. Hand-rolled
 * `SQLiteOpenHelper` (this codebase has zero Room/DataStore usage; Call Log's
 * `FakeCallLogProvider` already proves this pattern works well for exactly
 * this shape) rather than an in-memory queue — a device-hosted background
 * receiver can be killed by the OS at any point, and undelivered events must
 * survive that.
 *
 * `_id` (not [BufferedTransitionEvent.elapsedRealtimeNanos]) is the merge-order
 * and high-water-mark key: `elapsedRealtimeNanos` resets on every reboot, so
 * it can't order events across a restart, while `_id` (`AUTOINCREMENT`) never
 * repeats or goes backwards.
 *
 * A second table holds [quarantine]d rows: events whose push the gateway
 * answered and refused, moved out of the drain queue so they stop blocking
 * everything behind them. They are kept rather than deleted — a refusal is a
 * bug somewhere, and the events are the evidence — but under a row cap, so a
 * source that never recovers cannot grow this database without bound.
 */
class ActivityTransitionBuffer(context: Context) {

    private val helper: SQLiteOpenHelper = object : SQLiteOpenHelper(context, DB_NAME, null, 2) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """CREATE TABLE $TABLE (
                    $COL_ID INTEGER PRIMARY KEY AUTOINCREMENT,
                    $COL_ACTIVITY_TYPE TEXT NOT NULL,
                    $COL_TRANSITION_TYPE TEXT NOT NULL,
                    $COL_ELAPSED_REALTIME_NANOS INTEGER NOT NULL,
                    $COL_EVENT_WALL_CLOCK_MILLIS INTEGER NOT NULL
                )""",
            )
            createQuarantineTable(db)
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) createQuarantineTable(db)
        }

        private fun createQuarantineTable(db: SQLiteDatabase) {
            // The quarantined row keeps the `_id` it drained under, so the
            // order it was buffered in survives the move.
            db.execSQL(
                """CREATE TABLE IF NOT EXISTS $QUARANTINE_TABLE (
                    $COL_ID INTEGER PRIMARY KEY,
                    $COL_ACTIVITY_TYPE TEXT NOT NULL,
                    $COL_TRANSITION_TYPE TEXT NOT NULL,
                    $COL_ELAPSED_REALTIME_NANOS INTEGER NOT NULL,
                    $COL_EVENT_WALL_CLOCK_MILLIS INTEGER NOT NULL
                )""",
            )
        }
    }

    suspend fun insertAll(events: List<BufferedTransitionEvent>) = withContext(Dispatchers.IO) {
        if (events.isEmpty()) return@withContext
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            for (event in events) {
                val values = ContentValues().apply {
                    put(COL_ACTIVITY_TYPE, event.activityType)
                    put(COL_TRANSITION_TYPE, event.transitionType)
                    put(COL_ELAPSED_REALTIME_NANOS, event.elapsedRealtimeNanos)
                    put(COL_EVENT_WALL_CLOCK_MILLIS, event.eventWallClockMillis)
                }
                db.insert(TABLE, null, values)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Every buffered row, oldest first, up to [limit]. */
    suspend fun readAll(limit: Int = 5000): List<BufferedTransitionEvent> = withContext(Dispatchers.IO) {
        val rows = mutableListOf<BufferedTransitionEvent>()
        helper.readableDatabase.query(
            TABLE,
            arrayOf(COL_ID, COL_ACTIVITY_TYPE, COL_TRANSITION_TYPE, COL_ELAPSED_REALTIME_NANOS, COL_EVENT_WALL_CLOCK_MILLIS),
            null,
            null,
            null,
            null,
            "$COL_ID ASC",
            limit.toString(),
        ).use { cursor ->
            val idIdx = cursor.getColumnIndexOrThrow(COL_ID)
            val typeIdx = cursor.getColumnIndexOrThrow(COL_ACTIVITY_TYPE)
            val transitionIdx = cursor.getColumnIndexOrThrow(COL_TRANSITION_TYPE)
            val nanosIdx = cursor.getColumnIndexOrThrow(COL_ELAPSED_REALTIME_NANOS)
            val wallClockIdx = cursor.getColumnIndexOrThrow(COL_EVENT_WALL_CLOCK_MILLIS)
            while (cursor.moveToNext()) {
                rows += BufferedTransitionEvent(
                    id = cursor.getLong(idIdx),
                    activityType = cursor.getString(typeIdx),
                    transitionType = cursor.getString(transitionIdx),
                    elapsedRealtimeNanos = cursor.getLong(nanosIdx),
                    eventWallClockMillis = cursor.getLong(wallClockIdx),
                )
            }
        }
        rows
    }

    /** Deletes every row with `_id <= maxId` — the range a fully-resolved [MergeOutcome] covers. */
    suspend fun deleteUpTo(maxId: Long) = withContext(Dispatchers.IO) {
        helper.writableDatabase.delete(TABLE, "$COL_ID <= ?", arrayOf(maxId.toString()))
    }

    /**
     * Moves every row with `_id <= maxId` out of the drain queue and into the
     * quarantine table, returning how many moved. The copy and the delete run
     * in one transaction, so a failure mid-move leaves the rows queued rather
     * than losing them. Rows beyond [MAX_QUARANTINED_ROWS] are then evicted
     * oldest-first.
     */
    suspend fun quarantine(maxId: Long): Int = withContext(Dispatchers.IO) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val columns = "$COL_ID, $COL_ACTIVITY_TYPE, $COL_TRANSITION_TYPE, " +
                "$COL_ELAPSED_REALTIME_NANOS, $COL_EVENT_WALL_CLOCK_MILLIS"
            db.execSQL(
                "INSERT OR REPLACE INTO $QUARANTINE_TABLE ($columns) " +
                    "SELECT $columns FROM $TABLE WHERE $COL_ID <= ?",
                arrayOf(maxId),
            )
            val moved = db.delete(TABLE, "$COL_ID <= ?", arrayOf(maxId.toString()))
            db.execSQL(
                "DELETE FROM $QUARANTINE_TABLE WHERE $COL_ID NOT IN " +
                    "(SELECT $COL_ID FROM $QUARANTINE_TABLE ORDER BY $COL_ID DESC LIMIT ?)",
                arrayOf(MAX_QUARANTINED_ROWS),
            )
            db.setTransactionSuccessful()
            moved
        } finally {
            db.endTransaction()
        }
    }

    /** How many refused rows are being retained. */
    suspend fun quarantinedCount(): Int = withContext(Dispatchers.IO) {
        helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM $QUARANTINE_TABLE", null).use { cursor ->
            if (cursor.moveToFirst()) cursor.getInt(0) else 0
        }
    }

    /**
     * Deletes every retained row, returning how many went. The only thing that
     * removes them, and the only way the notice about them clears — the user
     * acknowledging that the events are not going to arrive.
     */
    suspend fun discardQuarantined(): Int = withContext(Dispatchers.IO) {
        helper.writableDatabase.delete(QUARANTINE_TABLE, null, null)
    }

    private companion object {
        const val DB_NAME = "omnesis_activity_transitions.db"
        const val TABLE = "transition_events"
        const val QUARANTINE_TABLE = "quarantined_transition_events"
        const val COL_ID = "_id"
        const val COL_ACTIVITY_TYPE = "activity_type"
        const val COL_TRANSITION_TYPE = "transition_type"
        const val COL_ELAPSED_REALTIME_NANOS = "elapsed_realtime_nanos"
        const val COL_EVENT_WALL_CLOCK_MILLIS = "event_wall_clock_millis"

        /** Upper bound on retained quarantined rows, newest kept. */
        const val MAX_QUARANTINED_ROWS = 5000
    }
}
