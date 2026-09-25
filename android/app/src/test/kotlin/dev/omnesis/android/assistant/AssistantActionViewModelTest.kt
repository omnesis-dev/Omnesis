// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.Context
import android.content.Intent
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.PendingNotesStore
import dev.omnesis.android.transport.client.AgentSessionProfile
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.SendMessageResponse
import dev.omnesis.android.ui.capture.SpeechTranscriber
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AssistantActionViewModelTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun invalid_new_delivery_cannot_be_overwritten_by_the_previous_answer() {
        val releaseAnswer = CompletableDeferred<Unit>()
        val vm = viewModel(FakeGateway(releaseAnswer))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK)
                .putExtra(AssistantActionActivity.EXTRA_QUESTION, "What is next?"),
            freshDelivery = true,
            trustedDelivery = true,
        )
        assertTrueWorking(vm.state.value)

        vm.handle(Intent("example.invalid.ACTION"), freshDelivery = true)
        val rejected = AssistantActionUiState.Finished(
            "Couldn't start",
            "That Omnesis action isn't supported.",
            successful = false,
        )
        assertEquals(rejected, vm.state.value)

        releaseAnswer.complete(Unit)
        assertEquals(rejected, vm.state.value)
    }

    @Test
    fun process_death_restoration_is_terminal_instead_of_opening_the_microphone() {
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            SavedStateHandle(mapOf("assistant_action_handled" to true)),
        )

        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = false)

        assertEquals(
            AssistantActionUiState.Finished(
                "Omnesis",
                "This action was already handled. Start it again to run a new request.",
                successful = false,
            ),
            vm.state.value,
        )
    }

    @Test
    fun stale_permission_result_cannot_overwrite_a_direct_text_request() {
        val vm = viewModel(FakeGateway(CompletableDeferred()))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK)
                .putExtra(AssistantActionActivity.EXTRA_QUESTION, "What is next?"),
            freshDelivery = true,
            trustedDelivery = true,
        )
        val working = vm.state.value

        vm.microphoneDenied()
        vm.startListening()

        assertEquals(working, vm.state.value)
    }

    @Test
    fun untrusted_parameterized_delivery_waits_for_explicit_confirmation() {
        val vm = viewModel(FakeGateway(CompletableDeferred()))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK)
                .putExtra(AssistantActionActivity.EXTRA_QUESTION, "What is next?"),
            freshDelivery = true,
            trustedDelivery = false,
        )

        assertEquals(
            AssistantActionUiState.Confirming(AssistantActionKind.ASK, "What is next?"),
            vm.state.value,
        )
        vm.confirm()
        assertTrueWorking(vm.state.value)
    }

    @Test
    fun untrusted_missing_text_delivery_requires_a_tap_before_listening() {
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(FakeGateway(CompletableDeferred()), transcriber = transcriber)
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true)

        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK),
            vm.state.value,
        )
        vm.startListening()
        assertEquals(0, transcriber.startCount)
        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK),
            vm.state.value,
        )

        vm.confirm()
        assertEquals(true, vm.state.value is AssistantActionUiState.Listening)
        vm.startListening()
        assertEquals(1, transcriber.startCount)
    }

    @Test
    fun stale_recognizer_callbacks_cannot_cross_an_untrusted_delivery_boundary() {
        val gateway = FakeGateway(CompletableDeferred())
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(gateway, transcriber = transcriber)
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        vm.startListening()
        val stale = transcriber.listeners.single()

        vm.handle(Intent(AssistantActionActivity.ACTION_CAPTURE), freshDelivery = true)
        stale.onPartial("Stale private speech")
        stale.onFinal("Stale private speech")
        stale.onEnded(SpeechTranscriber.EndReason.NORMAL)

        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.CAPTURE),
            vm.state.value,
        )
        assertEquals(1, transcriber.startCount)
        assertEquals(0, gateway.sendCount)
    }

    @Test
    fun losing_foreground_cancels_listening_and_late_silence_cannot_restart_it() {
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
        )
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        vm.startListening()
        val stale = transcriber.listeners.single()

        vm.stopListening()
        stale.onEnded(SpeechTranscriber.EndReason.NORMAL)

        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK),
            vm.state.value,
        )
        assertEquals(1, transcriber.startCount)
        assertEquals(true, transcriber.cancelCount > 0)
    }

    @Test
    fun permission_dialog_state_survives_pause_and_routes_grant_or_denial() {
        val granted = viewModel(FakeGateway(CompletableDeferred()))
        granted.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        granted.awaitMicrophonePermission()
        granted.stopListening()
        assertEquals(
            AssistantActionUiState.AwaitingMicrophonePermission(AssistantActionKind.ASK, 1),
            granted.state.value,
        )
        granted.microphonePermissionGranted()
        assertEquals(true, granted.state.value is AssistantActionUiState.Listening)

        val denied = viewModel(FakeGateway(CompletableDeferred()))
        denied.handle(
            Intent(AssistantActionActivity.ACTION_CAPTURE),
            freshDelivery = true,
            trustedDelivery = true,
        )
        denied.awaitMicrophonePermission()
        denied.microphoneDenied()
        assertEquals(
            AssistantActionUiState.Finished(
                "Microphone is off",
                "Allow microphone access to use hands-free Omnesis actions.",
                successful = false,
            ),
            denied.state.value,
        )
    }

    @Test
    fun repeated_trusted_missing_text_deliveries_have_distinct_listening_identity() {
        val vm = viewModel(FakeGateway(CompletableDeferred()))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        val first = vm.state.value as AssistantActionUiState.Listening

        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        val second = vm.state.value as AssistantActionUiState.Listening

        assertEquals(true, second.deliveryId > first.deliveryId)
    }

    @Test
    fun unpaired_capture_copy_requires_pairing_instead_of_promising_reachability_retry() {
        assertEquals(
            "Saved on this phone. Pair Omnesis with your gateway to sync it.",
            queuedCaptureMessage(dev.omnesis.android.notes.QueueReason.UNPAIRED),
        )
    }

    private fun viewModel(
        gateway: VoiceAskGateway,
        state: SavedStateHandle = SavedStateHandle(),
        transcriber: SpeechTranscriber = object : SpeechTranscriber(context) {
            override fun cancel() = Unit
        },
    ): AssistantActionViewModel = AssistantActionViewModel(
        askRunner = VoiceAskRunner({ gateway }, object : VoiceAskContinuity {
            override fun conversationToResume(): String? = null
            override fun record(conversationId: String) = Unit
        }) { 0L },
        notes = NotesRepository(PendingNotesStore(context), gateway = { null }),
        transcriber = transcriber,
        savedState = state,
    )

    private fun assertTrueWorking(state: AssistantActionUiState) {
        assertEquals(true, state is AssistantActionUiState.Working)
    }

    private class FakeGateway(
        private val releaseAnswer: CompletableDeferred<Unit>,
    ) : VoiceAskGateway {
        var sendCount = 0

        override suspend fun createSession(
            resumeFromId: String?,
            transcriptLimit: Int?,
            profile: AgentSessionProfile,
        ) = CreateSessionResponse(sessionId = "session-a")

        override suspend fun sendMessage(
            sessionId: String,
            text: String,
            notifyAfterMs: Int,
            viewingForMs: Int,
        ): SendMessageResponse {
            sendCount++
            return SendMessageResponse(messageId = "message-a")
        }

        override fun events(lastEventId: String?, onOpen: () -> Unit): Flow<AgentStreamItem> = flow {
            onOpen()
            releaseAnswer.await()
            emit(AgentStreamItem("1", AgentEvent.MessageEnd("session-a", "message-a")))
        }
    }

    private class FakeTranscriber(context: Context) : SpeechTranscriber(context) {
        var startCount = 0
        var cancelCount = 0
        val listeners = mutableListOf<Listener>()

        override fun isAvailable() = true

        override fun start(listener: Listener) {
            startCount++
            listeners += listener
        }

        override fun cancel() {
            cancelCount++
        }
    }
}
