// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CopyOnWriteArrayList

/**
 * What a person types into the blank Ask screen while the app is still loading the conversation
 * list it chooses its launch conversation from. The words are typed while the list request is in
 * flight, which is the ordering a quick typist on a cold launch produces. The iOS twin is
 * `LaunchSessionDraftTests`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class LaunchDraftTest {
    private lateinit var server: MockWebServer
    private val paths = CopyOnWriteArrayList<String>()
    private val store = AgentComposerStore()
    private val coordinator = AgentCoordinator(store)

    @Before fun setUp() {
        Dispatchers.setMain(Dispatchers.Unconfined)
        server = MockWebServer()
        server.start()
        coordinator.attachForTesting(
            AgentClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")),
            AgentEventSource(OkHttpClient(), server.url("/").toString(), "tok"),
            AgentCoordinator.UiState(hasClient = true),
        )
    }

    @After fun tearDown() {
        // The resume's own request can outlive the assertions; join the coordinator's scope
        // before resetting Main.
        coordinator.teardown()
        val scope = AgentCoordinator::class.java.getDeclaredField("scope").apply { isAccessible = true }
        try {
            runBlocking {
                val job = checkNotNull((scope.get(coordinator) as CoroutineScope).coroutineContext[Job])
                withTimeout(5_000) { job.cancelAndJoin() }
            }
        } finally {
            server.shutdown()
            Dispatchers.resetMain()
        }
    }

    /** Serves [conversations] as the list, running [whileListing] before it is answered. */
    private fun serve(conversations: String, whileListing: () -> Unit = {}) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                paths += path
                return when {
                    path.startsWith("/agent/conversations") -> {
                        whileListing()
                        MockResponse().setBody(conversations)
                    }
                    path.startsWith("/agent/sessions") -> MockResponse().setBody(
                        """{"sessionId":"s_stored","model":"m","backend":"b","messages":[]}""",
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
    }

    @Test
    fun words_typed_while_the_list_loads_keep_the_new_conversation_on_screen() {
        store.write("", "s_stored", ComposerRecord(text = "The stored conversation's own draft"))
        serve(STORED) { coordinator.updateDraft("Where was I", null) }
        val generation = coordinator.state.value.composerGeneration

        runBlocking { coordinator.bootstrapForTesting() }

        val state = coordinator.state.value
        assertNull("the conversation being written in stays on screen", state.sessionId)
        assertEquals("Where was I", state.composer.text)
        assertEquals("the field is not rebuilt under the typist", generation, state.composerGeneration)
        assertFalse(paths.any { it.startsWith("/agent/sessions") })
        assertEquals("The stored conversation's own draft", store.read("", "s_stored").text)
    }

    @Test
    fun words_typed_on_a_first_launch_keep_their_field() {
        serve(EMPTY) { coordinator.updateDraft("Where was I", null) }
        val generation = coordinator.state.value.composerGeneration

        runBlocking { coordinator.bootstrapForTesting() }

        assertEquals("Where was I", coordinator.state.value.composer.text)
        assertEquals(generation, coordinator.state.value.composerGeneration)
    }

    @Test
    fun without_typing_the_launch_opens_the_stored_conversation_with_its_own_draft() {
        store.write("", "s_stored", ComposerRecord(text = "The stored conversation's own draft"))
        // Left in a new conversation on an earlier launch; nothing typed now.
        store.write("", null, ComposerRecord(text = "An earlier unsent question"))
        serve(STORED)

        runBlocking { coordinator.bootstrapForTesting() }

        assertEquals("s_stored", coordinator.state.value.sessionId)
        assertEquals("The stored conversation's own draft", coordinator.state.value.composer.text)
        assertEquals("An earlier unsent question", store.read("", null).text)
    }

    private companion object {
        const val EMPTY = """{"conversations":[],"nextCursor":null}"""
        const val STORED = """{"conversations":[{"id":"s_stored","title":"An invented chat","model":"m",
            "backend":"b","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z",
            "messageCount":2,"pinned":false}],"nextCursor":null}"""
    }
}
