// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Durable local record of every [Segment] this device has ever resolved,
 * keyed the same way its pushed analytics row is
 * (`activityType:startEpochMillis`, see [ActivitySegmentsSyncCoordinator]).
 *
 * Backs the per-day "Movement Timeline" document rebuild. Unlike
 * `CallLogSource`/`AppUsageSource`, there is no OS-queryable history to
 * re-derive a whole day from on demand — GMS only ever pushes each
 * transition once, through [ActivityTransitionReceiver]. So each drain's
 * newly closed segments are upserted here first, and the day's document is
 * always rebuilt from every segment on record for that date, not just the
 * current drain's slice — otherwise a day touched by several drains (the
 * common case for an hourly worker) would keep losing its earlier hours'
 * segments every time the document is overwritten.
 */
class ActivitySegmentsHistoryStore(context: Context) {

    private val helper: SQLiteOpenHelper = object : SQLiteOpenHelper(context, DB_NAME, null, 2) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL(
                """CREATE TABLE $TABLE (
                    $COL_ID TEXT PRIMARY KEY,
                    $COL_ACTIVITY_TYPE TEXT NOT NULL,
                    $COL_START_MILLIS INTEGER NOT NULL,
                    $COL_END_MILLIS INTEGER NOT NULL,
                    $COL_CONFIDENCE TEXT NOT NULL,
                    $COL_TRUNCATED INTEGER NOT NULL,
                    $COL_DATE TEXT NOT NULL
                )""",
            )
            db.execSQL("CREATE INDEX idx_${TABLE}_date ON $TABLE ($COL_DATE)")
            createOverlapIndex(db)
        }

        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            if (oldVersion < 2) createOverlapIndex(db)
        }

        private fun createOverlapIndex(db: SQLiteDatabase) {
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_${TABLE}_end ON $TABLE ($COL_END_MILLIS)")
        }
    }

    /** Upsert-by-id (a segment id is deterministic, so replaying an already-recorded segment is harmless). */
    suspend fun upsertAll(segments: List<Segment>) = withContext(Dispatchers.IO) {
        if (segments.isEmpty()) return@withContext
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            for (segment in segments) {
                val values = ContentValues().apply {
                    put(COL_ID, ActivitySegmentsNormalizer.segmentId(segment))
                    put(COL_ACTIVITY_TYPE, segment.activityType)
                    put(COL_START_MILLIS, segment.startMillis)
                    put(COL_END_MILLIS, segment.endMillis)
                    put(COL_CONFIDENCE, segment.confidence.name)
                    put(COL_TRUNCATED, if (segment.truncated) 1 else 0)
                    put(COL_DATE, DATE_FORMAT.format(ActivitySegmentsNormalizer.startDate(segment)))
                }
                db.insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /**
     * Every interval overlapping [date] (ISO-8601, UTC), clipped to that day's
     * half-open window. Stored segments stay whole so their analytics identities
     * do not change when an interval spans midnight.
     */
    suspend fun segmentsForDate(date: String): List<Segment> = withContext(Dispatchers.IO) {
        val day = LocalDate.parse(date)
        val start = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val end = day.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        readSegments(
            selection = "$COL_END_MILLIS > ? AND $COL_START_MILLIS < ?",
            selectionArgs = arrayOf(start.toString(), end.toString()),
            orderBy = "$COL_START_MILLIS ASC",
        ).map { it.copy(startMillis = maxOf(it.startMillis, start), endMillis = minOf(it.endMillis, end)) }
    }

    /** Canonical, unsplit records in bounded keyset pages for replay after a stream reset. */
    suspend fun segmentsPage(afterId: String? = null, limit: Int = 200): List<Segment> = withContext(Dispatchers.IO) {
        require(limit > 0) { "Page limit must be positive" }
        readSegments(
            selection = afterId?.let { "$COL_ID > ?" },
            selectionArgs = afterId?.let { arrayOf(it) },
            orderBy = "$COL_ID ASC",
            limit = limit.toString(),
        )
    }

    private fun readSegments(
        selection: String?,
        selectionArgs: Array<String>?,
        orderBy: String,
        limit: String? = null,
    ): List<Segment> {
        val rows = mutableListOf<Segment>()
        helper.readableDatabase.query(
            TABLE,
            arrayOf(COL_ACTIVITY_TYPE, COL_START_MILLIS, COL_END_MILLIS, COL_CONFIDENCE, COL_TRUNCATED),
            selection,
            selectionArgs,
            null,
            null,
            orderBy,
            limit,
        ).use { cursor ->
            val typeIdx = cursor.getColumnIndexOrThrow(COL_ACTIVITY_TYPE)
            val startIdx = cursor.getColumnIndexOrThrow(COL_START_MILLIS)
            val endIdx = cursor.getColumnIndexOrThrow(COL_END_MILLIS)
            val confidenceIdx = cursor.getColumnIndexOrThrow(COL_CONFIDENCE)
            val truncatedIdx = cursor.getColumnIndexOrThrow(COL_TRUNCATED)
            while (cursor.moveToNext()) {
                rows += Segment(
                    activityType = cursor.getString(typeIdx),
                    startMillis = cursor.getLong(startIdx),
                    endMillis = cursor.getLong(endIdx),
                    confidence = SegmentConfidence.valueOf(cursor.getString(confidenceIdx)),
                    truncated = cursor.getInt(truncatedIdx) != 0,
                )
            }
        }
        return rows
    }

    companion object {
        private val DATE_FORMAT: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE

        private const val DB_NAME = "omnesis_activity_segments_history.db"
        private const val TABLE = "resolved_segments"
        private const val COL_ID = "id"
        private const val COL_ACTIVITY_TYPE = "activity_type"
        private const val COL_START_MILLIS = "start_millis"
        private const val COL_END_MILLIS = "end_millis"
        private const val COL_CONFIDENCE = "confidence"
        private const val COL_TRUNCATED = "truncated"
        private const val COL_DATE = "date"
    }
}
