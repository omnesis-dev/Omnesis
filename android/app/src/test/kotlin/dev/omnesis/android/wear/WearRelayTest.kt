// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.DisplayedReceipt
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceNudge
import dev.omnesis.android.wearprotocol.VoiceRecording
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The relay as one piece: what each watch event sets off, and what holds the process while it runs. */
@OptIn(ExperimentalCoroutinesApi::class)
class WearRelayTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val ref = "5f0c3b1e-8a47-4f6e-9d2b-7c1a2e3f4b5d"
    private var harness: RelayHarness? = null

    /**
     * The relay over a scope of its own on the test's scheduler, as the app gives it one: its
     * work is not the test's child, so a caller that stops waiting does not end it.
     */
    private fun TestScope.harness(): RelayHarness = harness
        ?: RelayHarness(CoroutineScope(StandardTestDispatcher(testScheduler) + SupervisorJob()), folder.root)
            .also { harness = it }

    private fun TestScope.relay(): WearRelay = harness().relay
    private val gateway get() = harness!!.gateway
    private val asker get() = harness!!.asker
    private val notes get() = harness!!.notes
    private val backend get() = harness!!.backend
    private val scheduler get() = harness!!.scheduler
    private val store get() = harness!!.store

    private fun recordingItem() = WearItem(
        WearDataLayer.recordingPath(ref),
        WATCH,
        VoiceRecording(ref, CAPTURE_TIME, "en_GB", CaptureRoute.NOTE).toMetadata(),
    ) { file -> file.writeBytes(byteArrayOf(1, 2, 3)); true }

    @Test
    fun an_ask_request_is_answered_with_the_encoded_result_and_holds_the_process_meanwhile() = runTest {
        val relay = relay()
        asker.gate = CompletableDeferred()
        val reply = async { relay.onRequest(WATCH, WearDataLayer.ASK_PATH, WearCodec.encode(AskRequest("Question", "ref-1"))) }
        runCurrent()

        assertEquals(1, scheduler.holds)
        val idle = async { relay.awaitIdle() }
        runCurrent()
        assertFalse("the relay is busy until the turn settles", idle.isCompleted)

        asker.gate?.complete(Unit)
        val result = WearCodec.decode(reply.await()!!) as AskResult
        assertEquals(AskOutcome.Answered("Tuesday at ten"), result.toOutcome())
        assertEquals("ref-1", result.ref)
        idle.await()
    }

    @Test
    fun what_holds_the_process_outlasts_the_gap_between_a_nudge_and_the_item_it_announced() = runTest {
        val relay = relay()
        relay.onMessage(WearDataLayer.VOICE_NUDGE_PATH, WearCodec.encode(VoiceNudge))
        val quiet = async { relay.awaitQuiet() }
        runCurrent()
        assertFalse("idle, but not for long enough to let go", quiet.isCompleted)

        // The DataItem lands a moment later and its work begins.
        advanceTimeBy(WearRelay.IDLE_LINGER.inWholeMilliseconds - 1)
        asker.gate = CompletableDeferred()
        val reply = async { relay.onRequest(WATCH, WearDataLayer.ASK_PATH, WearCodec.encode(AskRequest("Question", "ref-1"))) }
        advanceTimeBy(WearRelay.IDLE_LINGER.inWholeMilliseconds * 2)
        assertFalse("held for as long as the work runs", quiet.isCompleted)

        asker.gate?.complete(Unit)
        reply.await()
        advanceTimeBy(WearRelay.IDLE_LINGER.inWholeMilliseconds - 1)
        runCurrent()
        assertFalse(quiet.isCompleted)
        advanceTimeBy(2)
        runCurrent()
        assertTrue(quiet.isCompleted)
    }

    @Test
    fun an_ask_keeps_running_and_sends_its_result_when_the_caller_stops_waiting() = runTest {
        val relay = relay()
        asker.gate = CompletableDeferred()
        val reply = async { relay.onRequest(WATCH, WearDataLayer.ASK_PATH, WearCodec.encode(AskRequest("Question", "ref-1"))) }
        runCurrent()

        // The listener service was destroyed mid-turn.
        reply.cancel()
        asker.gate?.complete(Unit)
        advanceUntilIdle()

        val result = gateway.messagesOn(WearDataLayer.RESULT_PATH).single() as AskResult
        assertEquals(AskOutcome.Answered("Tuesday at ten"), result.toOutcome())
    }

    @Test
    fun a_note_request_is_answered_with_its_ack() = runTest {
        val relay = relay()
        val note = TextNote.of("Buy oat milk", CAPTURE_TIME, "ref-1")
        val reply = relay.onRequest(WATCH, WearDataLayer.NOTE_PATH, WearCodec.encode(note))
        assertEquals(NoteAck("saved", "ref-1"), WearCodec.decode(reply!!))
        assertEquals("Buy oat milk", notes.saved.single().text)
    }

    @Test
    fun a_request_that_cannot_be_read_gets_a_stated_failure() = runTest {
        val relay = relay()
        val garbage = "not json".encodeToByteArray()
        assertEquals(AskResult("failed"), WearCodec.decode(relay.onRequest(WATCH, WearDataLayer.ASK_PATH, garbage)!!))
        assertEquals(NoteAck("relayFailed"), WearCodec.decode(relay.onRequest(WATCH, WearDataLayer.NOTE_PATH, garbage)!!))
        // A note sent on the ask path is not a question.
        val note = WearCodec.encode(TextNote.of("Buy oat milk", CAPTURE_TIME, "ref-1"))
        assertEquals(AskResult("failed"), WearCodec.decode(relay.onRequest(WATCH, WearDataLayer.ASK_PATH, note)!!))
        assertTrue(asker.asked.isEmpty() && notes.saved.isEmpty())
    }

    @Test
    fun a_path_the_relay_does_not_serve_gets_no_reply() = runTest {
        assertNull(relay().onRequest(WATCH, "/omnesis/unknown", ByteArray(0)))
        assertEquals(0, scheduler.holds)
    }

    @Test
    fun a_recording_item_is_processed_and_a_queued_item_handled() = runTest {
        val relay = relay()
        backend.gatewayDictation = true
        relay.onItem(recordingItem())
        relay.onItem(
            WearItem(
                WearDataLayer.queuedPath("ref-2"),
                WATCH,
                QueuedRelay(TextNote.of("Buy oat milk", CAPTURE_TIME, "ref-2"), queuedAt = CAPTURED_AT),
            ),
        )
        advanceUntilIdle()
        relay.awaitIdle()

        assertEquals(listOf("", "Buy oat milk"), notes.saved.map { it.text })
        assertEquals(1, scheduler.holds)
    }

    @Test
    fun a_nudge_picks_up_the_items_no_callback_delivered() = runTest {
        val relay = relay()
        backend.gatewayDictation = true
        gateway.stored += recordingItem()
        gateway.stored += WearItem(
            WearDataLayer.queuedPath("ref-2"),
            WATCH,
            QueuedRelay(AskRequest("When is the budget review?", "ref-2"), queuedAt = CAPTURED_AT),
        )

        relay.onMessage(WearDataLayer.VOICE_NUDGE_PATH, WearCodec.encode(VoiceNudge))
        advanceUntilIdle()

        assertEquals(1, notes.saved.size)
        assertEquals(listOf(Asked("handOff", "When is the budget review?", null)), asker.asked)
        assertTrue("handled items are gone from the data layer", gateway.stored.isEmpty())
    }

    @Test
    fun a_display_receipt_sent_on_its_own_reaches_the_pipeline() = runTest {
        val relay = relay()
        gateway.reply = null
        relay.onItem(
            WearItem(
                WearDataLayer.recordingPath(ref),
                WATCH,
                VoiceRecording(ref, CAPTURE_TIME, "en_GB", CaptureRoute.ASK).toMetadata(),
            ) { file -> file.writeBytes(byteArrayOf(1)); true },
        )
        advanceUntilIdle()
        assertTrue(backend.seen.isEmpty())

        relay.onMessage(WearDataLayer.DISPLAYED_PATH, WearCodec.encode(DisplayedReceipt(true, ref)))
        advanceUntilIdle()

        assertEquals(listOf("conversation-1" to "message-1"), backend.seen)
    }

    @Test
    fun a_watch_coming_into_reach_is_told_the_gate_and_arranges_its_daily_refresh_once() = runTest {
        val relay = relay()
        relay.onWatchConnected()
        relay.onWatchConnected()
        advanceUntilIdle()

        val gates = gateway.puts.map { it.message as DictationGate }
        assertEquals(2, gates.size)
        assertTrue(gates.all { it.active && it.decisionGate && it.captureSupported && it.maxAudioBytes == 4_000_000L })
        assertTrue(store.known)
        assertEquals(1, scheduler.gateRefreshes)
    }

    @Test
    fun a_gate_refresh_writes_only_what_changed_and_holds_nothing() = runTest {
        val relay = relay()
        relay.refreshGate()
        relay.refreshGate()
        harness().knowledge = GateKnowledge(paired = false, status = null)
        relay.refreshGate()

        assertEquals(2, gateway.puts.size)
        assertEquals(0, scheduler.holds)
        assertEquals("a phone no watch has reached arranges no refresh", 0, scheduler.gateRefreshes)
        relay.ensureGateRefresh()
        assertEquals(0, scheduler.gateRefreshes)
    }

    @Test
    fun the_first_event_from_a_watch_arranges_the_refresh_and_later_processes_keep_it() = runTest {
        relay().onMessage(WearDataLayer.VOICE_NUDGE_PATH, WearCodec.encode(VoiceNudge))
        advanceUntilIdle()
        assertEquals(1, scheduler.gateRefreshes)
        relay().onMessage(WearDataLayer.VOICE_NUDGE_PATH, WearCodec.encode(VoiceNudge))
        assertEquals("a watch already known arranges nothing again", 1, scheduler.gateRefreshes)

        // What the next app process does at start.
        relay().ensureGateRefresh()
        assertEquals(2, scheduler.gateRefreshes)
    }
}
