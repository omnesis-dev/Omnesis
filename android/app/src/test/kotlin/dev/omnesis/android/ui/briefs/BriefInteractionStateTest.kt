// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BriefInteractionStateTest {
    private fun brief(id: String) = BriefRecordDto(
        id = id,
        title = "Brief $id",
        createdAt = "2026-08-20T10:00:00Z",
    )

    @Test
    fun `opening another brief detail stops the first brief microphone before covering it`() {
        val first = brief("first")
        val second = brief("second")
        var microphoneBriefId: String? = first.id

        val overlay = openBriefDetail(second) { microphoneBriefId = null }

        assertEquals(second, overlay.brief)
        assertEquals(null, microphoneBriefId)
    }

    @Test
    fun `opening dismiss options stops feed work before presenting the sheet`() {
        val target = brief("target")
        var feedWorkRunning = true

        val overlay = openBriefDismiss(target, BriefDismissReasonDto.SNOOZED) {
            feedWorkRunning = false
        }

        assertFalse(feedWorkRunning)
        assertEquals(target, overlay.brief)
        assertEquals(BriefDismissReasonDto.SNOOZED, overlay.initialReason)
    }

    @Test
    fun `invalidated thread request cannot deliver its late callback`() {
        val gate = BriefThreadRequestGate()
        val request = gate.start()
        var navigated = false
        assertTrue(gate.owns(request))

        gate.invalidate()

        assertFalse(gate.owns(request))
        assertFalse(gate.runIfCurrent(request) { navigated = true })
        assertFalse(navigated)
        assertTrue(gate.owns(gate.start()))
    }
}
