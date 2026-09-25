// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.time.Instant
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ActivitySegmentsHistoryStoreTest {
    private lateinit var history: ActivitySegmentsHistoryStore

    @Before
    fun setUp() {
        history = ActivitySegmentsHistoryStore(ApplicationProvider.getApplicationContext())
    }

    private fun segment(start: String, end: String, type: String = "still") = Segment(
        activityType = type,
        startMillis = Instant.parse(start).toEpochMilli(),
        endMillis = Instant.parse(end).toEpochMilli(),
        confidence = SegmentConfidence.HIGH,
        truncated = false,
    )

    @Test
    fun `overnight segment contributes only its overlapping duration to each day`() = runTest {
        val overnight = segment("2026-02-10T23:00:00Z", "2026-02-11T02:00:00Z")
        history.upsertAll(listOf(overnight))

        assertEquals(
            listOf(segment("2026-02-10T23:00:00Z", "2026-02-11T00:00:00Z")),
            history.segmentsForDate("2026-02-10"),
        )
        assertEquals(
            listOf(segment("2026-02-11T00:00:00Z", "2026-02-11T02:00:00Z")),
            history.segmentsForDate("2026-02-11"),
        )
        assertTrue(history.segmentsForDate("2026-02-12").isEmpty())
    }

    @Test
    fun `day boundaries are half open and replay does not duplicate segments`() = runTest {
        val before = segment("2026-02-10T22:00:00Z", "2026-02-11T00:00:00Z")
        val during = segment("2026-02-11T00:00:00Z", "2026-02-11T01:00:00Z", "walking")
        val after = segment("2026-02-12T00:00:00Z", "2026-02-12T01:00:00Z")
        history.upsertAll(listOf(after, during, before))
        history.upsertAll(listOf(during))
        assertEquals(listOf(during), history.segmentsForDate("2026-02-11"))
    }

    @Test
    fun `multi-day intervals retain confidence and safety closure metadata`() = runTest {
        val long = segment("2026-02-10T23:00:00Z", "2026-02-13T02:00:00Z")
            .copy(confidence = SegmentConfidence.LOW, truncated = true)
        history.upsertAll(listOf(long))
        val middle = history.segmentsForDate("2026-02-11").single()
        assertEquals(24 * 3600L, middle.duration.seconds)
        assertEquals(SegmentConfidence.LOW, middle.confidence)
        assertTrue(middle.truncated)
    }

    @Test
    fun `existing version one history remains readable across midnight after upgrade`() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val overnight = segment("2026-02-10T23:00:00Z", "2026-02-11T02:00:00Z")
        context.openOrCreateDatabase("omnesis_activity_segments_history.db", Context.MODE_PRIVATE, null).use { db ->
            db.execSQL("""CREATE TABLE resolved_segments (
                id TEXT PRIMARY KEY, activity_type TEXT NOT NULL, start_millis INTEGER NOT NULL,
                end_millis INTEGER NOT NULL, confidence TEXT NOT NULL, truncated INTEGER NOT NULL,
                date TEXT NOT NULL
            )""")
            db.execSQL("CREATE INDEX idx_resolved_segments_date ON resolved_segments (date)")
            db.execSQL(
                "INSERT INTO resolved_segments VALUES (?, ?, ?, ?, ?, ?, ?)",
                arrayOf(ActivitySegmentsNormalizer.segmentId(overnight), "still", overnight.startMillis,
                    overnight.endMillis, "HIGH", 0, "2026-02-10"),
            )
            db.version = 1
        }

        assertEquals(
            listOf(segment("2026-02-11T00:00:00Z", "2026-02-11T02:00:00Z")),
            history.segmentsForDate("2026-02-11"),
        )
        assertEquals(listOf(overnight), history.segmentsPage())
        context.openOrCreateDatabase("omnesis_activity_segments_history.db", Context.MODE_PRIVATE, null).use { db ->
            assertEquals(2, db.version)
            db.rawQuery("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_resolved_segments_end'", null).use {
                assertTrue(it.moveToFirst())
            }
        }
    }

    @Test
    fun `keyset replay returns whole canonical intervals once across pages`() = runTest {
        val segments = listOf(
            segment("2026-02-10T23:00:00Z", "2026-02-11T02:00:00Z"),
            segment("2026-02-11T03:00:00Z", "2026-02-11T04:00:00Z", "walking"),
            segment("2026-02-11T05:00:00Z", "2026-02-11T06:00:00Z", "running"),
        )
        history.upsertAll(segments)
        val first = history.segmentsPage(limit = 2)
        assertEquals(2, first.size)
        val second = history.segmentsPage(afterId = ActivitySegmentsNormalizer.segmentId(first.last()), limit = 2)
        assertEquals(1, second.size)
        assertEquals(segments.sortedBy(ActivitySegmentsNormalizer::segmentId), first + second)
        assertTrue(history.segmentsPage(afterId = ActivitySegmentsNormalizer.segmentId(second.last())).isEmpty())
        // Daily clipping must never mutate the canonical interval used for replay.
        history.segmentsForDate("2026-02-11")
        assertEquals(segments.sortedBy(ActivitySegmentsNormalizer::segmentId), history.segmentsPage())
    }

    @Test
    fun `updated segment keeps its replay key and page lookup sees latest end`() = runTest {
        val original = segment("2026-02-10T23:00:00Z", "2026-02-11T02:00:00Z")
        val updated = original.copy(endMillis = Instant.parse("2026-02-11T03:00:00Z").toEpochMilli())
        history.upsertAll(listOf(original))
        history.upsertAll(listOf(updated))
        assertEquals(listOf(updated), history.segmentsPage())
        assertEquals(3 * 3600L, history.segmentsForDate("2026-02-11").single().duration.seconds)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `replay rejects unbounded page limits`() = runTest {
        history.segmentsPage(limit = -1)
    }
}
