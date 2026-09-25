// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.watches

import dev.omnesis.android.transport.dto.WatchDisclosureDto
import dev.omnesis.android.transport.dto.WatchFiringDeliveryDto
import dev.omnesis.android.transport.dto.WatchFiringDto
import dev.omnesis.android.transport.dto.WatchRecordDto
import dev.omnesis.android.transport.dto.WatchVerdictDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the watch surfaces say, decided without a renderer.
 *
 * These are the claims a screenshot cannot check: that the ledger reads newest
 * first, that a paused watch leads with why, and that the difference between
 * "nobody was told" and "there was nobody to tell" survives to the phone.
 *
 * All fixture data is invented.
 */
class WatchesFormattingTest {
    @Test fun notificationFiringKeyResolvesOnlyWithinItsWatch() {
        assertEquals(41, watchFiringSequence("w-1", "w-1:41"))
        assertNull(watchFiringSequence("w-1", "w-2:41"))
        assertNull(watchFiringSequence("w-1", "w-1:not-a-sequence"))
        assertNull(watchFiringSequence("w-1", null))
    }


    private fun watch(
        status: String = "active",
        note: String? = null,
        firings: Int = 0,
        delivery: String? = null,
        disclosure: WatchDisclosureDto? = null,
    ) = WatchRecordDto(
        id = "w_1",
        name = "an-invoice-arrived",
        status = status,
        note = note,
        firings = firings,
        delivery = delivery,
        disclosure = disclosure,
    )

    private fun disclosure(
        authoredBy: String = "integration",
        integrationName: String? = "Hermes",
        instruction: String? = null,
        status: String = "active",
    ) = WatchDisclosureDto(
        authoredBy = authoredBy,
        subscriptionId = "sub_1",
        status = status,
        integrationName = integrationName,
        instruction = instruction,
    )

    private fun firing(
        seq: Int = 1,
        firedAt: String = "2026-05-04T09:15:00.000Z",
        noticedAt: String? = null,
        delivery: WatchFiringDeliveryDto? = null,
    ) = WatchFiringDto(seq = seq, firedAt = firedAt, noticedAt = noticedAt, delivery = delivery)

    /**
     * Which watch is still doing something is the question the list answers,
     * and each row states its own status — so ordering carries it and no
     * heading has to.
     */
    @Test fun `running watches sort above held and finished ones`() {
        val ordered = orderedWatches(
            listOf(
                watch(status = "retired").copy(id = "done"),
                watch(status = "paused").copy(id = "held"),
                watch(status = "active").copy(id = "first"),
                watch(status = "active").copy(id = "second"),
            ),
        )

        assertEquals(listOf("first", "second", "held", "done"), ordered.map { it.id })
    }

    @Test fun `a status this build has never heard of sorts with the finished`() {
        val ordered = orderedWatches(
            listOf(
                watch(status = "hibernating").copy(id = "unknown"),
                watch(status = "active").copy(id = "live"),
            ),
        )

        assertEquals(listOf("live", "unknown"), ordered.map { it.id })
    }

    @Test fun `a status this build has never heard of is shown, not swallowed`() {
        // A gateway newer than this app may name a state it does not know.
        // Showing it verbatim is more use to the operator than "Unknown".
        assertEquals("running", watchStatusLabel("active"))
        assertEquals("held", watchStatusLabel("paused"))
        assertEquals("finished", watchStatusLabel("retired"))
        assertEquals("quarantined", watchStatusLabel("quarantined"))
    }

    @Test fun `a watch the operator asked for themselves names nobody`() {
        assertEquals("You asked for this", watchAskedBy(watch()))
        // An approval record alone is not authorship: the operator can be the one who asked
        // even when the disclosure exists because something else will be told.
        assertEquals(
            "You asked for this",
            watchAskedBy(watch(disclosure = disclosure(authoredBy = "operator"))),
        )
    }

    @Test fun `a watch an integration asked for names the integration`() {
        assertEquals(
            "Hermes asked for this",
            watchAskedBy(watch(disclosure = disclosure(integrationName = "Hermes"))),
        )
        // An integration that did not say who it is is still not the operator.
        assertEquals(
            "An integration asked for this",
            watchAskedBy(watch(disclosure = disclosure(integrationName = null))),
        )
    }

