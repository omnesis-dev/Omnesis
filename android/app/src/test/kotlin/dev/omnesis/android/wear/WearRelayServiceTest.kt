// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import com.google.android.gms.tasks.Task
import com.google.android.gms.wearable.CapabilityInfo
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Node
import dev.omnesis.android.R
import dev.omnesis.android.wearprotocol.AskRequest
import dev.omnesis.android.wearprotocol.AskResult
import dev.omnesis.android.wearprotocol.DictationGate
import dev.omnesis.android.wearprotocol.NoteAck
import dev.omnesis.android.wearprotocol.QueuedRelay
import dev.omnesis.android.wearprotocol.TextNote
import dev.omnesis.android.wearprotocol.VoiceNudge
import dev.omnesis.android.wearprotocol.WearCodec
import dev.omnesis.android.wearprotocol.WearDataLayer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The listener service as the system drives it: each callback reaches the relay, and nothing else does. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class WearRelayServiceTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var harness: RelayHarness
    private lateinit var service: WearRelayService

    @Before
    fun setUp() {
        harness = RelayHarness(CoroutineScope(SupervisorJob() + Dispatchers.Default), folder.root)
        // Not created: creating it would start Play services' own listener plumbing, which no test needs.
        service = Robolectric.buildService(WearRelayService::class.java).get()
        service.relayForTest = harness.relay
    }

    private fun settle() = runBlocking { withTimeout(5_000) { harness.relay.awaitIdle() } }

    /** The reply of a request, waited for off the main looper the way Play services does. */
    private fun reply(task: Task<ByteArray>?): ByteArray {
        val pending = requireNotNull(task)
        val deadline = System.currentTimeMillis() + 5_000
        while (!pending.isComplete) {
            check(System.currentTimeMillis() < deadline) { "no reply" }
            Thread.sleep(5)
        }
        return pending.result
    }

    private fun message(path: String, data: ByteArray) = object : MessageEvent {
        override fun getRequestId(): Int = 1
        override fun getPath(): String = path
        override fun getData(): ByteArray = data
        override fun getSourceNodeId(): String = WATCH
    }

    private fun capability(name: String, vararg nodeIds: String) = object : CapabilityInfo {
        override fun getName(): String = name
        override fun getNodes(): Set<Node> = nodeIds.map { id ->
            object : Node {
                override fun getId(): String = id
                override fun getDisplayName(): String = "Pixel Watch"
                override fun isNearby(): Boolean = true
            }
        }.toSet()
    }

    @Test
    fun an_ask_request_is_replied_to_with_the_relay_result() {
        val request = AskRequest("When is the budget review?", "ref-1")

        val result = WearCodec.decode(reply(service.onRequest(WATCH, WearDataLayer.ASK_PATH, WearCodec.encode(request))))

        assertEquals(AskResult("answered", "Tuesday at ten", "ref-1", "conversation-1", "message-1"), result)
        assertEquals(listOf(Asked("ask", "When is the budget review?", null)), harness.asker.asked)
    }

    @Test
    fun a_note_request_is_replied_to_with_its_ack() {
        val note = TextNote.of("Buy oat milk", CAPTURE_TIME, "ref-1")

        val ack = WearCodec.decode(reply(service.onRequest(WATCH, WearDataLayer.NOTE_PATH, WearCodec.encode(note))))

        assertEquals(NoteAck("saved", "ref-1"), ack)
        assertEquals("Buy oat milk", harness.notes.saved.single().text)
    }

    @Test
    fun a_request_on_any_other_path_is_not_the_relay_to_answer() {
        assertNull(service.onRequest(WATCH, WearDataLayer.CAPTURE_UPDATE_PATH, ByteArray(0)))
        assertNull(service.onRequest(WATCH, "/other-app/ask", WearCodec.encode(AskRequest("Question", "ref-1"))))
        assertTrue(harness.asker.asked.isEmpty())
    }

    @Test
    fun a_nudge_message_sets_the_relay_scanning_for_what_the_watch_put() {
        harness.gateway.stored += WearItem(
            WearDataLayer.queuedPath("ref-2"),
            WATCH,
            QueuedRelay(TextNote.of("Buy oat milk", CAPTURE_TIME, "ref-2"), queuedAt = CAPTURED_AT),
        )

        service.onMessageReceived(message(WearDataLayer.VOICE_NUDGE_PATH, WearCodec.encode(VoiceNudge)))
        settle()

        assertEquals("Buy oat milk", harness.notes.saved.single().text)
        assertEquals(1, harness.scheduler.holds)
    }

    @Test
    fun a_watch_app_coming_into_reach_is_told_the_gate() {
        service.onCapabilityChanged(capability(WearDataLayer.WATCH_CAPABILITY, WATCH))
        settle()

        assertTrue(harness.gateway.puts.single().message is DictationGate)
        assertEquals(WearDataLayer.GATE_PATH, harness.gateway.puts.single().path)
    }

    @Test
    fun a_watch_going_out_of_reach_or_another_capability_changes_nothing() {
        service.onCapabilityChanged(capability(WearDataLayer.WATCH_CAPABILITY))
        service.onCapabilityChanged(capability("another_capability", WATCH))
        settle()

        assertTrue(harness.gateway.sent.isEmpty())
        assertEquals(0, harness.scheduler.holds)
    }

    // The manifest is what makes Play services deliver anything at all.

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun delivered(action: String, path: String): Boolean {
        val intent = Intent(action, Uri.parse("wear://node-1$path")).setPackage(context.packageName)
        return context.packageManager.queryIntentServices(intent, 0)
            .any { it.serviceInfo.name == WearRelayService::class.java.name }
    }

    @Test
    fun the_manifest_delivers_every_path_the_watch_sends_on() {
        for (path in listOf(WearDataLayer.ASK_PATH, WearDataLayer.NOTE_PATH)) {
            assertTrue(path, delivered("com.google.android.gms.wearable.REQUEST_RECEIVED", path))
        }
        for (path in listOf(WearDataLayer.VOICE_NUDGE_PATH, WearDataLayer.DISPLAYED_PATH)) {
            assertTrue(path, delivered("com.google.android.gms.wearable.MESSAGE_RECEIVED", path))
        }
        for (path in listOf(WearDataLayer.recordingPath("ref-1"), WearDataLayer.queuedPath("ref-1"))) {
            assertTrue(path, delivered("com.google.android.gms.wearable.DATA_CHANGED", path))
        }
        assertTrue(
            delivered("com.google.android.gms.wearable.CAPABILITY_CHANGED", "/${WearDataLayer.WATCH_CAPABILITY}"),
        )
    }

    @Test
    fun the_manifest_does_not_wake_the_app_for_its_own_gate_or_another_app() {
        assertTrue(!delivered("com.google.android.gms.wearable.DATA_CHANGED", WearDataLayer.GATE_PATH))
        assertTrue(!delivered("com.google.android.gms.wearable.MESSAGE_RECEIVED", "/other-app/ask"))
        assertTrue(!delivered("com.google.android.gms.wearable.CAPABILITY_CHANGED", "/another_capability"))
    }

    @Test
    fun the_app_advertises_the_capability_the_watch_relays_to() {
        assertEquals(
            listOf(WearDataLayer.PHONE_CAPABILITY),
            context.resources.getStringArray(R.array.android_wear_capabilities).toList(),
        )
    }
}
