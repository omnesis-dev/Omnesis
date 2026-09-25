// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.watches

import dev.omnesis.android.transport.dto.PrivacySubscriptionFiring
import dev.omnesis.android.transport.dto.WatchFiringDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A watch's history is written twice — once by the runtime that caught the event, once by the
 * egress ledger that recorded what left — and the reader is owed one list. What matters is that
 * folding them never invents a line and never loses one: a disclosure the runtime has no record
 * of is precisely the discrepancy worth showing.
 *
 * All fixture data is invented.
 */
class WatchLedgerMergeTest {

    @Test
    fun `both halves of one event land on one line`() {
        val rows = mergeWatchFirings(
            caught = listOf(firing(seq = 7)),
            sent = listOf(sent(id = "f_7", seq = 7)),
        )

        assertEquals(1, rows.size)
        assertEquals(7, rows.single().caught?.seq)
        assertEquals("f_7", rows.single().sent?.id)
    }

    @Test
    fun `a firing nothing disclosed keeps its line`() {
        val rows = mergeWatchFirings(caught = listOf(firing(seq = 3)), sent = emptyList())

        assertEquals(1, rows.size)
        assertNotNull(rows.single().caught)
        assertNull(rows.single().sent)
    }

    /**
     * The discrepancy case. Dropping it would make the ledger agree with the runtime by
     * construction, which is the one thing this screen must not do.
     */
    @Test
    fun `a disclosure the runtime has no record of still appears`() {
        val rows = mergeWatchFirings(
            caught = listOf(firing(seq = 3, noticedAt = "2026-05-04T09:00:00.000Z")),
            sent = listOf(sent(id = "orphan", seq = 99, createdAt = 1_767_000_000_000)),
        )

        assertEquals(2, rows.size)
        val orphan = rows.single { it.caught == null }
        assertEquals("orphan", orphan.sent?.id)
    }

    @Test
    fun `two disclosures of the same sequence do not collapse onto one another`() {
        val rows = mergeWatchFirings(
            caught = listOf(firing(seq = 5)),
            sent = listOf(sent(id = "first", seq = 5), sent(id = "second", seq = 5)),
        )

        assertEquals(2, rows.size)
        assertEquals("first", rows.single { it.caught != null }.sent?.id)
        assertEquals("second", rows.single { it.caught == null }.sent?.id)
    }

    /**
     * A sequence names a set of firings, not one: a broadcast arm re-judges every live cell at
     * the tick's own sequence number. Two rows sharing an id would be a duplicate key in the
     * list that renders them, which is fatal rather than cosmetic.
     */
    @Test
    fun `two firings caught on the same tick keep separate identities`() {
        val rows = mergeWatchFirings(
            caught = listOf(firing(seq = 412), firing(seq = 412), firing(seq = 411)),
            sent = emptyList(),
        )

        assertEquals(3, rows.size)
        assertEquals(3, rows.map { it.id }.toSet().size)
        assertEquals(listOf("seq:412", "seq:412#1", "seq:411"), rows.map { it.id })
    }

    @Test
    fun `a disclosure with no sequence is kept rather than joined to an arbitrary firing`() {
        val rows = mergeWatchFirings(
            caught = listOf(firing(seq = 2)),
            sent = listOf(sent(id = "unsequenced", seq = null)),
        )

        assertEquals(2, rows.size)
        assertNull(rows.single { it.caught != null }.sent)
    }

    @Test
    fun `the history reads newest first across both ledgers`() {
        val rows = mergeWatchFirings(
            caught = listOf(
                firing(seq = 1, noticedAt = "2026-05-01T09:00:00.000Z"),
                firing(seq = 2, noticedAt = "2026-05-09T09:00:00.000Z"),
            ),
            // Between the two caught firings, so ordering by time rather than by sequence is
            // what puts it in the middle.
            sent = listOf(sent(id = "middle", seq = null, createdAt = 1_777_968_000_000)),
        )

        assertEquals(listOf("seq:2", "sent:middle", "seq:1"), rows.map { it.id })
    }

    private fun firing(
        seq: Int,
        firedAt: String = "2026-05-04T09:15:00.000Z",
        noticedAt: String? = null,
    ) = WatchFiringDto(seq = seq, firedAt = firedAt, noticedAt = noticedAt)

    private fun sent(
        id: String,
        seq: Int?,
        createdAt: Long = 1_777_000_000_000,
    ) = PrivacySubscriptionFiring(
        id = id,
        subscriptionId = "sub_1",
        createdAt = createdAt,
        deliveryStatus = "accepted",
        seq = seq,
    )
}