    @Test fun `where a firing goes is named on the row and spelled out on the detail`() {
        val notifies = watch(delivery = "omnesis-notify")
        assertEquals("Notifies you", watchDeliveryLabel(notifies))
        assertEquals("Notifies your devices.", watchDeliverySentence(notifies))

        val wakes = watch(delivery = "agent-wake", disclosure = disclosure(integrationName = "Hermes"))
        assertEquals("Wakes Hermes", watchDeliveryLabel(wakes))
        assertEquals("Wakes Hermes.", watchDeliverySentence(wakes))

        // The case worth spelling out: still working, and nobody hears about it.
        assertEquals("Records only", watchDeliveryLabel(watch()))
        assertEquals(
            "Delivers nowhere. Every firing is recorded here and nobody is told.",
            watchDeliverySentence(watch()),
        )
    }

    @Test fun `the wake sentence quotes the instruction the integration was granted`() {
        assertEquals(
            "Wakes Hermes: Summarise the invoice and reply to the thread.",
            watchDisclosureWakeSentence(
                disclosure(
                    integrationName = "Hermes",
                    instruction = "  Summarise the invoice and reply to the thread.  ",
                ),
            ),
        )
        assertEquals(
            "Wakes an integration: No instruction was recorded.",
            watchDisclosureWakeSentence(disclosure(integrationName = null, instruction = "  ")),
        )
    }

    @Test fun `only an actionable verdict is worth marking`() {
        // The ordinary "working" verdict is not news, and marking every row would make the
        // mark mean nothing.
        assertNull(watchVerdictMark(null))
        assertNull(watchVerdictMark(WatchVerdictDto(name = "Working", actionable = false)))
        assertEquals(
            "Never matched",
            watchVerdictMark(WatchVerdictDto(name = "never-matched", label = "Never matched", actionable = true)),
        )
        // Falls back to the verdict's own name when it carries no label.
        assertEquals(
            "reaching-nobody",
            watchVerdictMark(WatchVerdictDto(name = "reaching-nobody", label = "  ", actionable = true)),
        )
    }

    @Test fun `a firing that was never meant to go anywhere says nothing about delivery`() {
        // Most watches deliver nowhere. A "not delivered" line there would
        // read as a failure rather than as the watch doing what was asked.
        assertNull(firingDeliveryLabel(firing()))
        assertFalse(firingDeliveryFailed(firing()))
    }

    @Test fun `a firing nobody was told about says so, and is painted as a failure`() {
        // The case the whole row exists for: it fired, and you were never
        // told. Without this, that is indistinguishable from never firing.
        val undelivered = firing(
            delivery = WatchFiringDeliveryDto(
                kind = "omnesis-notify",
                delivered = 0,
                attempted = 2,
                error = "APNs delivery failed for all 2 device(s)",
            ),
        )

        assertEquals(
            "not delivered — APNs delivery failed for all 2 device(s)",
            firingDeliveryLabel(undelivered),
        )
        assertTrue(firingDeliveryFailed(undelivered))
    }

    @Test fun `a delivery that worked names the channel it reached`() {
        val push = firing(delivery = WatchFiringDeliveryDto(kind = "omnesis-notify", delivered = 1))
        val wake = firing(delivery = WatchFiringDeliveryDto(kind = "agent-wake", delivered = 1))

        assertEquals("notified you", firingDeliveryLabel(push))
        assertEquals("woke an agent", firingDeliveryLabel(wake))
        assertFalse(firingDeliveryFailed(push))
    }

    @Test fun `a failure the channel could not explain still reads as one`() {
        val silent = firing(delivery = WatchFiringDeliveryDto(kind = "omnesis-notify", delivered = 0))

        assertEquals("not delivered", firingDeliveryLabel(silent))
        assertTrue(firingDeliveryFailed(silent))
    }

    @Test fun `the subject's own date is named only when it is a different moment`() {
        // A calendar event created in June and moved today has a semantic time
        // in June, so its firing is stamped June. Read as a ledger of when the
        // watch spoke, that says it fired months ago.
        val apart = firing(
            firedAt = "2026-03-01T12:00:00.000Z",
            noticedAt = "2026-05-06T08:30:00.000Z",
        )
        val together = firing(
            firedAt = "2026-05-06T08:30:00.000Z",
            noticedAt = "2026-05-06T08:30:20.000Z",
        )

        assertTrue(firingSubjectDate(apart) != null)
        assertNull(firingSubjectDate(together))
        assertNull(firingSubjectDate(firing(noticedAt = null)))
    }

    @Test fun `an instant this build cannot parse is shown rather than dropped`() {
        // A gateway that changes its instant format must not blank the row.
        assertEquals("not-an-instant", firingWhen(firing(firedAt = "not-an-instant")))
    }
}
