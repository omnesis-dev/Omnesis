// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.client.ConversationControls
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ConversationSubmissionTest {
    private lateinit var server: MockWebServer
    private val coordinators = mutableListOf<AgentCoordinator>()
    private val submissions = CopyOnWriteArrayList<String>()
    private var reject = true
    private var oldGateway = false

    @Before fun setup() {
        Dispatchers.setMain(Dispatchers.Unconfined)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.endsWith("/controls") == true -> if (oldGateway) MockResponse().setResponseCode(404).setBody("""{"error":"NOT_FOUND","message":"Not found"}""")
                    else MockResponse().setBody("""{"busy":true,"queuedMessages":[],"future":true}""")
                request.path?.endsWith("/submissions") == true -> {
                    submissions += request.body.readUtf8()
                    if (reject) MockResponse().setResponseCode(503).setBody("""{"error":"UNAVAILABLE","message":"Unavailable"}""")
                    else MockResponse().setBody("""{"submission":{"id":"accepted","text":"Use annual totals","status":"queued"}}""")
                }
                request.path?.endsWith("/seen") == true -> MockResponse().setBody("""{"ok":true}""")
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
    }

    @After fun cleanup() {
        coordinators.forEach { it.teardown() }
        val field = AgentCoordinator::class.java.getDeclaredField("scope").apply { isAccessible = true }
        runBlocking { coordinators.forEach { (field.get(it) as CoroutineScope).coroutineContext[Job]?.cancelAndJoin() } }
        server.shutdown()
        Dispatchers.resetMain()
    }

    private fun coordinator(store: AgentComposerStore = AgentComposerStore(), supported: Boolean = true, busy: Boolean = true, turns: List<AgentTurn> = emptyList()): AgentCoordinator {
        val http = OkHttpClient()
        val base = server.url("/").toString()
        return AgentCoordinator(store).also {
            coordinators += it
            it.attachForTesting(AgentClient(GatewayHttp(http, base, "example-token")), AgentEventSource(http, base, "example-token"),
                AgentCoordinator.UiState(sessionId = "session-one", hasClient = true, controlsAvailable = supported,
                    controls = ConversationControls(busy = busy), chat = AgentChatState(busy = busy, turns = turns), composer = store.read("", "session-one")))
        }
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!predicate() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue("Expected asynchronous state to settle", predicate())
    }

    @Test fun uncertainDeliverySurvivesCoordinatorRecreationAndRetriesSameId() {
        val store = AgentComposerStore()
        val first = coordinator(store)
        first.submitFollowUp("Use annual totals", interrupt = true)
        await { first.state.value.submissionsSending.isEmpty() && submissions.size == 1 }
        val saved = store.read("", "session-one").pending.single()
        first.teardown()
        val resumed = coordinator(store)
        assertEquals(saved, resumed.state.value.composer.pending.single())
        reject = false
        resumed.retrySubmission(saved.clientMessageId)
        await { submissions.size == 2 && resumed.state.value.composer.pending.isEmpty() }
        assertEquals(submissions[0], submissions[1])
        assertEquals("interrupt", saved.mode)
        assertTrue(store.read("", "session-one").pending.isEmpty())
    }

    @Test fun rejectedSubmissionCanBeEditedWithoutDiscardingResearchMode() {
        val coord = coordinator()
        coord.submitFollowUp("Compare annual totals", deepResearch = true)
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        val pending = coord.state.value.composer.pending.single()
        coord.editPendingSubmission(pending.clientMessageId)
        assertEquals("Compare annual totals", coord.state.value.composer.text)
        assertEquals("deep-research", coord.state.value.composer.commandId)
        assertTrue(coord.state.value.composer.editingPrompt)
        assertEquals(pending, coord.state.value.composer.pending.single())
        coord.cancelPromptEdit()
        assertEquals(pending, coord.state.value.composer.pending.single())
    }

    @Test fun legacyDraftRemainsDurableUntilAcknowledgement() {
        val store = AgentComposerStore()
        val coord = coordinator(store, supported = false, busy = false)
        coord.updateDraft("Keep this question", "deep-research")
        coord.send("Keep this question", deepResearch = true)
        coord.finishDraftSubmission()
        assertEquals("Keep this question", store.read("", "session-one").text)
        assertEquals("deep-research", store.read("", "session-one").commandId)
    }

    @Test fun failedResearchRetryDoesNotAnswerAnUnrelatedQuestion() {
        val coord = coordinator()
        val state = coord.state.value
        val http = OkHttpClient()
        val base = server.url("/").toString()
        coord.attachForTesting(AgentClient(GatewayHttp(http, base, "example-token")), AgentEventSource(http, base, "example-token"),
            state.copy(controls = ConversationControls(busy = true,
                pendingClarification = dev.omnesis.android.transport.client.ConversationClarification("another-question", "Which period?"),
                queuedMessages = listOf(dev.omnesis.android.transport.client.ConversationSubmission("failed-id", "Compare totals", "failed", deepResearch = true)))))
        coord.retrySubmission("failed-id")
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        val retry = coord.state.value.composer.pending.single()
        assertEquals(true, retry.deepResearch)
        assertNull(retry.clarificationId)
        assertNotEquals("failed-id", retry.clientMessageId)
    }

    @Test fun idleSendOnCapableGatewayKeepsDurableSubmissionUntilAcknowledged() {
        val coord = coordinator(busy = false)
        coord.send("Use annual totals")
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        assertEquals("Use annual totals", coord.state.value.composer.pending.single().text)
    }

    @Test fun oldGatewayKeepsLegacyBusyGateAndDraft() {
        oldGateway = true
        val coord = coordinator(supported = true)
        coord.conversationSurfaceVisible("session-one", true)
        await { !coord.state.value.controlsAvailable }
        assertFalse(coord.state.value.controlsAvailable)
        coord.send("Keep this draft")
        assertEquals("Keep this draft", coord.state.value.sendRejectedText)
        assertTrue(submissions.isEmpty())
    }

    @Test fun editingPreservesOriginalDraftAcrossCancelAndSend() {
        val coord = coordinator()
        coord.updateDraft("Unsent next question", "deep-research")
        coord.editPrompt("Correct the earlier question")
        coord.updateDraft("Corrected question", null)
        coord.cancelPromptEdit()
        assertEquals("Unsent next question", coord.state.value.composer.text)
        assertEquals("deep-research", coord.state.value.composer.commandId)
        coord.editPrompt("Another correction")
        coord.finishDraftSubmission()
        assertEquals("Unsent next question", coord.state.value.composer.text)
        assertFalse(coord.state.value.composer.editingPrompt)
    }

    @Test fun editAppendsViaComposerWithoutMutatingOriginalTurns() {
        val coord = coordinator(turns = listOf(AgentTurn.User("prior-user", "Compare the estimates"), AgentTurn.Assistant("prior-answer")))
        val before = coord.state.value.chat.turns
        coord.editPrompt("Updated comparison")
        assertEquals(before, coord.state.value.chat.turns)
        assertEquals("Updated comparison", coord.state.value.composer.text)
    }
}
