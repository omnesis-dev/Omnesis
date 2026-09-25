// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Exercises [ActivityTransitionBuffer] against a real, Robolectric-backed
 * SQLite database — not GMS-specific, but a real SQL exercise (insert order,
 * range deletes, concurrent-insert safety).
 */
@RunWith(RobolectricTestRunner::class)
class ActivityTransitionBufferTest {

    private lateinit var buffer: ActivityTransitionBuffer

    @Before
    fun setUp() {
        buffer = ActivityTransitionBuffer(ApplicationProvider.getApplicationContext())
    }

    private fun event(type: String, transition: String, nanos: Long, wallClockMillis: Long) =
        BufferedTransitionEvent(id = 0, activityType = type, transitionType = transition, elapsedRealtimeNanos = nanos, eventWallClockMillis = wallClockMillis)

    @Test
    fun `readAll returns rows in insertion (id) order`() = runTest {
        buffer.insertAll(
            listOf(
                event("walking", "ENTER", 1_000_000_000, 1_000),
                event("walking", "EXIT", 2_000_000_000, 2_000),
                event("running", "ENTER", 3_000_000_000, 3_000),
            ),
        )

        val rows = buffer.readAll()
        assertEquals(3, rows.size)
        assertEquals(listOf(1L, 2L, 3L), rows.map { it.id })
        assertEquals(listOf("ENTER", "EXIT", "ENTER"), rows.map { it.transitionType })
        assertEquals(3_000L, rows.last().eventWallClockMillis)
    }

    @Test
    fun `readAll respects the limit`() = runTest {
        buffer.insertAll((1..10).map { event("still", "ENTER", it * 1_000_000L, it * 1_000L) })
        val rows = buffer.readAll(limit = 3)
        assertEquals(3, rows.size)
        assertEquals(listOf(1L, 2L, 3L), rows.map { it.id })
    }

    @Test
    fun `deleteUpTo removes only rows at or below the given id`() = runTest {
        buffer.insertAll(
            listOf(
                event("walking", "ENTER", 1_000_000_000, 1_000),
                event("walking", "EXIT", 2_000_000_000, 2_000),
                event("running", "ENTER", 3_000_000_000, 3_000),
            ),
        )

        buffer.deleteUpTo(2)

        val remaining = buffer.readAll()
        assertEquals(1, remaining.size)
        assertEquals(3L, remaining.single().id)
    }

    @Test
    fun `deleteUpTo with no matching rows is a harmless no-op`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", 1_000_000_000, 1_000)))
        buffer.deleteUpTo(0)
        assertEquals(1, buffer.readAll().size)
    }

    @Test
    fun `a row inserted after a readAll snapshot survives a deleteUpTo bounded by that snapshot's max id`() = runTest {
        buffer.insertAll(
            listOf(
                event("walking", "ENTER", 1_000_000_000, 1_000),
                event("walking", "EXIT", 2_000_000_000, 2_000),
            ),
        )
        val snapshot = buffer.readAll()
        val snapshotMaxId = snapshot.maxOf { it.id }

        // Simulates a concurrent insert landing between this drain's readAll
        // and its eventual deleteUpTo (e.g. a live GMS callback delivered
        // mid-drain).
        buffer.insertAll(listOf(event("running", "ENTER", 3_000_000_000, 3_000)))

        buffer.deleteUpTo(snapshotMaxId)

        val remaining = buffer.readAll()
        assertEquals(1, remaining.size)
        assertTrue(remaining.single().id > snapshotMaxId)
        assertEquals("running", remaining.single().activityType)
    }

    @Test
    fun `insertAll is a no-op for an empty list`() = runTest {
        buffer.insertAll(emptyList())
        assertEquals(0, buffer.readAll().size)
    }

    @Test
    fun `quarantine moves the range out of the drain queue and keeps it`() = runTest {
        buffer.insertAll(
            listOf(
                event("walking", "ENTER", 1_000_000_000, 1_000),
                event("walking", "EXIT", 2_000_000_000, 2_000),
                event("running", "ENTER", 3_000_000_000, 3_000),
            ),
        )

        assertEquals(2, buffer.quarantine(2))

        val remaining = buffer.readAll()
        assertEquals(1, remaining.size)
        assertEquals(3L, remaining.single().id)
        assertEquals(2, buffer.quarantinedCount())
    }

    @Test
    fun `quarantining twice accumulates and never resurrects a row`() = runTest {
        buffer.insertAll((1..4).map { event("still", "ENTER", it * 1_000_000L, it * 1_000L) })

        buffer.quarantine(2)
        buffer.quarantine(4)

        assertTrue(buffer.readAll().isEmpty())
        assertEquals(4, buffer.quarantinedCount())
    }

    @Test
    fun `quarantine with no matching rows is a harmless no-op`() = runTest {
        buffer.insertAll(listOf(event("walking", "ENTER", 1_000_000_000, 1_000)))
        assertEquals(0, buffer.quarantine(0))
        assertEquals(1, buffer.readAll().size)
        assertEquals(0, buffer.quarantinedCount())
    }

    @Test
    fun `discardQuarantined deletes the retained rows and leaves the queue alone`() = runTest {
        buffer.insertAll((1..4).map { event("still", "ENTER", it * 1_000_000L, it * 1_000L) })
        buffer.quarantine(2)

        assertEquals(2, buffer.discardQuarantined())

        assertEquals(0, buffer.quarantinedCount())
        assertEquals(listOf(3L, 4L), buffer.readAll().map { it.id })
    }

    @Test
    fun `discardQuarantined with nothing retained is a harmless no-op`() = runTest {
        assertEquals(0, buffer.discardQuarantined())
        assertEquals(0, buffer.quarantinedCount())
    }

    @Test
    fun `an empty queue has no pending rows and no oldest wall clock`() = runTest {
        val pending = buffer.readAll()
        assertEquals(0, pending.size)
        assertNull(pending.minOfOrNull { it.eventWallClockMillis })
    }

    @Test
    fun `the oldest pending wall clock is the earliest event still waiting`() = runTest {
        // Event timestamps survive storage independently of insertion order.
        buffer.insertAll(
            listOf(
                event("walking", "ENTER", 3_000_000_000, 9_000),
                event("walking", "EXIT", 1_000_000_000, 4_000),
                event("running", "ENTER", 2_000_000_000, 7_000),
            ),
        )

        val pending = buffer.readAll()
        assertEquals(3, pending.size)
        assertEquals(4_000L, pending.minOfOrNull { it.eventWallClockMillis })
    }

    @Test
    fun `draining the oldest rows moves the pending clock forward`() = runTest {
        buffer.insertAll(
            listOf(
                event("walking", "ENTER", 1_000_000_000, 1_000),
                event("walking", "EXIT", 2_000_000_000, 2_000),
            ),
        )

        buffer.deleteUpTo(1)

        val pending = buffer.readAll()
        assertEquals(1, pending.size)
        assertEquals(2_000L, pending.minOfOrNull { it.eventWallClockMillis })
    }

    @Test
    fun `quarantined rows stop counting as pending`() = runTest {
        // Their age must not keep driving the backlog warning: nothing is
        // going to retry them, so a retry button could not help.
        buffer.insertAll(
            listOf(
                event("walking", "ENTER", 1_000_000_000, 1_000),
                event("walking", "EXIT", 2_000_000_000, 2_000),
            ),
        )

        buffer.quarantine(1)

        val pending = buffer.readAll()
        assertEquals(1, pending.size)
        assertEquals(2_000L, pending.minOfOrNull { it.eventWallClockMillis })
    }
}
