// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog.setup

import dev.omnesis.android.setup.flow.SetupOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CallLogSetupOutcomeTest {
    @Test
    fun aGrantIsOnAndADenialIsOff() {
        assertEquals(SetupOutcome.On, callLogSetupOutcome(granted = true))
        assertEquals(SetupOutcome.NotAllowed, callLogSetupOutcome(granted = false))
    }

    @Test
    fun theDisclosureNamesBackgroundAccessAndTheAudioIsNeverRead() {
        assertTrue(CallLogSetupCopy.disclosure!!.contains("including while the app is closed"))
        assertEquals("Never", CallLogSetupCopy.ledger!!.staysLabel)
        assertEquals(listOf("Call audio"), CallLogSetupCopy.ledger!!.stays)
    }
}
