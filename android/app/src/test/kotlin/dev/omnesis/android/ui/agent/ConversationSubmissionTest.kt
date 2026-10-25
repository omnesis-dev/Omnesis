// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.client.ConversationSubmission
import dev.omnesis.android.transport.client.ConversationControls
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
    private var submissionReply: (() -> MockResponse)? = null
    private var sendNowReply: (() -> MockResponse)? = null
    private var requireQueueMode = false
    private var reject = true
    private var oldGateway = false
    private val controlsRequests = java.util.concurrent.atomic.AtomicInteger()
    private var controlsBody = """{"busy":true,"queuedMessages":[],"future":true}"""

    @Before fun setup() {
        Dispatchers.setMain(Dispatchers.Unconfined)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.endsWith("/queue/send-now") == true -> sendNowReply?.invoke() ?: MockResponse().setResponseCode(503)
                request.path?.endsWith("/controls") == true -> {
                    controlsRequests.incrementAndGet()
                    if (oldGateway) MockResponse().setResponseCode(404).setBody("""{"error":"NOT_FOUND","message":"Not found"}""")
                    else MockResponse().setBody(controlsBody)
                }
                request.path?.endsWith("/submissions") == true -> {
                    val payload = request.body.readUtf8()
                    submissions += payload
                    if (requireQueueMode && OmnesisJson.parseToJsonElement(payload).jsonObject["mode"]?.jsonPrimitive?.content != "queue") {
                        MockResponse().setResponseCode(400).setBody("""{"error":"INVALID_BODY","message":"mode must be queue or interrupt"}""")
                    } else submissionReply?.invoke() ?: if (reject) MockResponse().setResponseCode(503).setBody("""{"error":"UNAVAILABLE","message":"Unavailable"}""")
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

    private fun coordinator(store: AgentComposerStore = AgentComposerStore(), supported: Boolean = true, busy: Boolean = true, turns: List<AgentTurn> = emptyList(), sendNow: Boolean = false): AgentCoordinator {
        val http = OkHttpClient()
        val base = server.url("/").toString()
        return AgentCoordinator(store).also {
            coordinators += it
            it.attachForTesting(AgentClient(GatewayHttp(http, base, "example-token")), AgentEventSource(http, base, "example-token"),
                AgentCoordinator.UiState(sessionId = "session-one", hasClient = true, controlsAvailable = supported,
                    controls = ConversationControls(busy = busy, queuedMessages = if (sendNow) listOf(ConversationSubmission("queued", "Follow up", "queued")) else emptyList(), capabilities = dev.omnesis.android.transport.client.ConversationCapabilities(queueSendNow = sendNow)), chat = AgentChatState(busy = busy, turns = turns), composer = store.read("", "session-one")))
        }
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!predicate() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue("Expected asynchronous state to settle", predicate())
    }

    @Test fun sendNowDismissesImmediatelyAndFailureKeepsContentAndReleasesBarrier() {
        val coord = coordinator(sendNow = true, turns = listOf(AgentTurn.Assistant("old", listOf(
            AgentPart.Text("Saved answer"), AgentPart.Tool(AgentToolCall("search", "search_documents")),
        ))))
        coord.sendQueuedNow(listOf("queued"))
        val assistant = coord.state.value.chat.turns.single() as AgentTurn.Assistant
        assertEquals(AgentPart.Text("Saved answer"), assistant.parts.first())
        assertFalse(interruptedToolVisible((assistant.parts.last() as AgentPart.Tool).call))
        await { coord.state.value.chat.lastTurnError != null }
        assertFalse(coord.state.value.chat.dismissToolsUntilUserMessage)
        assertTrue(coord.state.value.chat.lastTurnError!!.startsWith("Could not send queued messages"))
    }

    @Test fun sendNowHandoffHidesOnlySelectedReceiptsInEitherEventResponseOrder() {
        for (eventFirst in listOf(true, false)) {
            val entered = java.util.concurrent.CountDownLatch(1)
            val release = java.util.concurrent.CountDownLatch(1)
            sendNowReply = {
                entered.countDown()
                check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                MockResponse().setBody("""{"busy":true,"queuedMessages":[{"id":"queued","text":"Follow up","status":"queued"},{"id":"new-id","text":"Follow up","status":"queued"}]}""")
            }
            val coord = coordinator(sendNow = true)
            coord.sendQueuedNow(listOf("queued"))
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            assertTrue(coord.state.value.visibleQueuedMessages.isEmpty())
            assertEquals(1, coord.state.value.controls.queuedMessages.size)
            if (eventFirst) coord.applyEventForTesting(AgentEvent.UserMessage("session-one", "random-message", "Follow up"))
            release.countDown()
            await { coord.state.value.controls.queuedMessages.size == 2 }
            if (!eventFirst) coord.applyEventForTesting(AgentEvent.UserMessage("session-one", "random-message", "Follow up"))
            assertEquals(listOf("new-id"), coord.state.value.visibleQueuedMessages.map { it.id })
            assertEquals(1, coord.state.value.chat.turns.filterIsInstance<AgentTurn.User>().size)
            // A failed receipt must remain actionable even if a prior queued snapshot was hidden.
            val failed = coord.state.value.copy(controls = ConversationControls(queuedMessages = listOf(
                ConversationSubmission("queued", "Follow up", "failed"),
            )))
            assertEquals("failed", failed.visibleQueuedMessages.single().status)
            coord.teardown()
        }
    }

    @Test fun failedSendNowRestoresQueueAndRefreshes() {
        val coord = coordinator(sendNow = true)
        controlsBody = """{"busy":true,"queuedMessages":[{"id":"queued","text":"Follow up","status":"queued"}]}"""
        coord.sendQueuedNow(listOf("queued"))
        await { coord.state.value.chat.lastTurnError != null }
        assertTrue(coord.state.value.hiddenQueuedSubmissionIds.isEmpty())
        await { coord.state.value.visibleQueuedMessages.size == 1 }
        assertEquals("queued", coord.state.value.visibleQueuedMessages.single().id)
    }

    @Test fun typedClarificationClearsImmediatelyAndLateAcknowledgementPreservesNewDraft() {
        for (success in listOf(true, false)) {
            val entered = java.util.concurrent.CountDownLatch(1)
            val release = java.util.concurrent.CountDownLatch(1)
            submissionReply = {
                entered.countDown()
                check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
                if (success) MockResponse().setBody("""{"submission":{"id":"accepted","text":"Use the annual totals","status":"queued"}}""")
                else MockResponse().setResponseCode(503).setBody("""{"error":"UNAVAILABLE","message":"Unavailable"}""")
            }
            val store = AgentComposerStore()
            val coord = coordinator(store)
            controlsBody = """{"busy":true,"pendingClarification":{"id":"period","question":"Which period?","choices":[{"label":"Quarter"},{"label":"Year"}]},"queuedMessages":[]}"""
            coord.conversationSurfaceVisible("session-one", true)
            await { coord.state.value.controls.pendingClarification != null }
            coord.updateDraft("Use the annual totals", null)
            coord.send("Use the annual totals")
            coord.finishDraftSubmission()
            assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
            assertEquals("", coord.state.value.composer.text)
            assertEquals("", store.read("", "session-one").text)
            val pending = coord.state.value.composer.pending.single()
            assertEquals("period", pending.clarificationId)
            coord.updateDraft("Next question", "deep-research")
            release.countDown()
            await { coord.state.value.submissionsSending.isEmpty() }
            assertEquals("Next question", coord.state.value.composer.text)
            assertEquals("deep-research", coord.state.value.composer.commandId)
            assertEquals(if (success) emptyList() else listOf(pending), coord.state.value.composer.pending)
            coord.teardown()
        }
    }

    @Test fun clarificationChoiceIncludesRequiredQueueModeAndAcknowledgesDelivery() {
        requireQueueMode = true
        reject = false
        controlsBody = """{"busy":false,"pendingClarification":{"id":"question-one","question":"Which category?","choices":[{"label":"Travel"},{"label":"Supplies"}]},"queuedMessages":[]}"""
        val coord = coordinator(busy = false)
        coord.conversationSurfaceVisible("session-one", true)
        await { coord.state.value.controls.pendingClarification != null }
        // Same coordinator entry point as tapping a native clarification choice.
        coord.submitFollowUp("Travel")
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        assertTrue(coord.state.value.composer.pending.isEmpty())
        assertNull(coord.state.value.chat.lastTurnError)
        val payload = OmnesisJson.parseToJsonElement(submissions.single()).jsonObject
        assertEquals("Travel", payload["text"]?.jsonPrimitive?.content)
        assertEquals("queue", payload["mode"]?.jsonPrimitive?.content)
        assertEquals("question-one", payload["clarificationId"]?.jsonPrimitive?.content)
    }

    @Test fun retryOfOlderSavedChoiceSendsSameIdWithQueueModeAndClearsReceipt() {
        requireQueueMode = true
        reject = false
        val saved = OmnesisJson.decodeFromString<dev.omnesis.android.transport.client.ConversationSubmissionBody>(
            """{"clientMessageId":"older-choice","text":"Travel","clarificationId":"question-one"}""",
        )
        val store = AgentComposerStore()
        store.write("", "session-one", ComposerRecord(text = "Another unsent question", pending = listOf(saved)))
        val coord = coordinator(store)
        coord.retrySubmission(saved.clientMessageId)
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        assertTrue(coord.state.value.composer.pending.isEmpty())
        assertEquals("Another unsent question", coord.state.value.composer.text)
        assertNull(coord.state.value.chat.lastTurnError)
        val payload = OmnesisJson.parseToJsonElement(submissions.single()).jsonObject
        assertEquals("older-choice", payload["clientMessageId"]?.jsonPrimitive?.content)
        assertEquals("queue", payload["mode"]?.jsonPrimitive?.content)
        assertEquals("question-one", payload["clarificationId"]?.jsonPrimitive?.content)
    }

    @Test fun retryClearsOnlyItsOwnConfirmedDeliveryWarning() {
        requireQueueMode = true
        val coord = coordinator()
        coord.submitFollowUp("Travel")
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        assertTrue(coord.state.value.chat.lastTurnError!!.startsWith("Message saved on this device"))
        val id = coord.state.value.composer.pending.single().clientMessageId
        reject = false
        coord.retrySubmission(id)
        await { submissions.size == 2 && coord.state.value.submissionsSending.isEmpty() }
        assertTrue(coord.state.value.composer.pending.isEmpty())
        assertNull(coord.state.value.chat.lastTurnError)
        assertEquals(submissions[0], submissions[1])
    }

    @Test fun confirmingOlderReceiptDoesNotClearNewerDeliveryFailure() {
        val coord = coordinator()
        coord.submitFollowUp("First choice")
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        val first = coord.state.value.composer.pending.single().clientMessageId
        coord.submitFollowUp("Second choice")
        await { submissions.size == 2 && coord.state.value.submissionsSending.isEmpty() }
        val newerWarning = coord.state.value.chat.lastTurnError
        reject = false
        coord.retrySubmission(first)
        await { submissions.size == 3 && coord.state.value.submissionsSending.isEmpty() }
        assertEquals(newerWarning, coord.state.value.chat.lastTurnError)
        assertEquals("Second choice", coord.state.value.composer.pending.single().text)
    }

    @Test fun automaticDrainConsumesExactReceiptsAtomicallyAndStaleControlsCannotResurrectThem() {
        val coord = coordinator(sendNow = true)
        val event = AgentEvent.UserMessage("session-one", "unrelated-message-id", "Follow up\n\nAnother queued message", listOf("queued", "second"))
        coord.applyEventForTesting(event)
        assertEquals(1, coord.state.value.chat.turns.filterIsInstance<AgentTurn.User>().size)
        assertTrue(coord.state.value.visibleQueuedMessages.isEmpty())
        controlsBody = """{"busy":true,"queuedMessages":[{"id":"queued","text":"Follow up","status":"queued"},{"id":"second","text":"Another queued message","status":"queued"},{"id":"new-receipt","text":"Follow up","status":"queued"}]}"""
        coord.conversationSurfaceVisible("session-one", true)
        await { coord.state.value.controls.queuedMessages.size == 3 }
        assertEquals(listOf("new-receipt"), coord.state.value.visibleQueuedMessages.map { it.id })
        coord.applyEventForTesting(event) // Replay does not duplicate the canonical user bubble.
        assertEquals(1, coord.state.value.chat.turns.filterIsInstance<AgentTurn.User>().size)
        val failed = coord.state.value.copy(controls = ConversationControls(queuedMessages = listOf(
            ConversationSubmission("queued", "Follow up", "failed"),
        )))
        assertEquals("failed", failed.visibleQueuedMessages.single().status)
        coord.newConversation()
        assertTrue(coord.state.value.deliveredSubmissionIds.isEmpty())
    }

    @Test fun legacyEventsDoNotGuessQueueIdentityFromMatchingText() {
        val coord = coordinator(sendNow = true)
        coord.applyEventForTesting(AgentEvent.UserMessage("other-session", "foreign", "Follow up", listOf("queued")))
        coord.applyEventForTesting(AgentEvent.UserMessage("session-one", "legacy-message", "Follow up"))
        assertEquals(listOf("queued"), coord.state.value.visibleQueuedMessages.map { it.id })
        assertTrue(coord.state.value.deliveredSubmissionIds.isEmpty())
    }

    @Test fun sendNowFailureCannotRestoreReceiptsAlreadyConfirmedByUserEvent() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        sendNowReply = {
            entered.countDown()
            check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
            MockResponse().setResponseCode(503)
        }
        controlsBody = """{"busy":true,"queuedMessages":[{"id":"queued","text":"Follow up","status":"queued"}]}"""
        val coord = coordinator(sendNow = true)
        coord.sendQueuedNow(listOf("queued"))
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        coord.applyEventForTesting(AgentEvent.UserMessage("session-one", "server-user", "Follow up", listOf("queued")))
        release.countDown()
        await { coord.state.value.chat.lastTurnError != null }
        assertTrue(coord.state.value.hiddenQueuedSubmissionIds.isEmpty())
        assertTrue(coord.state.value.visibleQueuedMessages.isEmpty())
        assertEquals(setOf("queued"), coord.state.value.deliveredSubmissionIds)
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

    @Test fun authoritativeQueueAcknowledgesUncertainReceiptWithoutDiscardingDraft() {
        val coord = coordinator()
        coord.updateDraft("Another unsent question", "deep-research")
        coord.submitFollowUp("Use annual totals")
        await { submissions.size == 1 && coord.state.value.submissionsSending.isEmpty() }
        val id = coord.state.value.composer.pending.single().clientMessageId
        controlsBody = """{"busy":true,"queuedMessages":[{"id":"$id","text":"Use annual totals","status":"queued"}]}"""
        coord.conversationSurfaceVisible("session-one", true)
        await { coord.state.value.composer.pending.isEmpty() }
        assertEquals("Another unsent question", coord.state.value.composer.text)
        assertEquals("deep-research", coord.state.value.composer.commandId)
        assertEquals(id, coord.state.value.controls.queuedMessages.single().id)
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

    @Test fun oldGatewayIsNotPolledForControlsEveryTwoSeconds() {
        oldGateway = true
        val coord = coordinator(supported = true)
        coord.conversationSurfaceVisible("session-one", true)
        await { !coord.state.value.controlsAvailable }
        Thread.sleep(AgentCoordinator.CONTROLS_POLL_MS * 2 + 500)
        assertEquals(1, controlsRequests.get())
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
