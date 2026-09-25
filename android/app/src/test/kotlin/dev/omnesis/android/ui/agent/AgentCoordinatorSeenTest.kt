// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Collections

/**
 * Who is allowed to tell the gateway a conversation is being read.
 *
 * The rule this pins: only the surface that renders the transcript may say so.
 * A claim from anywhere else is not a cosmetic slip — the gateway treats
 * content arriving into a conversation it believes is on screen as seen on
 * arrival and opens no unread episode, so a false claim destroys that answer's
 * dot and its notification on every surface rather than delaying them.
 *
 * The case that motivated this: a headless wake (a periodic sync worker, or the
 * arrival of the push itself) constructs the session and auto-resumes the most
 * recent conversation with no UI in existence.
 *
 * All fixture data is invented.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AgentCoordinatorSeenTest {
    private lateinit var server: MockWebServer
    private val seenRequests: MutableList<Pair<String, String>> =
        Collections.synchronizedList(mutableListOf())

    @Before fun setUp() {
        Dispatchers.setMain(kotlinx.coroutines.test.UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                return when {
                    path.contains("/seen") -> {
                        seenRequests += path to request.body.readUtf8()
                        MockResponse().setBody("""{"ok":true}""")
                    }
                    path.startsWith("/agent/events") -> MockResponse().setResponseCode(200).setBody("")
                    path.startsWith("/agent/sessions") ->
                        MockResponse().setBody(
                            """{"sessionId":"conv_a","model":"m","backend":"b","title":"Permit decision"}""",
                        )
                    path.startsWith("/agent/conversations") ->
                        MockResponse().setBody("""{"conversations":[],"nextCursor":null}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun client() = AgentClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))
    private fun eventSource() = AgentEventSource(OkHttpClient(), server.url("/").toString(), "tok")

    private fun await(timeoutMs: Long = 3_000, predicate: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return true
            Thread.sleep(15)
        }
        return predicate()
    }

    @Test
    fun resuming_a_conversation_does_not_claim_it_is_on_screen() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(), AgentCoordinator.UiState(hasClient = true),
        )
        coord.resumeConversation("conv_a")
        // Give any stray claim time to escape before asserting its absence.
        await(500) { seenRequests.isNotEmpty() }
        assertTrue(
            "resuming is not rendering: a headless wake resumes with no UI at all",
            seenRequests.isEmpty(),
        )
    }

    @Test
    fun the_surface_claims_it_and_withdraws_it() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(), AgentCoordinator.UiState(hasClient = true),
        )
        coord.conversationSurfaceVisible("conv_a", true)
        assertTrue(await { seenRequests.any { it.second.contains("\"viewing\":true") } })

        coord.conversationSurfaceVisible("conv_a", false)
        assertTrue(await { seenRequests.any { it.second.contains("\"viewing\":false") } })
        assertEquals(
            "/agent/conversations/conv_a/seen",
            seenRequests.first().first,
        )
    }

    @Test
    fun backgrounding_withdraws_the_visible_conversation_and_foregrounding_reclaims_it() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(), AgentCoordinator.UiState(hasClient = true),
        )
        coord.conversationSurfaceVisible("conv_a", true)
        assertTrue(await { seenRequests.count { it.second.contains("\"viewing\":true") } == 1 })

        coord.appVisibilityChanged(false)
        assertTrue(await { seenRequests.any { it.second.contains("\"viewing\":false") } })

        coord.appVisibilityChanged(true)
        assertTrue(await { seenRequests.count { it.second.contains("\"viewing\":true") } == 2 })
        assertEquals(
            listOf(true, false, true),
            seenRequests.take(3).map { it.second.contains("\"viewing\":true") },
        )
    }

    @Test
    fun a_surface_composed_in_the_background_waits_to_claim_until_foreground() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(), AgentCoordinator.UiState(hasClient = true),
        )
        coord.appVisibilityChanged(false)
        coord.conversationSurfaceVisible("conv_a", true)
        await(500) { seenRequests.isNotEmpty() }
        assertTrue(seenRequests.isEmpty())

        coord.appVisibilityChanged(true)
        assertTrue(await { seenRequests.any { it.second.contains("\"viewing\":true") } })
    }

    @Test
    fun a_retiring_surface_cannot_release_its_replacement() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(), AgentCoordinator.UiState(hasClient = true),
        )
        coord.conversationSurfaceVisible("conv_a", true)
        assertTrue(await { seenRequests.any { it.first.contains("conv_a") } })
        coord.conversationSurfaceVisible("conv_b", true)
        assertTrue(await { seenRequests.any { it.first.contains("conv_b") } })

        val beforeStaleDispose = seenRequests.size
        coord.conversationSurfaceVisible("conv_a", false)
        await(500) { seenRequests.size > beforeStaleDispose }
        assertEquals(beforeStaleDispose, seenRequests.size)
    }

    @Test
    fun showing_a_conversation_drops_its_dot_before_the_wire_answers() {
        val coord = AgentCoordinator()
        coord.attachForTesting(
            client(), eventSource(),
            AgentCoordinator.UiState(
                hasClient = true,
                conversations = listOf(
                    ConversationSummary(sessionId = "conv_a", title = "Permit decision", unread = true),
                    ConversationSummary(sessionId = "conv_b", title = "Trip planning", unread = true),
                ),
            ),
        )
        coord.conversationSurfaceVisible("conv_a", true)
        val rows = coord.state.value.conversations
        assertFalse("the conversation on screen drops its dot at once", rows.first { it.sessionId == "conv_a" }.unread)
        assertTrue("other conversations keep theirs", rows.first { it.sessionId == "conv_b" }.unread)
    }
}
