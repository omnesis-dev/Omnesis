// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

/**
 * The give-up budget every device-hosted source shares. The properties that
 * matter are the ones whose violation costs data: a run belongs to one unit,
 * both legs of the policy must be spent before anything is skipped, and a
 * marker outlives the run that produced it.
 */
class PushRefusalLedgerTest {

    private val store = mutableMapOf<String, String>()

    private fun ledger(maxSkipped: Int = PushRefusalLedger.MAX_SKIPPED) = PushRefusalLedger(
        sourceId = "example-source:local",
        keyPrefix = "omnesis.example.push",
        read = { store[it] },
        write = { key, value -> if (value == null) store.remove(key) else store[key] = value },
        maxSkipped = maxSkipped,
    )

    private val t0: Instant = Instant.parse("2026-05-02T09:00:00Z")

    @Test
    fun `a run needs both the attempt budget and the grace window`() {
        val l = ledger()
        repeat(RefusalPolicy.MAX_REFUSALS) {
            assertFalse("attempt ${it + 1} must not give up", l.noteRefusal("page-1", t0))
        }
        assertEquals(RefusalPolicy.MAX_REFUSALS, l.openRun?.count)

        // One second short of the grace window is still short.
        assertFalse(l.noteRefusal("page-1", t0.plus(RefusalPolicy.GRACE).minusSeconds(1)))
        assertTrue(l.noteRefusal("page-1", t0.plus(RefusalPolicy.GRACE)))
    }

    @Test
    fun `time alone never spends the budget`() {
        val l = ledger()
        assertFalse(l.noteRefusal("page-1", t0))
        assertFalse(l.noteRefusal("page-1", t0.plus(RefusalPolicy.GRACE).plusSeconds(1)))
        assertEquals(2, l.openRun?.count)
    }

    @Test
    fun `a refusal against a different unit starts its own run`() {
        val l = ledger()
        repeat(RefusalPolicy.MAX_REFUSALS) { l.noteRefusal("page-1", t0) }

        assertFalse(l.noteRefusal("page-2", t0.plus(RefusalPolicy.GRACE)))
        assertEquals(RefusalRun("page-2", count = 1, firstAtMillis = t0.plus(RefusalPolicy.GRACE).toEpochMilli()), l.openRun)
    }

    @Test
    fun `a run survives a fresh ledger over the same store`() {
        // The background pass runs in a cold-started process: the count is only
        // worth keeping if it is read back, not held in the object that took it.
        repeat(3) { ledger().noteRefusal("page-1", t0) }
        assertEquals(3, ledger().openRun?.count)
    }

    @Test
    fun `only the unit that got through retires the run`() {
        val l = ledger()
        l.noteRefusal("page-1", t0)

        l.clearRun("page-2")
        assertEquals(1, l.openRun?.count)

        l.clearRun("page-1")
        assertNull(l.openRun)
    }

    @Test
    fun `a marker carries what was skipped, how many refusals it took, and when`() {
        val l = ledger()
        repeat(RefusalPolicy.MAX_REFUSALS) { l.noteRefusal("page-1", t0) }
        val at = t0.plus(RefusalPolicy.GRACE)
        l.noteRefusal("page-1", at)

        val marker = l.recordSkipped("42 rows through 2026-05-02", at)

        assertEquals(
            SkippedPush(
                sourceId = "example-source:local",
                unit = "42 rows through 2026-05-02",
                refusals = RefusalPolicy.MAX_REFUSALS + 1,
                atMillis = at.toEpochMilli(),
            ),
            marker,
        )
        assertEquals(listOf(marker), ledger().skipped)
        assertNull("recording the marker closes the run", l.openRun)
    }

    @Test
    fun `markers are capped, oldest first`() {
        val l = ledger(maxSkipped = 3)
        for (i in 1..5) {
            l.noteRefusal("page-$i", t0)
            l.recordSkipped("unit-$i", t0.plusSeconds(i.toLong()))
        }
        assertEquals(listOf("unit-3", "unit-4", "unit-5"), l.skipped.map { it.unit })
    }

    @Test
    fun `unreadable stored markers read as none rather than throwing`() {
        store["omnesis.example.push.skipped"] = "{not json"
        assertEquals(emptyList<SkippedPush>(), ledger().skipped)
    }

    @Test
    fun `clear wipes the run, the blocked flag and the markers`() {
        val l = ledger()
        l.noteRefusal("page-1", t0)
        l.recordSkipped("unit-1", t0)
        l.noteRefusal("page-2", t0)
        l.blocked = true

        l.clear()

        assertNull(l.openRun)
        assertEquals(emptyList<SkippedPush>(), l.skipped)
        assertEquals(false, l.blocked)
    }

    @Test
    fun `a source starts un-blocked`() {
        assertEquals(false, ledger().blocked)
    }

    @Test
    fun `the blocked flag outlives the process that set it`() {
        // Each background pass cold-starts the app, so an in-memory flag would
        // be false again before anything read it.
        ledger().blocked = true
        assertEquals(true, ledger().blocked)

        ledger().blocked = false
        assertEquals(false, ledger().blocked)
    }

    @Test
    fun `clearing the markers leaves the open run alone`() {
        // Forgetting what was skipped is not evidence that what is currently
        // being refused has started getting through.
        val l = ledger()
        l.noteRefusal("page-1", t0)
        l.recordSkipped("unit-1", t0)
        l.noteRefusal("page-2", t0)

        l.clearSkipped()

        assertEquals(emptyList<SkippedPush>(), l.skipped)
        assertEquals("page-2", l.openRun?.unitKey)
    }
}

/**
 * A [SkippedPush] description is rendered in the delivery banner, so it is
 * copy rather than a log line — the difference between "42 photo(s)" at an
 * ISO-8601 instant and a sentence a person reads without decoding it.
 */
class SkippedPushCopyTest {
    @Test
    fun `counts read the way a person writes them`() {
        assertEquals("1 photo", countOf(1, "photo"))
        assertEquals("42 photos", countOf(42, "photo"))
        assertEquals("0 photos", countOf(0, "photo"))
    }

    @Test
    fun `an irregular plural can be supplied`() {
        assertEquals("1 entry", countOf(1, "entry", "entries"))
        assertEquals("3 entries", countOf(3, "entry", "entries"))
    }

    @Test
    fun `a moment renders as a date, not an instant`() {
        val rendered = readableMoment(
            Instant.parse("2026-01-02T09:00:00Z").toEpochMilli(),
            zone = ZoneId.of("UTC"),
            locale = Locale.UK,
        )
        assertEquals("2 Jan 2026, 09:00", rendered)
        assertFalse("an ISO instant leaked into user copy: $rendered", rendered.contains("T"))
        assertFalse("an ISO instant leaked into user copy: $rendered", rendered.contains("Z"))
    }
}
