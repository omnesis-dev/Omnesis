// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.GatePublishing
import dev.omnesis.android.wearprotocol.WearDataLayer
import dev.omnesis.android.wearprotocol.captureButtons
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatePublisherTest {
    private val gateway = FakeWearGateway()
    private val store = FakeStateStore()
    private var now = 1_000_000L
    private val publisher = GatePublisher(gateway, store) { now }

    private val unpaired = GateKnowledge(paired = false, status = null)
    private val unknown = GateKnowledge(paired = true, status = null)
    private fun known(maxAudioBytes: Long? = null, decisionGate: Boolean = false) =
        GateKnowledge(paired = true, status = RelayGatewayStatus(maxAudioBytes, decisionGate))

    private fun published(): List<DictationGate> = gateway.puts.map {
        assertEquals(WearDataLayer.GATE_PATH, it.path)
        it.message as DictationGate
    }

    @Test
    fun an_unpaired_phone_tells_the_watch_it_cannot_capture() = runTest {
        assertTrue(publisher.update(unpaired))

        val gate = published().single()
        assertEquals(DictationGate(active = false, maxAudioBytes = 0, updatedAt = now), gate)
        assertEquals(CaptureButtons.UNSUPPORTED, captureButtons(gate, now, followUp = false))
        assertEquals(gate, store.gate)
    }

    @Test
    fun a_paired_phone_says_nothing_until_it_has_read_the_gateway_status() = runTest {
        assertFalse(publisher.update(unknown))
        assertFalse(publisher.update(unknown, force = true))
        assertTrue(gateway.puts.isEmpty())
        assertNull(store.gate)
    }

    @Test
    fun the_gate_carries_what_the_status_says() = runTest {
        publisher.update(known(maxAudioBytes = 4_000_000, decisionGate = true))
        assertEquals(
            DictationGate(
                active = true,
                maxAudioBytes = 4_000_000,
                updatedAt = now,
                decisionGate = true,
                captureSupported = true,
            ),
            published().single(),
        )
        assertEquals(CaptureButtons.SEND, captureButtons(published().single(), now, followUp = false))
    }

    @Test
    fun a_gateway_that_does_not_transcribe_still_supports_capture_with_ask_and_tell() = runTest {
        publisher.update(known())
        val gate = published().single()
        assertFalse(gate.active)
        assertTrue(gate.captureSupported)
        assertEquals(CaptureButtons.ASK_AND_TELL, captureButtons(gate, now, followUp = false))
    }

    @Test
    fun an_unchanged_gate_is_published_once_and_again_after_a_day() = runTest {
        val knowledge = known(maxAudioBytes = 4_000_000)
        assertTrue(publisher.update(knowledge))
        now += GatePublishing.REFRESH_INTERVAL.inWholeMilliseconds - 1
        assertFalse(publisher.update(knowledge))
        now += 1
        assertTrue(publisher.update(knowledge))

        assertEquals(2, published().size)
        assertEquals(now, published().last().updatedAt)
    }

    @Test
    fun each_field_that_changes_publishes_a_new_gate() = runTest {
        publisher.update(known(maxAudioBytes = 4_000_000))
        assertTrue(publisher.update(known(maxAudioBytes = 2_000_000)))
        assertTrue(publisher.update(known(maxAudioBytes = 2_000_000, decisionGate = true)))
        assertTrue(publisher.update(known(decisionGate = true)))
        assertTrue(publisher.update(unpaired))
        assertTrue("pairing again publishes once the status is read", publisher.update(known()))
        assertEquals(6, published().size)
    }

    @Test
    fun a_watch_that_connects_is_told_the_gate_even_when_it_has_not_changed() = runTest {
        val knowledge = known(maxAudioBytes = 4_000_000)
        publisher.update(knowledge)
        now += 60_000
        assertTrue(publisher.update(knowledge, force = true))
        assertEquals(listOf(1_000_000L, 1_060_000L), published().map { it.updatedAt })
    }

    @Test
    fun a_gate_that_could_not_be_written_is_tried_again() = runTest {
        gateway.failPuts = true
        assertFalse(publisher.update(known()))
        assertNull(store.gate)

        gateway.failPuts = false
        assertTrue(publisher.update(known()))
        assertEquals(1, published().size)
    }
}
