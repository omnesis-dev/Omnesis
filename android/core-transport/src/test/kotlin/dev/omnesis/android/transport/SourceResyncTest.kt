// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.dto.ResyncMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** What a source's Resync action offers and sends, from the `resyncModes` its gateway lists. */
class SourceResyncTest {
    private val both = ResyncOffer.Choice(listOf(ResyncMode.IN_PLACE, ResyncMode.FROM_SCRATCH))

    @Test
    fun offer_follows_the_listing() {
        assertEquals(ResyncOffer.WipeOnly, resyncOffer(null))
        assertEquals(ResyncOffer.Unavailable, resyncOffer(emptyList()))
        assertEquals(both, resyncOffer(listOf("from-scratch", "in-place")))
        assertEquals(ResyncOffer.Choice(listOf(ResyncMode.IN_PLACE)), resyncOffer(listOf("in-place")))
        assertEquals(ResyncOffer.Choice(listOf(ResyncMode.FROM_SCRATCH)), resyncOffer(listOf("from-scratch", "sideways")))
        assertEquals(ResyncOffer.Unavailable, resyncOffer(listOf("sideways")))
    }

    @Test
    fun choice_opens_on_in_place() {
        assertEquals(ResyncMode.IN_PLACE, both.defaultMode)
        assertEquals(ResyncMode.FROM_SCRATCH, ResyncOffer.Choice(listOf(ResyncMode.FROM_SCRATCH)).defaultMode)
    }

    @Test
    fun gateway_with_modes_gets_one_request_carrying_the_mode() {
        assertEquals(listOf(ResyncStep.Resync(ResyncMode.IN_PLACE)), resyncSteps(both, ResyncMode.IN_PLACE))
        assertEquals(listOf(ResyncStep.Resync(ResyncMode.FROM_SCRATCH)), resyncSteps(both, ResyncMode.FROM_SCRATCH))
    }

    @Test
    fun older_gateway_gets_the_delete_then_the_sync() {
        assertEquals(listOf(ResyncStep.DeleteAll, ResyncStep.Sync), resyncSteps(ResyncOffer.WipeOnly, ResyncMode.FROM_SCRATCH))
    }

    @Test
    fun a_mode_the_gateway_cannot_do_is_refused() {
        assertThrows(ResyncNotOffered::class.java) { resyncSteps(ResyncOffer.WipeOnly, ResyncMode.IN_PLACE) }
        assertThrows(ResyncNotOffered::class.java) { resyncSteps(ResyncOffer.Unavailable, ResyncMode.FROM_SCRATCH) }
        assertThrows(ResyncNotOffered::class.java) {
            resyncSteps(ResyncOffer.Choice(listOf(ResyncMode.IN_PLACE)), ResyncMode.FROM_SCRATCH)
        }
    }
}
