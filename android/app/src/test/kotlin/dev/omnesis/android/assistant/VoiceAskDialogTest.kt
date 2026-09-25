// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class VoiceAskDialogTest {
    @Test
    fun still_working_does_not_promise_unverified_notification_delivery() {
        assertEquals(
            "Omnesis is still working. Open the conversation in Omnesis to check the answer.",
            VoiceAskDialog.text(VoiceAskOutcome.StillWorking),
        )
    }

    @Test fun uncertain_delivery_warns_against_duplicate_retry() {
        assertEquals(
            "The connection dropped while sending. Check the conversation in Omnesis before asking again.",
            VoiceAskDialog.text(VoiceAskOutcome.DeliveryUncertain),
        )
    }

    @Test fun `spoken failure uses only a short first line`() {
        assertEquals(
            "Sorry — The assigned model is unavailable.",
            VoiceAskDialog.spokenFailure("The assigned model is unavailable\nprivate provider detail"),
        )
    }

    @Test fun `blank and wall sized failures use safe generic copy`() {
        val generic = VoiceAskDialog.spokenFailure(null)
        assertEquals(generic, VoiceAskDialog.spokenFailure("   "))
        assertEquals(generic, VoiceAskDialog.spokenFailure("x".repeat(161)))
        assertFalse(generic.contains("x".repeat(20)))
    }
}
